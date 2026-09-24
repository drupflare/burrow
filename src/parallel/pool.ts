import { ParallelError } from '../errors.js';
import { toBytes } from '../session.js';
import { LaneChannel } from './channel.js';
import { decodeFrame, encodeFrame, readRecords } from './frame.js';
import type { FailureDesc, SliceDesc, StateTags } from './lane.js';
import { LaneTask, makeLaneResult, type LaneResult, type ResultDesc } from './result.js';
import { laneTransport, runJob, stickyIndex, type JobDesc, type JobStats } from './scheduler.js';
import { LaneAtomic, LaneMutex } from './sync.js';

interface WorkCommon {
	/** tags a lane must hold to run the slice, such as `{ generation: 42 }` */
	requires?: StateTags;
	/** collect `ctx.effect()` calls instead of applying them; the pool's `commit` applies them once */
	effects?: 'capture';
}

/** Arbitrary wasm, interpreted on the lane. */
export interface GuestWork extends WorkCommon {
	guest: Uint8Array;
	/** the export to call; with an input it is called as `fn(ptr, len, ...args)` */
	fn: string;
	args?: number[];
	/** `bytes` reads a result the guest returns as a pointer to a `u32` length followed by the bytes */
	result?: 'number' | 'bytes';
	/** the guest may use the lane's host imports; say so only if running it twice is safe */
	idempotent?: boolean;
	input?: Uint8Array | string;
}

/** A named task from the lane class, run at native speed. */
export interface TaskWork extends WorkCommon {
	task: string;
	input?: Uint8Array | string;
	/** channels the task reaches as `ctx.channel(alias)` */
	channels?: Record<string, LaneChannel>;
}

/** Source evaluated by a runtime the lane class declares. */
export interface RuntimeWork extends WorkCommon {
	runtime: string;
	/** the source to evaluate; when omitted, each input is the source */
	source?: string;
	files?: Record<string, string>;
	/** keep a session warm on one lane for this key; sticky slices are never hedged or moved */
	affinity?: string;
	input?: string;
}

/**
 * One unit of work for a lane.
 *
 * @since 1.1.0
 */
export type Work = GuestWork | TaskWork | RuntimeWork;

/**
 * Options for a {@link LanePool}.
 *
 * @since 1.1.0
 */
export interface LanePoolOptions {
	/** names the pool's lane ids, so two pools on one namespace do not share lanes; defaults to `burrow` */
	name?: string;
	/** how many lanes; defaults to 8 */
	size?: number;
	/** lanes held back for hedges and retries; defaults to a quarter of `size`, at least 2 */
	spares?: number;
	/** the namespace's binding name, which a coordinator object uses to reach the lanes */
	binding?: string;
	/**
	 * Hand each job to a coordinator object rather than scheduling it in the caller. On by default:
	 * on the free plan a Worker was measured refused at 10 ms of CPU once its burst was spent, while
	 * an object was not refused.
	 */
	coordinator?: boolean;
	/** how many coordinator objects to spread jobs across; defaults to 4 */
	coordinators?: number;
	/** `pull` lets idle lanes take the next slice; measured faster than `static` at 16 lanes */
	schedule?: 'pull' | 'static';
	/** duplicate a slice that runs past three times the median onto a spare; defaults to true */
	hedge?: boolean;
	/** attempts per slice, the first included; defaults to 3 */
	maxAttempts?: number;
	/** a lane call with no answer after this long counts as failed; defaults to 30 s */
	stallMs?: number;
	/** the shortest deadline a hedge waits for; defaults to 250 ms */
	hedgeFloorMs?: number;
	/**
	 * Applies a slice's captured effects, called exactly once per accepted slice. Answer the number
	 * of rows written to have them counted in `stats.rowsWritten`. If it throws, the job stops and
	 * rejects with `burrow.parallel.commit_failed`, whose `committed` lists what was applied.
	 */
	commit?: (effects: readonly unknown[], ids: { jobId: string; sliceId: number }) => unknown;
}

