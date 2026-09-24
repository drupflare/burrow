/**
 * Every error this package throws on a public path, each carrying a stable dotted {@link code}.
 *
 * A caller matches on `code`, never on a message string. Messages are for humans and may change
 * within a major version; codes may not.
 *
 * @since 1.0.0
 */
export abstract class BurrowError extends Error {
	/** stable, dotted, and safe to branch on */
	abstract readonly code: string;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** A runtime could not be loaded, instantiated, or did not satisfy the contract. */
export class RuntimeError extends BurrowError {
	readonly code:
		| 'burrow.runtime.load_failed'
		| 'burrow.runtime.instantiate_failed'
		| 'burrow.runtime.contract_violation'
		| 'burrow.runtime.duplicate_name';

	constructor(message: string, code: RuntimeError['code'], options?: { cause?: unknown }) {
		super(message, options);
		this.code = code;
	}
}

/** No runtime is registered under the requested name. */
export class UnknownRuntimeError extends BurrowError {
	readonly code = 'burrow.registry.unknown_runtime' as const;
	/** the name that was asked for */
	readonly requested: string;
	/** every name that is registered, so a typo is obvious from the error alone */
	readonly available: readonly string[];

	constructor(requested: string, available: readonly string[]) {
		super(
			`no runtime named ${JSON.stringify(requested)} is registered` +
				(available.length
					? `; available: ${available.join(', ')}`
					: '; none are registered')
		);
		this.requested = requested;
		this.available = [...available];
	}
}

/**
 * Booting a runtime would exceed the isolate's memory budget.
 *
 * Thrown rather than letting the isolate OOM, because an OOM takes down the whole Durable Object
 * while this loses one request.
 */
export class BudgetError extends BurrowError {
	readonly code = 'burrow.budget.exceeded' as const;
	/** the runtime that could not be admitted */
	readonly runtime: string;
	/** what it declared it needs, in bytes */
	readonly required: number;
	/** what was free after evicting everything evictable, in bytes */
	readonly free: number;

	constructor(runtime: string, required: number, free: number) {
		super(
			`booting ${runtime} needs ${required} bytes but only ${free} are free; ` +
				`everything else resident is leased and cannot be evicted`
		);
		this.runtime = runtime;
		this.required = required;
		this.free = free;
	}
}

/** The interpreter could not start, load a guest, link an import, or the guest trapped. */
export class InterpretError extends BurrowError {
	readonly code:
		| 'burrow.interpret.init_failed'
		| 'burrow.interpret.load_failed'
		| 'burrow.interpret.link_failed'
		| 'burrow.interpret.unsupported'
		| 'burrow.interpret.trap';

	constructor(message: string, code: InterpretError['code'], options?: { cause?: unknown }) {
		super(message, options);
		this.code = code;
	}
}

/**
 * A dynamic library could not be read, placed or linked.
 *
 * `unresolved` carries the symbols nothing supplied, which is the failure that actually happens: a
 * side module names the libc it was compiled against and the host has to answer for every one.
 */
export class DylinkError extends BurrowError {
	readonly code:
		| 'burrow.dylink.not_a_library'
		| 'burrow.dylink.malformed'
		| 'burrow.dylink.unresolved'
		| 'burrow.dylink.no_space'
		| 'burrow.dylink.link_failed'
		| 'burrow.dylink.in_use'
		| 'burrow.dylink.host_access_denied';
	/** the symbols nothing resolved, empty unless `code` is `burrow.dylink.unresolved` */
	readonly unresolved: readonly string[];

	constructor(
		message: string,
		code: DylinkError['code'],
		options?: { cause?: unknown; unresolved?: readonly string[] }
	) {
		super(message, options);
		this.code = code;
		this.unresolved = options?.unresolved ? [...options.unresolved] : [];
	}
}

/**
 * Uploading a Worker version failed.
 *
 * `status` is the HTTP status when the API answered at all, and `errors` carries Cloudflare's own
 * error list, which names the cause far better than a status does.
 */
export class PublishError extends BurrowError {
	readonly code:
		'burrow.publish.rejected' | 'burrow.publish.unreachable' | 'burrow.publish.no_preview';
	/** the HTTP status, or 0 when the request never completed */
	readonly status: number;
	/** Cloudflare's `errors` array, flattened to messages */
	readonly errors: readonly string[];

	constructor(
		message: string,
		code: PublishError['code'],
		options?: { cause?: unknown; status?: number; errors?: readonly string[] }
	) {
		super(message, options);
		this.code = code;
		this.status = options?.status ?? 0;
		this.errors = options?.errors ? [...options.errors] : [];
	}
}

/**
 * A parallel job could not run, or part of it failed.
 *
 * `slices` names the slices that failed, so a caller can tell a whole-job refusal from one bad
 * slice; `causes` carries each failed slice's own error message.
 *
 * @since 1.1.0
 */
export class ParallelError extends BurrowError {
	readonly code:
		| 'burrow.parallel.slice_failed'
		| 'burrow.parallel.job_failed'
		| 'burrow.parallel.build_incomplete'
		| 'burrow.parallel.stale_state'
		| 'burrow.parallel.impure'
		| 'burrow.parallel.unknown_task'
		| 'burrow.parallel.sticky_failed'
		| 'burrow.parallel.frame_malformed'
		| 'burrow.parallel.cancelled'
		| 'burrow.parallel.stalled'
		| 'burrow.parallel.no_lanes'
		| 'burrow.parallel.lock_lost'
		| 'burrow.parallel.lock_timeout'
		| 'burrow.parallel.channel_closed'
		| 'burrow.parallel.object_failed'
		| 'burrow.parallel.commit_failed';
	/** the slice ids that failed, empty when the job failed as a whole */
	readonly slices: readonly number[];
	/** one message per failed slice, in the same order as {@link ParallelError.slices} */
	readonly causes: readonly string[];
	/**
	 * For `burrow.parallel.commit_failed`, the slices whose effects were committed before the
	 * failing one, so a caller can recover from exactly where the job stopped; empty otherwise.
	 */
	readonly committed: readonly number[];

	constructor(
		message: string,
		code: ParallelError['code'],
		options?: {
			cause?: unknown;
			slices?: readonly number[];
			causes?: readonly string[];
			committed?: readonly number[];
		}
	) {
		super(message, options);
		this.code = code;
		this.slices = options?.slices ? [...options.slices] : [];
		this.causes = options?.causes ? [...options.causes] : [];
		this.committed = options?.committed ? [...options.committed] : [];
	}
}

/** A lease was used after it was released. */
export class LeaseError extends BurrowError {
	readonly code = 'burrow.lease.released' as const;

	constructor(runtime: string) {
		super(`the lease on ${runtime} has been released and cannot be used again`);
	}
}
