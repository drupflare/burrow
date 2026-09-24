import { ParallelError } from '../errors.js';
import { decodeFrame, encodeFrame, type Frame } from './frame.js';
import type { FailureDesc, SliceDesc, StateTags } from './lane.js';
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
	/** what the pool already knows of each lane's tags and isolate, for placement */
	tags?: Record<string, StateTags>;
	iso?: Record<string, string>;
	/** prepare a lane in the background when a slice finds it stale */
	catchUp?: boolean;
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
	/** background prepares started because a slice found a lane stale */
	catchUps: number;
}

/** @internal what the scheduler reports as a job progresses */
export interface JobSink {
	accept(sliceId: number, lane: string, attempts: number, frame: Frame<ResultDesc>): unknown;
	fail(sliceId: number, reason: FailureDesc): unknown;
	retire(lane: string): unknown;
	/** a lane's tags became known mid-job, from a stale refusal or a background prepare */
	learn?(lane: string, tags: StateTags): unknown;
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

/** @internal whether a lane holding `have` may run a slice that requires `want` */
export function satisfies(have: StateTags, want: StateTags | undefined): boolean {
	if (!want) return true;
	return Object.entries(want).every(([k, v]) => have[k] === v);
}

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
		catchUps = 0,
		spareIx = 0,
		done = 0;
	let fatal: unknown = null;

	// what is known of each lane, refined as answers arrive; unknown tags count as eligible
	const tags: Record<string, StateTags> = { ...job.tags };
	const iso: Record<string, string> = { ...job.iso };
	const eligible = (lane: string, i: number) => {
		const have = tags[lane];
		return !have || satisfies(have, job.slices[i]!.desc.requires);
	};
	const score = (lane: string, i: number) => {
		const want = job.slices[i]!.desc.prefers;
		const have = tags[lane];
		return want && have ? Object.entries(want).filter(([k, v]) => have[k] === v).length : 0;
	};

	const spare = (i: number): string => {
		const pool = job.spares.length ? job.spares : job.lanes;
		let fallback: string | undefined;
		for (let k = 0; k < pool.length; k++) {
			const s = pool[spareIx++ % pool.length]!;
			if (retired.has(s)) continue;
			if (eligible(s, i)) return s;
			fallback ??= s;
		}
		return fallback ?? pool[0]!;
	};

	// a stale lane is prepared off the serving path, once per lane and requirement in a job
	const caughtUp = new Set<string>();
	let pump = () => {};
	const catchUp = (lane: string, want: StateTags) => {
		const key = `${lane}|${JSON.stringify(want)}`;
		if (job.catchUp === false || caughtUp.has(key)) return;
		caughtUp.add(key);
		catchUps++;
		transport
			.send(lane, 'prepare', JSON.stringify({ want }))
			.then((res) => res.json() as Promise<{ tags?: StateTags }>)
			.then(async (answer) => {
				if (!answer.tags) return;
				tags[lane] = answer.tags;
				await report(() => sink.learn?.(lane, answer.tags!));
				pump();
			})
			.catch(() => {});
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

		if (frame) iso[lane] = frame.desc.iso || iso[lane] || '';
		if (frame?.desc.ok) {
			tags[lane] = (frame.desc as ResultDesc).tags as StateTags;
			s.accepted = true;
			durations.push(Date.now() - started);
			await report(() => sink.accept(i, lane, s.tries, frame as Frame<ResultDesc>));
			settle(i);
			return;
		}
		const failure = frame?.desc as FailureDesc | undefined;
		if (failure?.tags) {
			tags[lane] = failure.tags;
			await report(() => sink.learn?.(lane, failure.tags!));
			if (slice.desc.requires) catchUp(lane, slice.desc.requires);
		}
		if (failure?.environment && !retired.has(lane)) {
			retired.add(lane);
			await report(() => sink.retire(lane));
		}
		const sticky = slice.desc.affinity !== undefined;
		const permanent = failure !== undefined && PERMANENT.has(failure.code);
		if (!permanent && !sticky && s.tries < job.maxAttempts && !signal?.aborted) {
			retries++;
			return attempt(i, spare(i));
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
					void attempt(i, spare(i));
				}
			}
		}
	})();

	const run = (i: number, lane: string) => {
		void attempt(i, lane);
		return settled[i]!.p;
	};
	const cancelled = () => signal?.aborted ?? false;
	const order = job.lanes.map((_, k) => job.lanes[(k + (job.first ?? 0)) % K]!);
	const failFast = async (i: number) => {
		const want = job.slices[i]!.desc.requires!;
		state[i]!.failed = true;
		for (const lane of job.lanes) catchUp(lane, want);
		await report(() =>
			sink.fail(i, {
				ok: false,
				code: 'burrow.parallel.stale_state',
				message: `no lane holds ${JSON.stringify(want)}; preparing them in the background`,
				iso: ''
			})
		);
		settle(i);
	};

	// sticky slices keep their key's lane and run in input order per key
	const chains = new Map<string, Promise<void>>();
	const pending: number[] = [];
	for (let i = 0; i < n; i++) {
		const key = job.slices[i]!.desc.affinity;
		if (key === undefined) {
			pending.push(i);
			continue;
		}
		const lane = job.lanes[stickyIndex(key, K)]!;
		chains.set(
			key,
			(chains.get(key) ?? Promise.resolve()).then(() =>
				cancelled() ? undefined : run(i, lane)
			)
		);
	}

	if (job.schedule === 'static') {
		const byLane = new Map<string, number[]>();
		pending.forEach((i, k) =>
			byLane.set(order[k % K]!, [...(byLane.get(order[k % K]!) ?? []), i])
		);
		void Promise.all(
			[...byLane].map(async ([lane, list]) => {
				for (const i of list) if (!cancelled()) await run(i, lane);
			})
		);
	} else {
		// locality first: each pending slice goes to the idle lane that satisfies its requires with the
		// most prefers hits, avoiding an isolate that is already busy, then in rotation order
		const idle = new Set(order);
		const busyIso = new Map<string, number>();
		const pick = (i: number): string | undefined => {
			let best: string | undefined;
			let bestKey = [-1, 0, 0];
			order.forEach((lane, rank) => {
				if (!idle.has(lane) || !eligible(lane, i)) return;
				const key = [score(lane, i), -(busyIso.get(iso[lane] ?? lane) ?? 0), -rank];
				if (
					key[0]! > bestKey[0]! ||
					(key[0] === bestKey[0] &&
						(key[1]! > bestKey[1]! || (key[1] === bestKey[1] && key[2]! > bestKey[2]!)))
				) {
					best = lane;
					bestKey = key;
				}
			});
			return best;
		};
		pump = () => {
			for (let j = 0; j < pending.length && !cancelled();) {
				const i = pending[j]!;
				if (!job.lanes.some((lane) => eligible(lane, i))) {
					pending.splice(j, 1);
					void failFast(i);
					continue;
				}
				const lane = pick(i);
				if (!lane) {
					j++;
					continue;
				}
				pending.splice(j, 1);
				idle.delete(lane);
				const at = iso[lane] ?? lane;
				busyIso.set(at, (busyIso.get(at) ?? 0) + 1);
				void run(i, lane).then(() => {
					idle.add(lane);
					busyIso.set(at, (busyIso.get(at) ?? 1) - 1);
					pump();
				});
			}
		};
		pump();
	}
	await Promise.race([
		Promise.all(settled.map((s) => s.p)),
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
		publishMs: 0,
		catchUps
	};
}
