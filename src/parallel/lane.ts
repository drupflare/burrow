import { DurableObject } from 'cloudflare:workers';
import { Budget } from '../budget.js';
import { readImports } from '../dylink.js';
import { ParallelError } from '../errors.js';
import { createInterpreter, type ImportMap, type WasmInterpreter } from '../interpret.js';
import { Burrow } from '../registry.js';
import type { AnyRuntimeSpec } from '../runtime.js';
import { fromBytes, toBytes, type Session } from '../session.js';
import { handleChannel, LaneChannel } from './channel.js';
import { decodeFrame, encodeFrame, encodeRecord } from './frame.js';
import { LanePool, type Work } from './pool.js';
import type { LaneResult, ResultDesc, ResultKind } from './result.js';
import { laneTransport, runJob, satisfies, type JobDesc } from './scheduler.js';
import { handleSync, LaneAtomic, LaneMutex, type SyncRequest } from './sync.js';

/** Scheduler-visible facts about a lane, such as the generation it holds. */
export type StateTags = Record<string, string | number | boolean>;

/** What a named task receives besides its input. */
export interface TaskContext {
	/** the lane id running the slice */
	readonly lane: string;
	/** the environment the lane class was constructed with */
	readonly env: unknown;
	/** this lane's own durable storage */
	readonly storage: DurableObjectStorage;
	/**
	 * Records an effect instead of applying it. Effects travel back with the result and the pool
	 * hands them to its `commit` exactly once per accepted slice, so a hedged or retried slice can
	 * never apply them twice.
	 */
	effect(op: unknown): void;
	/** the pool's shared number `key`; ops from a slice apply once however often the slice runs */
	atomic(key: string): LaneAtomic;
	/** the pool's lock `key` */
	mutex(key: string): LaneMutex;
	/** a channel the work passed in as `channels: { [alias]: channel }` */
	channel(alias: string): LaneChannel;
	/**
	 * Runs one child slice on the same pool. The lane gives up its slot while the child runs, as it
	 * would for any other I/O, so a child can always be scheduled even on a one-lane pool.
	 */
	spawn(work: Work): Promise<LaneResult>;
	/** runs child slices on the same pool, yielding the lane's slot as {@link TaskContext.spawn} does */
	map(work: Work, inputs?: Array<Uint8Array | string>): Promise<LaneResult[]>;
}

/** A named task: ordinary code from the consumer's bundle, run at native speed. */
export type LaneTaskFn = (input: Uint8Array, ctx: TaskContext) => unknown;

/** What a stateful lane's `prepare` receives. */
export interface LaneStateContext {
	readonly lane: string;
	readonly env: unknown;
	readonly storage: DurableObjectStorage;
}

/**
 * Configuration for {@link defineLane}.
 *
 * @since 1.1.0
 */
export interface LaneConfig {
	/** the compiled interpreter, `import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm'`; needed for guest slices */
	interpreter?: WebAssembly.Module;
	/** a ceiling on any one guest's linear memory, passed to the interpreter */
	maxMemoryBytes?: number;
	/** host functions offered to guests; a guest may use them only in a slice marked `idempotent` */
	guestImports?: ImportMap;
	/** named tasks callable as `{ task: 'name' }` */
	tasks?: Record<string, LaneTaskFn>;
	/** runtimes callable as `{ runtime: 'name' }`, the same specs a {@link Burrow} takes */
	runtimes?: readonly AnyRuntimeSpec[];
	/**
	 * Makes this lane satisfy a slice's `requires`: seed its storage, replay a log, whatever the
	 * consumer's state needs. Answers the tags the lane holds afterwards. Runs off the serving path:
	 * a slice that finds its requirement unmet fails fast and the pool prepares lanes separately.
	 */
	prepare?: (ctx: LaneStateContext, have: StateTags, want: StateTags) => Promise<StateTags>;
	/** the binding name of the lane namespace, which coordinators use to reach lanes; defaults to `BURROW_LANES` */
	binding?: string;
	/** @internal replaces the isolate token, so a test can simulate co-residency under miniflare */
	isolateToken?: (objectId: string, lane: string) => string;
}

/** @internal the wire descriptor of one slice */
export interface SliceDesc {
	jobId: string;
	sliceId: number;
	attempt: number;
	kind: 'guest' | 'task' | 'runtime';
	fn?: string;
	args?: number[];
	result?: 'number' | 'bytes';
	idempotent?: boolean;
	guestLen?: number;
	task?: string;
	runtime?: string;
	files?: Record<string, string>;
	affinity?: string;
	/** the pool that sent the slice, so a task can reach its sync objects and spawn children */
	pool?: { name: string; size: number; spares: number };
	channels?: Record<string, { id: string; capacity: number }>;
	requires?: StateTags;
	prefers?: StateTags;
	effects?: 'capture';
}