/** Per-call options. */
export interface RunOptions {
	signal?: AbortSignal;
	/** splits a single `input` into chunks; defaults to equal byte ranges */
	split?: (data: Uint8Array, n: number) => Uint8Array[];
}

/** What {@link LanePool.build} calls around the job. */
export interface BuildSteps {
	/** writes one accepted, validated result into the unpublished output */
	stage: (result: LaneResult, ids: { jobId: string; sliceId: number }) => unknown;
	/** a caller-side gate before staging; a false answer withholds the publish */
	validate?: (result: LaneResult) => boolean | Promise<boolean>;
	/**
	 * Makes the whole output visible at once; called once, and only if every slice staged. Deleting
	 * the old generation here is billed as rows written, so prefer overwriting a second slot.
	 */
	publish: () => unknown;
}

/**
 * What {@link LanePool.health} saw.
 *
 * @since 1.1.0
 */
export interface PoolHealth {
	lanes: Array<{ lane: string; isolate: string; tags: StateTags }>;
	/** distinct isolates across the lanes; fewer than `lanes.length` means some share one */
	isolates: number;
	/** lane ids that share an isolate; each group serialises, and two heavy runtimes cannot fit one */
	coResident: string[][];
}

// per-isolate memo of repaired lane ids, so every job from this isolate uses the repaired pool
const memo = new Map<string, { lanes: string[]; next: number }>();

