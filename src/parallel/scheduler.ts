import { ParallelError } from '../errors.js';
import { decodeFrame, encodeFrame, type Frame } from './frame.js';
import type { FailureDesc, SliceDesc } from './lane.js';
import type { ResultDesc } from './result.js';

/** @internal one job as it travels to a coordinator: every slice, and where its payload sits */
export interface JobDesc {
	jobId: string;
	binding: string;
	lanes: string[];
	spares: string[];
	schedule: 'pull' | 'static';
	hedge: boolean;
	maxAttempts: number;
	stallMs: number;
	floorMs: number;
	/** the lane that takes the first slice, so single-slice jobs spread across the pool */
	first?: number;
	slices: Array<{ desc: Omit<SliceDesc, 'jobId' | 'attempt'>; off: number; len: number }>;
}

/** How one job went, reported on every result so a bottleneck is visible from the first run. */
export interface JobStats {
	/** lane requests made, hedges and retries included */
	requests: number;
	/** late slices duplicated onto a spare */
	hedges: number;
	/** failed attempts re-run elsewhere */
	retries: number;
	/** wall time from the first dispatch to the last result */
	spanMs: number;
	/** median and slowest accepted slice */
	sliceP50Ms: number;
	sliceMaxMs: number;
	/** slices whose effects the pool's `commit` applied */
	commits: number;
	/** time spent inside `commit`, summed; where the primary shows up as the bottleneck */
	commitMs: number;
	/** rows `commit` reported writing by answering a number; burrow cannot see them otherwise */
	rowsWritten: number;
	/** time spent inside a build's `publish`; 0 for every other call */
	publishMs: number;
}

/** @internal what the scheduler reports as a job progresses */
export interface JobSink {
	accept(sliceId: number, lane: string, attempts: number, frame: Frame<ResultDesc>): unknown;
	fail(sliceId: number, reason: FailureDesc): unknown;
	retire(lane: string): unknown;
}

/** @internal how the scheduler reaches a lane */
export interface Transport {
	send(
		lane: string,
		op: string,
		body: Uint8Array | string | ReadableStream,
		query?: Record<string, string>
	): Promise<Response>;
}

/** @internal sends frames to lanes by name through a namespace */
export function laneTransport(ns: DurableObjectNamespace): Transport {
	return {
		async send(lane, op, body, query = {}) {
			const qs = new URLSearchParams({ name: lane, ...query });
			return ns.get(ns.idFromName(lane)).fetch(`https://lane/${op}?${qs}`, {
				method: 'POST',
				body
			});
		}
	};
}

// failures a different lane cannot fix: retrying them only repeats the refusal
const PERMANENT = new Set<ParallelError['code']>([
	'burrow.parallel.impure',
	'burrow.parallel.unknown_task',
	'burrow.parallel.frame_malformed'
]);

/** @internal a stable lane index for a sticky key */
export function stickyIndex(key: string, lanes: number): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
	return h % lanes;
}

function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

function stall<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new ParallelError(
						`${what} gave no answer in ${ms} ms`,
						'burrow.parallel.stalled'
					)
				),
			ms
		);
	});
	return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/**
 * Runs one job across lanes: pull or static assignment, an adaptive deadline hedge, retries on
 * spares, and exactly one accepted result per slice.
 *
 * The same code runs in the caller and in a coordinator object, which is why it takes its lanes
 * through a transport rather than a namespace.
 *
 * @internal
 */