/** @internal what a lane answers when a slice fails */
export interface FailureDesc {
	ok: false;
	code: ParallelError['code'];
	message: string;
	/** the failure implicates the lane's environment, so the pool should retire the lane id */
	environment?: boolean;
	iso: string;
	/** the tags the lane held, on a stale_state refusal, so the scheduler routes around it */
	tags?: StateTags;
}

// per-isolate state. A Durable Object's instance is evicted within seconds of going idle while its
// isolate lives for minutes (measured), so anything worth keeping warm is keyed by object id here
let isolateId: string | undefined;
const isolateBudget = new Budget();
const interpreters = new Map<string, Promise<WasmInterpreter>>();
const sessions = new Map<string, { session: Session; burrow: Burrow; as: string }>();
const slots = new Map<string, { busy: boolean; queue: Array<() => void> }>();
let freshCounter = 0;

function isolate(config: LaneConfig, objectId: string, lane: string): string {
	return config.isolateToken
		? config.isolateToken(objectId, lane)
		: (isolateId ??= crypto.randomUUID());
}

type Slot = { busy: boolean; queue: Array<() => void> };

async function take(slot: Slot): Promise<void> {
	if (slot.busy) await new Promise<void>((r) => slot.queue.push(r));
	slot.busy = true;
}

function give(slot: Slot): void {
	const next = slot.queue.shift();
	if (next) next();
	else slot.busy = false;
}

type Yield = <R>(wait: () => Promise<R>) => Promise<R>;

/** one running slice per lane, first come first served; a slice waiting on children yields */
async function withSlot<T>(objectId: string, run: (yielded: Yield) => Promise<T>): Promise<T> {
	let slot = slots.get(objectId);
	if (!slot) slots.set(objectId, (slot = { busy: false, queue: [] }));
	const s = slot;
	await take(s);
	let holding = true;
	let finished = false;
	let outstanding = 0;
	const yielded: Yield = async (wait) => {
		if (outstanding++ === 0 && holding) {
			holding = false;
			give(s);
		}
		try {
			return await wait();
		} finally {
			if (--outstanding === 0 && !finished && !holding) {
				await take(s);
				if (finished) give(s);
				else holding = true;
			}
		}
	};
	try {
		return await run(yielded);
	} finally {
		finished = true;
		if (holding) give(s);
	}
}

// read from storage every time: an object can move between isolates, and a module-level copy in the
// isolate it left would hand prepare() a stale `have`; the platform already caches storage reads
async function tagsOf(state: DurableObjectState): Promise<StateTags> {
	return (await state.storage.get<StateTags>('burrow:tags')) ?? {};
}

// a sticky session was built against the lane's old state, so a change of tags retires it
function disposeSessions(objectId: string): void {
	for (const [key, entry] of sessions) {
		if (!key.startsWith(`${objectId}|`)) continue;
		sessions.delete(key);
		entry.session.dispose();
		entry.burrow.dispose();
		isolateBudget.forget(entry.as);
	}
}

function interpreterFor(config: LaneConfig, objectId: string): Promise<WasmInterpreter> {
	if (!config.interpreter) {
		throw new ParallelError(
			'this lane was defined without an interpreter, so it cannot run guest slices',
			'burrow.parallel.slice_failed'
		);
	}
	let vm = interpreters.get(objectId);
	if (!vm) {
		vm = createInterpreter({
			module: config.interpreter,
			maxMemoryBytes: config.maxMemoryBytes
		});
		interpreters.set(objectId, vm);
		vm.catch(() => interpreters.delete(objectId));
	}
	return vm;
}

// runtime names are prefixed per object, because one Budget accounts the whole isolate and two
// objects booting the same runtime would otherwise collide on one budget entry
function runtimeSpec(config: LaneConfig, name: string, as: string): AnyRuntimeSpec {
	const spec = config.runtimes?.find((s) => s.name === name);
	if (!spec)
		throw new ParallelError(
			`no runtime named ${JSON.stringify(name)} on this lane`,
			'burrow.parallel.unknown_task'
		);
	return { ...spec, name: as };
}

interface Outcome {
	kind: ResultKind;
	number?: number;
	bytes: Uint8Array;
	exitCode?: number;
	stderr?: number[];
}