function equalSplit(data: Uint8Array, n: number): Uint8Array[] {
	const parts: Uint8Array[] = [];
	for (let i = 0; i < n; i++)
		parts.push(
			data.subarray(
				Math.floor((i * data.length) / n),
				Math.floor(((i + 1) * data.length) / n)
			)
		);
	return parts.filter((p) => p.length > 0);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/**
 * A pool of lanes: one job's slices spread across Durable Objects of one class, each on its own
 * execution context.
 *
 * Measured on a deployed Worker: one job split 16 ways ran 6.46x faster, and 8 lanes held 768 MiB
 * for one job where a single isolate refuses 192 MiB. Lanes share no memory; slices exchange bytes.
 *
 * @example
 * ```ts
 * const pool = new LanePool(env.BURROW_LANES, { size: 16 });
 * const sums = await pool.map({ guest: bytes, fn: 'fnv' }, chunks);
 * ```
 *
 * @since 1.1.0
 */
export class LanePool {
	readonly name: string;
	readonly size: number;
	private readonly ns: DurableObjectNamespace;
	private readonly options: Required<Omit<LanePoolOptions, 'commit' | 'name' | 'size'>> &
		Pick<LanePoolOptions, 'commit'>;
	/** stats of the most recent job, for tracing what the pool is costing */
	lastStats: JobStats | null = null;
	private cursor = 0;

	constructor(ns: DurableObjectNamespace, options: LanePoolOptions = {}) {
		this.ns = ns;
		this.name = options.name ?? 'burrow';
		this.size = options.size ?? 8;
		if (this.size < 1)
			throw new ParallelError('a pool needs at least one lane', 'burrow.parallel.no_lanes');
		this.options = {
			spares: options.spares ?? Math.max(2, Math.floor(this.size / 4)),
			binding: options.binding ?? 'BURROW_LANES',
			coordinator: options.coordinator ?? true,
			coordinators: options.coordinators ?? 4,
			schedule: options.schedule ?? 'pull',
			hedge: options.hedge ?? true,
			maxAttempts: options.maxAttempts ?? 3,
			stallMs: options.stallMs ?? 30_000,
			hedgeFloorMs: options.hedgeFloorMs ?? 250,
			commit: options.commit
		};
	}

	/** the lane ids jobs run on, after any repairs this isolate has made */
	lanes(): string[] {
		let entry = memo.get(this.name);
		if (!entry || entry.lanes.length !== this.size) {
			entry = {
				lanes: Array.from({ length: this.size }, (_, i) => `${this.name}/l${i}`),
				next: 0
			};
			memo.set(this.name, entry);
		}
		return [...entry.lanes];
	}

	private spares(): string[] {
		return Array.from({ length: this.options.spares }, (_, i) => `${this.name}/s${i}`);
	}

	/** swaps a lane id for a fresh one; the old object is simply never addressed again */
	private retire(lane: string): void {
		const entry = memo.get(this.name);
		const at = entry?.lanes.indexOf(lane) ?? -1;
		if (entry && at >= 0) entry.lanes[at] = `${this.name}/l${at}~${++entry.next}`;
	}

	private slices(
		work: Work,
		inputs: Array<Uint8Array | string> | undefined,
		opts: RunOptions
	): { job: JobDesc; payload: Uint8Array } {
		let parts: Uint8Array[];
		if (inputs) parts = inputs.map((x) => toBytes(x));
		else if (work.input !== undefined)
			parts = (opts.split ?? equalSplit)(toBytes(work.input), 2 * this.size);
		else parts = [new Uint8Array(0)];
		if (!parts.length) parts = [new Uint8Array(0)];

		const base: Omit<SliceDesc, 'jobId' | 'attempt' | 'sliceId'> =
			'guest' in work
				? {
						kind: 'guest',
						fn: work.fn,
						args: work.args,
						result: work.result,
						idempotent: work.idempotent,
						guestLen: work.guest.length
					}
				: 'task' in work
					? {
							kind: 'task',
							task: work.task,
							channels: work.channels
								? Object.fromEntries(
										Object.entries(work.channels).map(([alias, c]) => [
											alias,
											{ id: c.id, capacity: c.capacity }
										])
									)
								: undefined
						}
					: {
							kind: 'runtime',
							runtime: work.runtime,
							files: work.files,
							affinity: work.affinity
						};
		base.requires = work.requires;
		base.effects = work.effects;
		base.pool = { name: this.name, size: this.size, spares: this.options.spares };

		const bodies = parts.map((p) =>
			'guest' in work
				? concat(work.guest, p)
				: 'runtime' in work && work.source !== undefined
					? toBytes(work.source)
					: p
		);
		const payload = new Uint8Array(bodies.reduce((a, b) => a + b.length, 0));
		let off = 0;
		const slices = bodies.map((b, sliceId) => {
			payload.set(b, off);
			const entry = { desc: { ...base, sliceId }, off, len: b.length };
			off += b.length;
			return entry;
		});
		return {
			job: {
				jobId: crypto.randomUUID(),
				binding: this.options.binding,
				lanes: this.lanes(),
				spares: this.spares(),
				schedule: this.options.schedule,
				hedge: this.options.hedge,
				maxAttempts: this.options.maxAttempts,
				stallMs: this.options.stallMs,
				floorMs: this.options.hedgeFloorMs,
				first: this.cursor++ % this.size,
				slices
			},
			payload
		};
	}

	/**
	 * Hands a job to a coordinator object and reads its results as they stream back. Aborting the
	 * signal cancels the stream, which the coordinator sees as a failed write and stops the job.
	 */
	private async coordinate(
		job: JobDesc,
		payload: Uint8Array,
		signal: AbortSignal,
		accept: (
			sliceId: number,
			lane: string,
			attempts: number,
			desc: ResultDesc,
			bytes: Uint8Array
		) => Promise<void>,
		fail: (sliceId: number, reason: FailureDesc) => void
	): Promise<JobStats> {
		const coordinator = `${this.name}/c${stickyIndex(job.jobId, this.options.coordinators)}`;
		const res = await laneTransport(this.ns).send(
			coordinator,
			'coordinate',
			encodeFrame(job, payload)
		);
		if (!res.ok || !res.body) {
			throw new ParallelError(
				`coordinator ${coordinator} answered http ${res.status}`,
				'burrow.parallel.job_failed'
			);
		}
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		res.body.pipeTo(writable, { signal }).catch(() => {});
		const t0 = Date.now();
		try {
			for await (const record of readRecords<Record<string, any>>(readable)) {
				const e = record.desc;
				if (e.event === 'accept')
					await accept(e.sliceId, e.lane, e.attempts, e.result, record.payload);
				else if (e.event === 'fail') fail(e.sliceId, e.reason);
				else if (e.event === 'retire') this.retire(e.lane);
				else if (e.event === 'done') return e.stats as JobStats;
				else if (e.event === 'error') {
					throw new ParallelError(
						`the coordinator failed: ${e.message}`,
						'burrow.parallel.job_failed'
					);
				}
			}
		} catch (e) {
			if (!signal.aborted) throw e;
		}
		if (!signal.aborted) {
			throw new ParallelError(
				'the coordinator stream ended before the job finished',
				'burrow.parallel.job_failed'
			);
		}
		// cancelled: the coordinator's own figures never arrived
		const zero = {
			hedges: 0,
			retries: 0,
			sliceP50Ms: 0,
			sliceMaxMs: 0,
			commits: 0,
			commitMs: 0,
			rowsWritten: 0,
			publishMs: 0
		};
		return { ...zero, requests: 0, spanMs: Date.now() - t0 };
	}

	/**
	 * Runs a job and reports each accepted or failed slice as it happens.
	 *
	 * @internal
	 */
	private async execute(
		work: Work,
		inputs: Array<Uint8Array | string> | undefined,
		opts: RunOptions,
		onResult: (result: LaneResult, jobId: string) => unknown,
		onFail: (sliceId: number, reason: FailureDesc) => void,
		local = false
	): Promise<{ jobId: string; stats: JobStats }> {
		const { job, payload } = this.slices(work, inputs, opts);
		// a failed commit stops the job, so nothing after it is committed out of order
		const halt = new AbortController();
		const signal = opts.signal ? AbortSignal.any([opts.signal, halt.signal]) : halt.signal;
		const committed: number[] = [];
		const settled = new Set<number>();
		let commitFailure: ParallelError | null = null;
		let commitMs = 0;
		let rowsWritten = 0;
		const accept = async (
			sliceId: number,
			lane: string,
			attempts: number,
			desc: ResultDesc,
			bytes: Uint8Array
		) => {
			settled.add(sliceId);
			if (commitFailure) return;
			const result = makeLaneResult(desc, bytes, { sliceId, lane, attempts });
			if (result.effects.length && this.options.commit) {
				const t0 = Date.now();
				try {
					const rows = await this.options.commit(result.effects, {
						jobId: job.jobId,
						sliceId
					});
					if (typeof rows === 'number') rowsWritten += rows;
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					commitFailure = new ParallelError(
						`commit failed on slice ${sliceId} after ${committed.length} committed: ${message}`,
						'burrow.parallel.commit_failed',
						{ cause: e, slices: [sliceId], causes: [message], committed }
					);
					halt.abort();
					return;
				} finally {
					commitMs += Date.now() - t0;
				}
				committed.push(sliceId);
			}
			await onResult(result, job.jobId);
		};
		const fail = (sliceId: number, reason: FailureDesc) => {
			settled.add(sliceId);
			onFail(sliceId, reason);
		};

		let stats: JobStats;
		if (local || !this.options.coordinator) {
			stats = await runJob(
				job,
				payload,
				laneTransport(this.ns),
				{
					accept: (sliceId, lane, attempts, frame) =>
						accept(sliceId, lane, attempts, frame.desc, frame.payload),
					fail,
					retire: (lane) => this.retire(lane)
				},
				signal
			);
		} else {
			stats = await this.coordinate(job, payload, signal, accept, fail);
		}
		if (commitFailure) throw commitFailure;
		stats = { ...stats, commits: committed.length, commitMs, rowsWritten };
		if (signal.aborted) {
			for (let i = 0; i < job.slices.length; i++) {
				if (settled.has(i)) continue;
				fail(i, {
					ok: false,
					code: 'burrow.parallel.cancelled',
					message: 'the job was cancelled',
					iso: ''
				});
			}
		}
		this.lastStats = stats;
		return { jobId: job.jobId, stats };
	}

	/**
	 * Runs one slice per input and answers the results in input order.
	 *
	 * With no `inputs`, a work's own `input` is split into twice as many chunks as there are lanes,
	 * so an idle lane can pull a second chunk while a slow one finishes its first.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.job_failed` naming every slice that failed
	 */
	async map(
		work: Work,
		inputs?: Array<Uint8Array | string>,
		opts: RunOptions = {}
	): Promise<LaneResult[]> {
		const results: LaneResult[] = [];
		const failed: Array<[number, FailureDesc]> = [];
		await this.execute(
			work,
			inputs,
			opts,
			(r) => void (results[r.sliceId] = r),
			(id, why) => failed.push([id, why])
		);
		if (failed.length) throw jobFailed(failed);
		return results;
	}

	/**
	 * Maps, then folds the results in input order.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.job_failed` naming every slice that failed
	 */
	async reduce<T>(
		work: Work,
		inputs: Array<Uint8Array | string> | undefined,
		fold: (acc: T, result: LaneResult) => T,
		initial: T,
		opts: RunOptions = {}
	): Promise<T> {
		return (await this.map(work, inputs, opts)).reduce(fold, initial);
	}

	/**
	 * Yields results as they finish rather than in input order.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.job_failed` after the last result, if any slice failed
	 */
	async *mapUnordered(
		work: Work,
		inputs?: Array<Uint8Array | string>,
		opts: RunOptions = {}
	): AsyncGenerator<LaneResult> {
		const queue: LaneResult[] = [];
		const failed: Array<[number, FailureDesc]> = [];
		let wake: (() => void) | null = null;
		let finished = false;
		let error: unknown = null;
		const ping = () => {
			wake?.();
			wake = null;
		};
		this.execute(
			work,
			inputs,
			opts,
			(r) => {
				queue.push(r);
				ping();
			},
			(id, why) => failed.push([id, why])
		)
			.then(
				() => (finished = true),
				(e) => ((error = e), (finished = true))
			)
			.finally(ping);
		for (;;) {
			while (queue.length) yield queue.shift()!;
			if (finished) break;
			await new Promise<void>((r) => (wake = r));
		}
		if (error) throw error;
		if (failed.length) throw jobFailed(failed);
	}

	/**
	 * Starts one slice and answers a thread-like handle for it.
	 *
	 * Scheduled in the caller rather than through a coordinator: one slice is dispatch-sized work.
	 */
	spawn(work: Work, opts: RunOptions = {}): LaneTask {
		const result = new Promise<LaneResult>((resolve, reject) => {
			let got: LaneResult | null = null;
			let why: FailureDesc | null = null;
			this.execute(
				work,
				work.input !== undefined ? [work.input] : undefined,
				opts,
				(r) => void (got = r),
				(_, w) => (why = w),
				true
			).then(() => (got ? resolve(got) : reject(sliceError(0, why))), reject);
		});
		return new LaneTask(0, result);
	}

	/**
	 * A structured-concurrency scope: tasks spawned from it are cancelled and awaited when it is
	 * disposed, so no slice outlives the code that started it.
	 *
	 * @example
	 * ```ts
	 * await using scope = pool.scope();
	 * const [a, b] = await Promise.all([scope.spawn(workA), scope.spawn(workB)]);
	 * ```
	 */
	scope(): LaneScope {
		return new LaneScope(this);
	}

	/**
	 * Computes every slice, stages each accepted result, and publishes once, only if every slice
	 * staged; otherwise the publish is withheld and the previous output keeps serving whole.
	 *
	 * Measured with 34 pages: staged publication made the whole set visible 10-16x faster than a
	 * serial fill, and no reader ever saw a mix of old and new pages.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.build_incomplete` naming every slice that did not stage
	 */
	async build(
		work: Work,
		inputs: Array<Uint8Array | string> | undefined,
		steps: BuildSteps,
		opts: RunOptions = {}
	): Promise<{ results: LaneResult[]; stats: JobStats }> {
		const results: LaneResult[] = [];
		const failed: Array<[number, FailureDesc]> = [];
		const { stats } = await this.execute(
			work,
			inputs,
			opts,
			async (r, jobId) => {
				if (steps.validate && !(await steps.validate(r))) {
					failed.push([
						r.sliceId,
						{
							ok: false,
							code: 'burrow.parallel.slice_failed',
							message: 'validate() rejected the result',
							iso: ''
						}
					]);
					return;
				}
				await steps.stage(r, { jobId, sliceId: r.sliceId });
				results[r.sliceId] = r;
			},
			(sliceId, why) => failed.push([sliceId, why])
		);
		if (failed.length) {
			failed.sort((a, b) => a[0] - b[0]);
			throw new ParallelError(
				`${failed.length} slice(s) did not stage, so the output was not published`,
				'burrow.parallel.build_incomplete',
				{
					slices: failed.map(([s]) => s),
					causes: failed.map(([, w]) => w.message)
				}
			);
		}
		const t0 = Date.now();
		await steps.publish();
		const published = { ...stats, publishMs: Date.now() - t0 };
		this.lastStats = published;
		return { results, stats: published };
	}

	/**
	 * Sends one slice straight to one lane: no scheduler, no hedge, no retry. The escape hatch.
	 *
	 * @throws {ParallelError} carrying the lane's own failure code
	 */
	async call(laneId: string, work: Work): Promise<LaneResult> {
		const { job, payload } = this.slices(
			work,
			work.input !== undefined ? [work.input] : undefined,
			{}
		);
		const slice = job.slices[0]!;
		const res = await laneTransport(this.ns).send(
			laneId,
			'slice',
			encodeFrame({ ...slice.desc, jobId: job.jobId, attempt: 1 }, payload)
		);
		if (!res.ok)
			throw new ParallelError(
				`lane ${laneId} answered http ${res.status}`,
				'burrow.parallel.slice_failed'
			);
		const frame = decodeFrame<ResultDesc | FailureDesc>(
			new Uint8Array(await res.arrayBuffer())
		);
		if (!frame.desc.ok) throw sliceError(0, frame.desc);
		return makeLaneResult(frame.desc, frame.payload, { sliceId: 0, lane: laneId, attempts: 1 });
	}

	/** Probes every lane and reports which ones share an isolate. */
	async health(): Promise<PoolHealth> {
		const t = laneTransport(this.ns);
		const lanes = await Promise.all(
			this.lanes().map(async (lane) => {
				const h = (await (await t.send(lane, 'health', '{}')).json()) as {
					iso: string;
					tags: StateTags;
				};
				return { lane, isolate: h.iso, tags: h.tags };
			})
		);
		const groups = new Map<string, string[]>();
		for (const l of lanes) groups.set(l.isolate, [...(groups.get(l.isolate) ?? []), l.lane]);
		return {
			lanes,
			isolates: groups.size,
			coResident: [...groups.values()].filter((g) => g.length > 1)
		};
	}

	/** Replaces all but one lane of every co-resident group with a fresh id, then probes again. */
	async repair(): Promise<PoolHealth> {
		const before = await this.health();
		for (const group of before.coResident) for (const lane of group.slice(1)) this.retire(lane);
		return this.health();
	}

	/**
	 * The pool's shared number `key`. Inside a task, `ctx.atomic(key)` reaches the same one.
	 *
	 * Measured at 16-18 ms an op, exact under forced hedging.
	 */
	atomic(key: string): LaneAtomic {
		return new LaneAtomic(laneTransport(this.ns), `${this.name}/sync/${key}`);
	}

	/** The pool's lock `key`. Inside a task, `ctx.mutex(key)` reaches the same one. */
	mutex(key: string): LaneMutex {
		return new LaneMutex(laneTransport(this.ns), `${this.name}/sync/${key}`);
	}

	/**
	 * A channel named `name`, which tasks reach through `channels: { alias: channel }`. A closed
	 * name stays closed; {@link LaneScope.channel} names each one freshly and closes it with the scope.
	 */
	channel(name: string, options: { capacity?: number } = {}): LaneChannel {
		return new LaneChannel(
			laneTransport(this.ns),
			`${this.name}/chan/${name}`,
			options.capacity
		);
	}

	/**
	 * Makes every lane and spare satisfy `want`, off the serving path, so later slices requiring it
	 * run without waiting, and a hedge or retry of one has somewhere to go.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.stale_state` naming lanes that could not
	 */
	async prepare(want: StateTags): Promise<void> {
		const t = laneTransport(this.ns);
		const out = await Promise.all(
			[...this.lanes(), ...this.spares()].map(async (lane) => ({
				lane,
				body: (await (await t.send(lane, 'prepare', JSON.stringify({ want }))).json()) as {
					tags?: StateTags;
					ok?: false;
					message?: string;
				}
			}))
		);
		const bad = out.filter((o) => o.body.ok === false);
		if (bad.length) {
			throw new ParallelError(
				`${bad.length} lane(s) could not satisfy ${JSON.stringify(want)}: ${bad[0]!.body.message}`,
				'burrow.parallel.stale_state',
				{ causes: bad.map((b) => `${b.lane}: ${b.body.message}`) }
			);
		}
	}
}

/**
 * Tasks spawned together and ended together.
 *
 * @since 1.1.0
 */
export class LaneScope implements AsyncDisposable {
	private readonly controller = new AbortController();
	private readonly tasks: LaneTask[] = [];
	private readonly channels: LaneChannel[] = [];
	private readonly id = crypto.randomUUID();

	/** @internal */
	constructor(private readonly pool: LanePool) {}

	/** starts a slice that the scope cancels if it is still running when the scope ends */
	spawn(work: Work, opts: RunOptions = {}): LaneTask {
		const signal = opts.signal
			? AbortSignal.any([opts.signal, this.controller.signal])
			: this.controller.signal;
		const task = this.pool.spawn(work, { ...opts, signal });
		this.tasks.push(task);
		return task;
	}

	/** a channel that closes when the scope ends, under a name no other scope shares */
	channel(name: string, options: { capacity?: number } = {}): LaneChannel {
		const channel = this.pool.channel(`${name}~${this.id}`, options);
		this.channels.push(channel);
		return channel;
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.controller.abort();
		// closing first lets a task still reading a channel finish rather than wait forever
		await Promise.allSettled(this.channels.map((c) => c.close()));
		await Promise.allSettled(this.tasks.map((t) => t.join()));
	}
}

function sliceError(sliceId: number, why: FailureDesc | null): ParallelError {
	return new ParallelError(
		why?.message ?? 'the slice failed',
		why?.code ?? 'burrow.parallel.slice_failed',
		{ slices: [sliceId], causes: [why?.message ?? ''] }
	);
}

function jobFailed(failed: Array<[number, FailureDesc]>): ParallelError {
	failed.sort((a, b) => a[0] - b[0]);
	return new ParallelError(
		`${failed.length} slice(s) failed: ${failed[0]![1].message}`,
		'burrow.parallel.job_failed',
		{
			slices: failed.map(([s]) => s),
			causes: failed.map(([, w]) => w.message)
		}
	);
}
