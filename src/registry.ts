import { lines, observedMemory } from './adapt.js';
import { Budget, type BudgetOptions } from './budget.js';
import { LeaseError, RuntimeError, UnknownRuntimeError } from './errors.js';
import type { AnyRuntimeSpec, Interpreter, RuntimeIo } from './runtime.js';
import { Session, type SessionOptions } from './session.js';

/** what a spec is charged when it declares no `memory`; corrected from observation after boot */
const ASSUMED_BYTES = 16 * 1024 * 1024;

/**
 * A claim on a resident runtime.
 *
 * Holding a lease guarantees the runtime will not be evicted. Release it - or let `await using` do
 * it - to make the runtime evictable again.
 *
 * @since 1.0.0
 */
export interface Lease extends AsyncDisposable {
	/** the runtime this lease is on */
	readonly name: string;
	/**
	 * The callback a host calls to get the interpreter, shaped exactly as
	 * `@drupflare/cartridge`'s `CartridgeOptions.instantiate`.
	 *
	 * Boots once per resident and is reused by later leases.
	 */
	readonly instantiate: (io: RuntimeIo) => Promise<Interpreter>;
	/** the booted interpreter, or `null` before {@link Lease.instantiate} has been called */
	readonly interpreter: Interpreter | null;
	/** releases the lease; idempotent */
	release(): void;
}

export interface BurrowOptions {
	/** the runtimes this registry can acquire */
	runtimes: readonly AnyRuntimeSpec[];
	/** memory accounting; pass a {@link Budget} to share one across registries */
	budget?: BudgetOptions | Budget;
}

interface Resident {
	// the spec's type parameter is erased here on purpose: the registry never inspects `loaded`
	spec: AnyRuntimeSpec;
	loaded: unknown;
	interpreter: Interpreter | null;
	booting: Promise<Interpreter> | null;
}

/**
 * Acquires runtimes, keeps them resident, and accounts their memory against the isolate.
 *
 * burrow ships no runtime. The consumer declares them with `defineRuntime` and hands them here.
 *
 * @example
 * ```ts
 * const burrow = new Burrow({ runtimes: [php, lua] });
 *
 * await using lease = await burrow.acquire('php');
 * const cart = createCartridge({ instantiate: lease.instantiate, ctx });
 * ```
 *
 * @since 1.0.0
 */
export class Burrow {
	readonly budget: Budget;
	private readonly specs = new Map<string, AnyRuntimeSpec>();
	private readonly residents = new Map<string, Resident>();

	constructor(options: BurrowOptions) {
		for (const spec of options.runtimes) {
			if (this.specs.has(spec.name)) {
				throw new RuntimeError(
					`two runtimes are registered as ${JSON.stringify(spec.name)}`,
					'burrow.runtime.duplicate_name'
				);
			}
			this.specs.set(spec.name, spec);
		}
		this.budget =
			options.budget instanceof Budget ? options.budget : new Budget(options.budget);
		// always subscribed, including to a Budget shared with another registry: an eviction nobody
		// told us about leaves a dead instance resident while the accounting says its bytes are free
		this.budget.onEviction((name) => this.residents.delete(name));
	}

	/** every registered name */
	names(): string[] {
		return [...this.specs.keys()];
	}

	has(name: string): boolean {
		return this.specs.has(name);
	}

	/** whether a runtime is booted and resident right now */
	isResident(name: string): boolean {
		return this.residents.has(name);
	}

	/**
	 * Imports a runtime's module without booting it, or answers `null` when the name is unknown.
	 *
	 * This is the cheap half: on Cloudflare a bundled wasm module materialises in about a
	 * millisecond because the platform compiled it at upload.
	 */
	async tryImport(name: string): Promise<unknown | null> {
		const spec = this.specs.get(name);
		if (!spec) return null;
		return await this.loadOf(spec);
	}