async function runGuest(
	config: LaneConfig,
	objectId: string,
	desc: SliceDesc,
	payload: Uint8Array
): Promise<Outcome> {
	const guestBytes = payload.subarray(0, desc.guestLen ?? 0);
	const input = payload.subarray(desc.guestLen ?? 0);
	const importsFunctions = readImports(guestBytes).some((i) => i.kind === 'function');
	if (importsFunctions && !desc.idempotent) {
		throw new ParallelError(
			'the guest imports host functions, and a slice can run twice under hedging; mark it idempotent: true if a repeat is safe',
			'burrow.parallel.impure'
		);
	}
	const vm = await interpreterFor(config, objectId);
	const guest = vm.load(guestBytes, importsFunctions ? { imports: config.guestImports } : {});
	try {
		const args = desc.args ?? [];
		let callArgs = args;
		if (input.length) {
			const ptr = guest.has('alloc') ? guest.call('alloc', input.length) : 0;
			// Guest.write does not bounds-check, so check here rather than write past the guest
			if (ptr + input.length > guest.memory().length) {
				throw new ParallelError(
					`the input is ${input.length} bytes and does not fit the guest's memory at ${ptr}`,
					'burrow.parallel.slice_failed'
				);
			}
			guest.write(ptr, input);
			callArgs = [ptr, input.length, ...args];
		}
		const value = guest.call(desc.fn ?? 'main', ...callArgs);
		if (desc.result === 'bytes') {
			const head = guest.read(value, 4);
			const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
			return { kind: 'bytes', bytes: guest.read(value + 4, length) };
		}
		return { kind: 'number', number: value, bytes: new Uint8Array(0) };
	} finally {
		vm.unload(guest.index);
	}
}

async function runTask(
	config: LaneConfig,
	ctx: TaskContext,
	desc: SliceDesc,
	input: Uint8Array
): Promise<Outcome> {
	const task = desc.task ? config.tasks?.[desc.task] : undefined;
	if (!task)
		throw new ParallelError(
			`no task named ${JSON.stringify(desc.task)} on this lane`,
			'burrow.parallel.unknown_task'
		);
	const value = await task(input, ctx);
	if (value instanceof Uint8Array) return { kind: 'bytes', bytes: value };
	if (typeof value === 'string') return { kind: 'text', bytes: toBytes(value) };
	if (typeof value === 'number')
		return { kind: 'number', number: value, bytes: new Uint8Array(0) };
	return { kind: 'json', bytes: toBytes(JSON.stringify(value ?? null)) };
}

async function runRuntime(
	config: LaneConfig,
	objectId: string,
	desc: SliceDesc,
	payload: Uint8Array
): Promise<Outcome> {
	const name = desc.runtime ?? '';
	const source = fromBytes(payload);
	let session: Session;
	let fresh: { burrow: Burrow; as: string } | null = null;
	if (desc.affinity !== undefined) {
		// sticky: the session and everything it holds stay with this lane between slices
		const key = `${objectId}|${name}|${desc.affinity}`;
		let found = sessions.get(key);
		if (!found) {
			// the session holds its lease, and through it the registry, for as long as it is cached
			const as = `${objectId}:${name}:${desc.affinity}`;
			const burrow = new Burrow({
				runtimes: [runtimeSpec(config, name, as)],
				budget: isolateBudget
			});
			found = { session: await burrow.session(as, { files: desc.files }), burrow, as };
			sessions.set(key, found);
		}
		session = found.session;
	} else {
		// fresh: a new instantiation per slice, so nothing carries from one slice to the next
		const as = `${objectId}:${name}:fresh${++freshCounter}`;
		const burrow = new Burrow({
			runtimes: [runtimeSpec(config, name, as)],
			budget: isolateBudget
		});
		fresh = { burrow, as };
		session = await burrow.session(as, { files: desc.files });
	}
	try {
		const run = await session.eval(source);
		return {
			kind: 'run',
			bytes: run.stdout,
			exitCode: run.exitCode,
			stderr: Array.from(run.stderr)
		};
	} finally {
		if (fresh) {
			session.dispose();
			fresh.burrow.dispose();
			isolateBudget.forget(fresh.as);
		}
	}
}

function failure(e: unknown, iso: string): FailureDesc {
	if (e instanceof ParallelError) return { ok: false, code: e.code, message: e.message, iso };
	const message = e instanceof Error ? e.message : String(e);
	// an allocation failure or an interpreter that died means the lane itself is suspect
	const environment =
		e instanceof RangeError || /out of memory|memory limit|could not allocate/i.test(message);
	return { ok: false, code: 'burrow.parallel.slice_failed', message, environment, iso };
}