export async function runJob(
	job: JobDesc,
	payload: Uint8Array,
	transport: Transport,
	sink: JobSink,
	signal?: AbortSignal
): Promise<JobStats> {
	const t0 = Date.now();
	const n = job.slices.length;
	const K = job.lanes.length;
	if (!K) throw new ParallelError('the pool has no lanes to run on', 'burrow.parallel.no_lanes');

	const state = job.slices.map(() => ({
		accepted: false,
		failed: false,
		tries: 0,
		pending: 0,
		start: 0,
		hedged: false
	}));
	const settled = job.slices.map(() => {
		let resolve!: () => void;
		const p = new Promise<void>((r) => (resolve = r));
		return { p, resolve };
	});
	const durations: number[] = [];
	const retired = new Set<string>();
	let requests = 0,
		hedges = 0,
		retries = 0,
		spareIx = 0,
		done = 0;
	let fatal: unknown = null;

	const spare = (): string => {
		const pool = job.spares.length ? job.spares : job.lanes;
		for (let k = 0; k < pool.length; k++) {
			const s = pool[spareIx++ % pool.length]!;
			if (!retired.has(s)) return s;
		}
		return pool[0]!;
	};
	const settle = (i: number) => {
		done++;
		settled[i]!.resolve();
	};
	const report = async (fn: () => unknown) => {
		try {
			await fn();
		} catch (e) {
			fatal ??= e;
		}
	};

	async function attempt(i: number, lane: string): Promise<void> {
		const s = state[i]!;
		const slice = job.slices[i]!;
		s.tries++;
		s.pending++;
		requests++;
		if (!s.start) s.start = Date.now();
		const started = Date.now();
		let frame: Frame<ResultDesc | FailureDesc> | null = null;
		let error = '';
		try {
			const body = encodeFrame(
				{ ...slice.desc, jobId: job.jobId, attempt: s.tries },
				payload.subarray(slice.off, slice.off + slice.len)
			);
			const res = await stall(
				transport.send(lane, 'slice', body),
				job.stallMs,
				`slice ${i} on ${lane}`
			);
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (!res.ok)
				error = `lane ${lane} answered http ${res.status}: ${new TextDecoder().decode(bytes).slice(0, 160)}`;
			else frame = decodeFrame<ResultDesc | FailureDesc>(bytes);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		s.pending--;
		if (s.accepted || s.failed) return;

		if (frame?.desc.ok) {
			s.accepted = true;
			durations.push(Date.now() - started);
			await report(() => sink.accept(i, lane, s.tries, frame as Frame<ResultDesc>));
			settle(i);
			return;
		}
		const failure = frame?.desc as FailureDesc | undefined;
		if (failure?.environment && !retired.has(lane)) {
			retired.add(lane);
			await report(() => sink.retire(lane));
		}
		const sticky = slice.desc.affinity !== undefined;
		const permanent = failure !== undefined && PERMANENT.has(failure.code);
		if (!permanent && !sticky && s.tries < job.maxAttempts && !signal?.aborted) {
			retries++;
			return attempt(i, spare());
		}
		if (s.pending > 0) return;
		s.failed = true;
		const reason: FailureDesc = failure
			? {
					...failure,
					code: sticky && !permanent ? 'burrow.parallel.sticky_failed' : failure.code
				}
			: {
					ok: false,
					code: sticky ? 'burrow.parallel.sticky_failed' : 'burrow.parallel.slice_failed',
					message: error,
					iso: ''
				};
		await report(() => sink.fail(i, reason));
		settle(i);
	}

	// duplicates a slice once it runs past three times the median of those already accepted; until a
	// quarter are in there is no median, so a fixed ceiling of 8x the floor stands in (2 s by default)
	let running = true;
	const watchdog = (async () => {
		if (!job.hedge) return;
		while (running) {
			await new Promise((r) => setTimeout(r, Math.min(20, job.floorMs)));
			const limit =
				done < Math.max(1, Math.floor(n / 4))
					? 8 * job.floorMs
					: Math.max(3 * median(durations), job.floorMs);
			for (let i = 0; i < n; i++) {
				const s = state[i]!;
				if (s.accepted || s.failed || s.hedged || s.pending === 0) continue;
				if (job.slices[i]!.desc.affinity !== undefined) continue;
				if (Date.now() - s.start > limit) {
					s.hedged = true;
					hedges++;
					void attempt(i, spare());
				}
			}
		}
	})();

	const run = (i: number, lane: string) => {
		const key = job.slices[i]!.desc.affinity;
		void attempt(i, key !== undefined ? job.lanes[stickyIndex(key, K)]! : lane);
		return settled[i]!.p;
	};
	const cancelled = () => signal?.aborted ?? false;
	await Promise.race([
		(async () => {
			const order = job.lanes.map((_, k) => job.lanes[(k + (job.first ?? 0)) % K]!);
			if (job.schedule === 'static') {
				await Promise.all(
					order.map(async (lane, k) => {
						for (let i = k; i < n && !cancelled(); i += K) await run(i, lane);
					})
				);
			} else {
				let next = 0;
				await Promise.all(
					order.map(async (lane) => {
						for (let i = next++; i < n && !cancelled(); i = next++) await run(i, lane);
					})
				);
			}
		})(),
		new Promise<void>((resolve) =>
			signal?.addEventListener('abort', () => resolve(), { once: true })
		)
	]);
	if (cancelled()) {
		for (let i = 0; i < n; i++) {
			const s = state[i]!;
			if (s.accepted || s.failed) continue;
			s.failed = true;
			await report(() =>
				sink.fail(i, {
					ok: false,
					code: 'burrow.parallel.cancelled',
					message: 'the job was cancelled',
					iso: ''
				})
			);
			settle(i);
		}
	}
	await Promise.all(settled.map((s) => s.p));
	running = false;
	await watchdog;
	if (fatal) throw fatal;
	const sorted = [...durations].sort((a, b) => a - b);
	return {
		requests,
		hedges,
		retries,
		spanMs: Date.now() - t0,
		sliceP50Ms: median(durations),
		sliceMaxMs: sorted.at(-1) ?? 0,
		commits: 0,
		commitMs: 0,
		rowsWritten: 0,
		publishMs: 0
	};
}
