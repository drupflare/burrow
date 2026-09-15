import { BudgetError } from './errors.js';

/** workerd's per-isolate memory ceiling */
export const ISOLATE_LIMIT = 128 * 1024 * 1024;

/** what is held back for the JavaScript heap, the bundle's own structures and headroom */
export const DEFAULT_RESERVE = 16 * 1024 * 1024;

export interface BudgetOptions {
	/** total isolate memory to account against; defaults to {@link ISOLATE_LIMIT} */
	limit?: number;
	/** held back from `limit` for everything that is not guest linear memory */
	reserve?: number;
	/** called when an entry is evicted, so the owner can drop its cached instance */
	onEvict?: (name: string) => void;
}

interface Entry {
	bytes: number;
	leases: number;
	used: number;
}

/**
 * Accounts guest linear memory against the isolate ceiling and decides what may boot.
 *
 * The failure this exists to prevent is an isolate OOM, which takes down the whole Durable Object
 * rather than one request. A refused boot throws {@link BudgetError} naming the runtime, what it
 * needs and what is free.
 *
 * **A leased runtime is never evicted.** The lease is the interlock: eviction is only safe between
 * runs, and a lease is exactly the statement that a run may be in progress.
 *
 * @since 1.0.0
 */
export class Budget {
	readonly limit: number;
	readonly reserve: number;
	private readonly listeners = new Set<(name: string) => void>();
	private readonly entries = new Map<string, Entry>();
	private clock = 0;

	constructor(options: BudgetOptions = {}) {
		this.limit = options.limit ?? ISOLATE_LIMIT;
		this.reserve = options.reserve ?? DEFAULT_RESERVE;
		if (options.onEvict) this.listeners.add(options.onEvict);
	}

	/**
	 * Registers an eviction listener and answers a function that removes it.
	 *
	 * A set rather than a single callback because one Budget can be shared across registries, and a
	 * registry that is not told about an eviction keeps a dead instance alive - which is worse than
	 * not budgeting at all, since the memory stays held while the accounting says it is free.
	 */
	onEviction(listener: (name: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** memory available to guests, after the reserve */
	get capacity(): number {
		return Math.max(0, this.limit - this.reserve);
	}

	/** bytes currently attributed to resident runtimes */
	get used(): number {
		let total = 0;
		for (const e of this.entries.values()) total += e.bytes;
		return total;
	}

	get free(): number {
		return this.capacity - this.used;
	}

	/** every resident name, least recently used first */
	residents(): string[] {
		return [...this.entries.entries()].sort((a, b) => a[1].used - b[1].used).map(([n]) => n);
	}

	/** whether a name is resident */
	has(name: string): boolean {
		return this.entries.has(name);
	}

	/** bytes attributed to a resident, or `null` when it is not resident */
	bytesOf(name: string): number | null {
		return this.entries.get(name)?.bytes ?? null;
	}

	/**
	 * Admits a runtime, evicting least-recently-used unleased residents until it fits.
	 *
	 * @throws {BudgetError} when it still does not fit because everything else is leased
	 */
	admit(name: string, required: number): void {
		const existing = this.entries.get(name);
		if (existing) {
			existing.used = ++this.clock;
			return;
		}
		if (required > this.capacity) {
			throw new BudgetError(name, required, this.capacity);
		}
		while (this.free < required) {
			const victim = this.pickVictim();
			if (victim === null) throw new BudgetError(name, required, this.free);
			this.entries.delete(victim);
			for (const listener of this.listeners) listener(victim);
		}
		this.entries.set(name, { bytes: required, leases: 0, used: ++this.clock });
	}

	/**
	 * Replaces a resident's attributed size with an observed one.
	 *
	 * A spec's declared `memory` is a claim; this is what the instance actually took. Correcting
	 * upward can push `used` past `capacity`, which is reported honestly rather than clamped - the
	 * next admission then evicts or refuses.
	 */
	record(name: string, bytes: number): void {
		const e = this.entries.get(name);
		if (e) e.bytes = bytes;
	}

	/** marks a resident as in use, so it cannot be evicted */
	lease(name: string): void {
		const e = this.entries.get(name);
		if (!e) return;
		e.leases++;
		e.used = ++this.clock;
	}

	/** releases one lease; the resident becomes evictable when the count reaches zero */
	release(name: string): void {
		const e = this.entries.get(name);
		if (!e) return;
		e.leases = Math.max(0, e.leases - 1);
		e.used = ++this.clock;
	}

	/** how many leases are open on a resident */
	leasesOn(name: string): number {
		return this.entries.get(name)?.leases ?? 0;
	}

	/** drops a resident outright, whether or not it is leased */
	forget(name: string): void {
		this.entries.delete(name);
	}

	/** least-recently-used unleased resident, or `null` when every resident is leased */
	private pickVictim(): string | null {
		let victim: string | null = null;
		let oldest = Infinity;
		for (const [name, e] of this.entries) {
			if (e.leases > 0) continue;
			if (e.used < oldest) {
				oldest = e.used;
				victim = name;
			}
		}
		return victim;
	}
}