/**
 * Serves one request addressed to a lane: a slice, a health probe, a prepare, or a whole job when
 * this object is acting as a coordinator.
 *
 * Exported so an existing Durable Object class, such as a replica that already holds the data a
 * slice needs, can serve slices without becoming a second class. {@link defineLane} is a thin
 * wrapper over it.
 *
 * @since 1.1.0
 */
export async function handleLaneRequest(
	state: DurableObjectState,
	env: unknown,
	request: Request,
	config: LaneConfig
): Promise<Response> {
	const objectId = state.id.toString();
	const url = new URL(request.url);
	const lane = url.searchParams.get('name') ?? objectId;
	const iso = isolate(config, objectId, lane);
	const op = url.pathname.slice(1);

	if (op === 'health') {
		return Response.json({
			iso,
			objectId,
			lane,
			tags: { ...(await tagsOf(state)), ...warmTags(objectId) }
		});
	}
	if (op === 'prepare') {
		const { want } = (await request.json()) as { want: StateTags };
		// in the lane's slot, so no slice runs while its state changes underneath it
		return withSlot(objectId, async () => {
			const have = await tagsOf(state);
			if (satisfies(have, want)) return Response.json({ tags: have });
			if (!config.prepare) {
				return Response.json(
					failure(
						new ParallelError(
							'this lane has no prepare() hook, so it cannot satisfy requires',
							'burrow.parallel.stale_state'
						),
						iso
					)
				);
			}
			try {
				const next = await config.prepare(
					{ lane, env, storage: state.storage },
					have,
					want
				);
				await state.storage.put('burrow:tags', next);
				disposeSessions(objectId);
				return Response.json({ tags: next });
			} catch (e) {
				return Response.json({ ...failure(e, iso), code: 'burrow.parallel.stale_state' });
			}
		});
	}
	if (op === 'coordinate') {
		const { desc, payload } = decodeFrame<JobDesc>(new Uint8Array(await request.arrayBuffer()));
		const ns = (env as Record<string, DurableObjectNamespace>)[desc.binding];
		if (!ns) return new Response(`no namespace bound as ${desc.binding}`, { status: 500 });
		const out = new IdentityTransformStream();
		const writer = out.writable.getWriter();
		// a caller that cancels its stream makes the next write fail, and that stops the job here too
		const stop = new AbortController();
		const write = (bytes: Uint8Array) => writer.write(bytes).catch(() => stop.abort());
		// results are streamed back as they are accepted, so the caller can commit and stage early
		const done = runJob(
			desc,
			payload,
			laneTransport(ns),
			{
				accept: (sliceId, laneId, attempts, frame) =>
					write(
						encodeRecord(
							encodeFrame(
								{
									event: 'accept',
									sliceId,
									lane: laneId,
									attempts,
									result: frame.desc
								},
								frame.payload
							)
						)
					),
				fail: (sliceId, reason) =>
					write(encodeRecord(encodeFrame({ event: 'fail', sliceId, reason }))),
				retire: (laneId) =>
					write(encodeRecord(encodeFrame({ event: 'retire', lane: laneId }))),
				learn: (laneId, tags) =>
					write(encodeRecord(encodeFrame({ event: 'tags', lane: laneId, tags })))
			},
			stop.signal
		)
			.then(
				(stats) => write(encodeRecord(encodeFrame({ event: 'done', stats }))),
				(e) => write(encodeRecord(encodeFrame({ event: 'error', message: String(e) })))
			)
			.finally(() => writer.close().catch(() => {}));
		state.waitUntil(done);
		return new Response(out.readable);
	}
	if (op === 'sync' || op.startsWith('chan-')) {
		try {
			if (op === 'sync')
				return await handleSync(state, (await request.json()) as SyncRequest);
			return await handleChannel(
				state,
				op,
				request,
				Number(url.searchParams.get('cap') ?? 64)
			);
		} catch (e) {
			// a platform refusal, such as a spent storage quota, reaches the caller as an answer
			const message = e instanceof Error ? e.message : String(e);
			return Response.json(
				{ ok: false, code: 'burrow.parallel.object_failed', message },
				{ status: 500 }
			);
		}
	}
	if (op !== 'slice') return new Response(`unknown lane operation ${op}`, { status: 404 });

	const { desc, payload } = decodeFrame<SliceDesc>(new Uint8Array(await request.arrayBuffer()));
	const effects: unknown[] = [];
	const have = await tagsOf(state);
	if (!satisfies(have, desc.requires)) {
		const stale = new ParallelError(
			`lane ${lane} holds ${JSON.stringify(have)} and the slice requires ${JSON.stringify(desc.requires)}`,
			'burrow.parallel.stale_state'
		);
		return new Response(encodeFrame({ ...failure(stale, iso), tags: have }));
	}
	try {
		const outcome = await withSlot(objectId, (yielded) => {
			if (desc.kind === 'guest') return runGuest(config, objectId, desc, payload);
			if (desc.kind === 'runtime') return runRuntime(config, objectId, desc, payload);
			const opened: LaneChannel[] = [];
			const ctx = taskContext(state, env, config, lane, desc, effects, yielded, opened);
			// a task's channel endpoints end with the task, so none holds a request open after it
			return runTask(config, ctx, desc, payload).finally(() =>
				Promise.all(opened.map((c) => c.detach()))
			);
		});
		const result: ResultDesc = {
			ok: true,
			kind: outcome.kind,
			number: outcome.number,
			exitCode: outcome.exitCode,
			stderr: outcome.stderr,
			effects,
			iso,
			tags: { ...have, ...warmTags(objectId) }
		};
		return new Response(encodeFrame(result, outcome.bytes));
	} catch (e) {
		return new Response(encodeFrame(failure(e, iso)));
	}
}