	/**
	 * Takes a lease on a runtime, admitting it to the budget and evicting unleased residents if
	 * that is what it takes to fit.
	 *
	 * @throws {UnknownRuntimeError} when no runtime is registered under `name`
	 * @throws {BudgetError} when it cannot fit because everything resident is leased
	 */
	async acquire(name: string): Promise<Lease> {
		const spec = this.specs.get(name);
		if (!spec) throw new UnknownRuntimeError(name, this.names());

		this.budget.admit(
			name,
			this.budget.bytesOf(name) ?? spec.memory?.peak ?? spec.memory?.initial ?? ASSUMED_BYTES
		);
		this.budget.lease(name);

		let released = false;
		const self = this;

		const release = () => {
			if (released) return;
			released = true;
			self.budget.release(name);
		};

		const lease: Lease = {
			name,
			get interpreter() {
				return self.residents.get(name)?.interpreter ?? null;
			},
			instantiate: async (io: RuntimeIo) => {
				if (released) throw new LeaseError(name);
				return await self.boot(spec, io);
			},
			release,
			[Symbol.asyncDispose]: async () => release()
		};
		return lease;
	}

	/**
	 * Takes a lease and wraps it in a {@link Session}, which keeps interpreter state between
	 * evaluations - the REPL and CLI shape.
	 *
	 * The session holds its lease for its whole lifetime, which is exactly what makes the state
	 * persist: the interpreter it booted cannot be evicted mid-conversation.
	 *
	 * @example
	 * ```ts
	 * await using sh = await burrow.session('php');
	 * await sh.evalText('<?php $x = 1;');
	 * const two = await sh.evalText('<?php echo $x + 1;');
	 * ```
	 */
	async session(name: string, options?: SessionOptions): Promise<Session> {
		const lease = await this.acquire(name);
		return new Session(
			{ instantiate: lease.instantiate, release: () => lease.release() },
			options
		);
	}

	/** drops every resident and forgets its budget entry; leases already taken become unusable */
	dispose(): void {
		for (const name of [...this.residents.keys()]) {
			this.residents.delete(name);
			this.budget.forget(name);
		}
	}

	private async loadOf(spec: AnyRuntimeSpec): Promise<unknown> {
		const existing = this.residents.get(spec.name);
		if (existing) return existing.loaded;
		let loaded: unknown;
		try {
			loaded = await spec.load();
		} catch (cause) {
			throw new RuntimeError(
				`loading runtime ${spec.name} failed`,
				'burrow.runtime.load_failed',
				{ cause }
			);
		}
		this.residents.set(spec.name, { spec, loaded, interpreter: null, booting: null });
		return loaded;
	}

	private async boot(spec: AnyRuntimeSpec, io: RuntimeIo): Promise<Interpreter> {
		await this.loadOf(spec);
		const resident = this.residents.get(spec.name);
		// loadOf just set it; this narrows for the type checker rather than guarding a real case
		if (!resident)
			throw new RuntimeError(
				`runtime ${spec.name} vanished while booting`,
				'burrow.runtime.instantiate_failed'
			);
		if (resident.interpreter) return resident.interpreter;
		if (resident.booting) return await resident.booting;

		const booting = (async () => {
			let made: Interpreter;
			try {
				made = await spec.instantiate({ loaded: resident.loaded, io, lines });
			} catch (cause) {
				throw new RuntimeError(
					`instantiating runtime ${spec.name} failed`,
					'burrow.runtime.instantiate_failed',
					{ cause }
				);
			}
			const problem = contractProblem(made);
			if (problem) {
				throw new RuntimeError(
					`runtime ${spec.name} did not satisfy the interpreter contract: ${problem}`,
					'burrow.runtime.contract_violation'
				);
			}
			resident.interpreter = made;
			const seen = observedMemory(made);
			if (seen !== null) this.budget.record(spec.name, seen);
			return made;
		})();

		resident.booting = booting;
		// cleared AFTER the assignment, not inside the body: clearing from within runs before the
		// assignment lands and the rejected promise then overwrites the null, which made one bad boot
		// permanent for the life of the isolate
		booting.catch(() => {
			if (resident.booting === booting) resident.booting = null;
		});
		return await booting;
	}
}

/** @internal exported for the gate, which drives it without booting a real runtime */
export function contractProblem(value: unknown): string | null {
	const i = value as Partial<Interpreter> | null | undefined;
	if (!i || typeof i !== 'object') return 'instantiate() did not answer an object';
	if (typeof i.callMain !== 'function') return 'no callMain()';
	if (!i.FS || typeof i.FS !== 'object') return 'no FS';
	if (typeof i.FS.writeFile !== 'function') return 'FS has no writeFile()';
	return null;
}
