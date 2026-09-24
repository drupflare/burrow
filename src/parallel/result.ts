import { fromBytes, makeResult, type RunResult } from '../session.js';

/** How a lane encoded its answer; decides which accessor is meaningful. */
export type ResultKind = 'number' | 'bytes' | 'text' | 'json' | 'run';

/** @internal the descriptor a lane answers with, ahead of the payload */
export interface ResultDesc {
	ok: true;
	kind: ResultKind;
	number?: number;
	exitCode?: number;
	stderr?: number[];
	effects?: unknown[];
	iso: string;
	tags: Record<string, unknown>;
}

/**
 * One slice's answer.
 *
 * The raw bytes are always present; the accessors decode them so a caller never builds a
 * `TextDecoder`. Runtime slices also carry the full {@link RunResult}.
 *
 * @since 1.1.0
 */
export interface LaneResult {
	/** the slice's position in the job's inputs */
	readonly sliceId: number;
	/** the lane id that produced the accepted answer */
	readonly lane: string;
	/** how many executions the slice took, hedges and retries included */
	readonly attempts: number;
	readonly kind: ResultKind;
	/** the raw answer: the guest's bytes, the task's encoded return, or a runtime's stdout */
	readonly bytes: Uint8Array;
	/** effects the slice captured with `ctx.effect()`, handed to the pool's `commit` exactly once */
	readonly effects: readonly unknown[];
	/** the runtime's result for a runtime slice, otherwise `null` */
	readonly run: RunResult | null;
	/** the answer as a number: a guest's i32, or a task's numeric return */
	number(): number;
	/** the bytes decoded as UTF-8 */
	text(): string;
	/**
	 * The bytes parsed as JSON.
	 *
	 * @throws {SyntaxError} when they are not JSON
	 */
	json<T = unknown>(): T;
}

/** @internal builds the caller-side result from what a lane sent back */
export function makeLaneResult(
	desc: ResultDesc,
	payload: Uint8Array,
	meta: { sliceId: number; lane: string; attempts: number }
): LaneResult {
	const bytes = payload.slice();
	const run =
		desc.kind === 'run'
			? makeResult(desc.exitCode ?? 0, Array.from(bytes), desc.stderr ?? [])
			: null;
	return {
		...meta,
		kind: desc.kind,
		bytes,
		effects: desc.effects ?? [],
		run,
		number: () => (desc.kind === 'number' ? (desc.number ?? 0) : Number(fromBytes(bytes))),
		text: () => fromBytes(bytes),
		json: <T>() => JSON.parse(fromBytes(bytes)) as T
	};
}

/**
 * A slice running on the pool, shaped like a thread handle.
 *
 * It is a real thenable, so `await pool.spawn(...)` works and `Promise.all`, `allSettled`, `any` and
 * `race` compose tasks unchanged; {@link LaneTask.join} is the explicit form.
 *
 * @since 1.1.0
 */
export class LaneTask implements PromiseLike<LaneResult> {
	/** @internal */
	constructor(
		/** the slice id inside the task's job */
		readonly sliceId: number,
		private readonly result: Promise<LaneResult>
	) {
		// a task nobody awaits must not surface as an unhandled rejection; join() still rejects
		result.catch(() => {});
	}

	/** waits for the slice and answers its result */
	join(): Promise<LaneResult> {
		return this.result;
	}

	then<A = LaneResult, B = never>(
		onfulfilled?: ((value: LaneResult) => A | PromiseLike<A>) | null,
		onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
	): Promise<A | B> {
		return this.result.then(onfulfilled, onrejected);
	}

	catch<B = never>(
		onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
	): Promise<LaneResult | B> {
		return this.result.catch(onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<LaneResult> {
		return this.result.finally(onfinally);
	}
}