function taskContext(
	state: DurableObjectState,
	env: unknown,
	config: LaneConfig,
	lane: string,
	desc: SliceDesc,
	effects: unknown[],
	yielded: Yield,
	opened: LaneChannel[]
): TaskContext {
	const binding = config.binding ?? 'BURROW_LANES';
	const ns = () => {
		const found = (env as Record<string, DurableObjectNamespace | undefined>)[binding];
		if (!found)
			throw new ParallelError(
				`no namespace bound as ${binding}`,
				'burrow.parallel.slice_failed'
			);
		return found;
	};
	const pool = desc.pool ?? { name: 'burrow', size: 1, spares: 0 };
	let children: LanePool | undefined;
	const child = () => (children ??= new LanePool(ns(), { ...pool, binding, coordinator: false }));
	let ops = 0;
	let sends = 0;
	return {
		lane,
		env,
		storage: state.storage,
		effect: (op) => {
			if (desc.effects !== 'capture') {
				throw new ParallelError(
					'ctx.effect() needs a slice run with effects: "capture"',
					'burrow.parallel.impure'
				);
			}
			effects.push(op);
		},
		atomic: (key) =>
			new LaneAtomic(
				laneTransport(ns()),
				`${pool.name}/sync/${key}`,
				() => `${desc.jobId}:${desc.sliceId}:${ops++}`
			),
		mutex: (key) => new LaneMutex(laneTransport(ns()), `${pool.name}/sync/${key}`, yielded),
		channel: (alias) => {
			const ref = desc.channels?.[alias];
			if (!ref) {
				throw new ParallelError(
					`the work passed no channel named ${JSON.stringify(alias)}`,
					'burrow.parallel.slice_failed'
				);
			}
			const channel = new LaneChannel(
				laneTransport(ns()),
				ref.id,
				ref.capacity,
				yielded,
				() => `${desc.jobId}:${desc.sliceId}:${sends++}`
			);
			opened.push(channel);
			return channel;
		},
		spawn: (work) => yielded(() => child().spawn(work).join()),
		map: (work, inputs) => yielded(() => child().map(work, inputs))
	};
}

function warmTags(objectId: string): StateTags {
	const tags: StateTags = {};
	for (const key of sessions.keys()) {
		const [owner, runtime] = key.split('|');
		if (owner === objectId && runtime) tags[`warm:${runtime}`] = true;
	}
	return tags;
}

/** The Durable Object class {@link defineLane} answers, ready to export. */
// oxlint-disable-next-line no-explicit-any
export type LaneClass = new (ctx: DurableObjectState, env: any) => DurableObject<any>;

/**
 * Defines the Durable Object class a consumer exports as its lane.
 *
 * One class serves every role the pool needs: lanes, spares and coordinators are instances of it
 * under separate ids, so a consumer adds one export, one binding and one migration.
 *
 * @example
 * ```ts
 * import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
 * import { defineLane } from '@drupflare/burrow/parallel';
 *
 * export const BurrowLane = defineLane({
 * 	interpreter: wasm3,
 * 	tasks: { checksum: (input) => input.reduce((a, b) => (a + b) >>> 0, 0) }
 * });
 * ```
 *
 * @since 1.1.0
 */
export function defineLane(config: LaneConfig): LaneClass {
	// oxlint-disable-next-line no-explicit-any
	return class BurrowLane extends DurableObject<any> {
		override fetch(request: Request): Promise<Response> {
			return handleLaneRequest(this.ctx, this.env, request, config);
		}
	};
}
