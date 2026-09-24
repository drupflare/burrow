import { ParallelError } from '../errors.js';
import type { Transport } from './scheduler.js';

/** @internal one request to a sync object */
export interface SyncRequest {
	kind: 'atomic' | 'lock';
	action: string;
	/** `(job, slice, n)` for an atomic op from a slice, so a repeat of that op is answered, not applied */
	opId?: string;
	value?: number;
	expected?: number;
	token?: number;
	key?: string;
	data?: unknown;
	ttlMs?: number;
	timeoutMs?: number;
}

type SyncAnswer =
	| { ok: true; value?: number; token?: number; expires?: number; data?: unknown }
	| { ok: false; code: ParallelError['code']; message: string };

// an op id is kept long enough to answer any hedge or retry of its slice
const OP_RETENTION_MS = 60 * 60 * 1000;

interface Waiter {
	ttlMs: number;
	grant: (answer: SyncAnswer) => void;
}

// waiters are pending requests, and a pending request keeps its object in memory, so a queue here
// cannot outlive the requests it holds
const waiters = new Map<string, Waiter[]>();
const expiry = new Map<string, ReturnType<typeof setTimeout>>();

function tables(sql: SqlStorage): void {
	sql.exec('CREATE TABLE IF NOT EXISTS burrow_sync (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
	sql.exec(
		'CREATE TABLE IF NOT EXISTS burrow_ops (id TEXT PRIMARY KEY, answer REAL NOT NULL, at INTEGER NOT NULL)'
	);
	sql.exec('CREATE INDEX IF NOT EXISTS burrow_ops_at ON burrow_ops (at)');
}

function get<T>(sql: SqlStorage, k: string): T | undefined {
	const row = sql.exec<{ v: string }>('SELECT v FROM burrow_sync WHERE k = ?', k).toArray()[0];
	return row ? (JSON.parse(row.v) as T) : undefined;
}

function put(sql: SqlStorage, k: string, v: unknown): void {
	sql.exec('INSERT OR REPLACE INTO burrow_sync (k, v) VALUES (?, ?)', k, JSON.stringify(v));
}

function atomic(sql: SqlStorage, req: SyncRequest): SyncAnswer {
	if (req.opId) {
		const seen = sql
			.exec<{ answer: number }>('SELECT answer FROM burrow_ops WHERE id = ?', req.opId)
			.toArray()[0];
		if (seen) return { ok: true, value: seen.answer };
	}
	const current = get<number>(sql, 'atomic') ?? 0;
	let next = current;
	switch (req.action) {
		case 'load':
			return { ok: true, value: current };
		case 'store':
			next = req.value ?? 0;
			break;
		case 'add':
			next = current + (req.value ?? 0);
			break;
		case 'compareExchange':
			if (current === req.expected) next = req.value ?? 0;
			break;
		default:
			return refuse('burrow.parallel.frame_malformed', `unknown atomic action ${req.action}`);
	}
	put(sql, 'atomic', next);
	// Atomics answers the previous value for add and compareExchange, and the stored one for store
	const answer = req.action === 'store' ? next : current;
	if (req.opId) {
		const now = Date.now();
		sql.exec('INSERT INTO burrow_ops (id, answer, at) VALUES (?, ?, ?)', req.opId, answer, now);
		sql.exec('DELETE FROM burrow_ops WHERE at < ?', now - OP_RETENTION_MS);
	}
	return { ok: true, value: answer };
}

interface Holder {
	token: number;
	expires: number;
}

function grant(sql: SqlStorage, objectId: string, ttlMs: number): SyncAnswer {
	const token = (get<number>(sql, 'token') ?? 0) + 1;
	const expires = Date.now() + ttlMs;
	put(sql, 'token', token);
	put(sql, 'holder', { token, expires } satisfies Holder);
	arm(sql, objectId, { token, expires });
	return { ok: true, token, expires };
}

// a holder that never releases loses the lock at its expiry, and the next waiter is granted
function arm(sql: SqlStorage, objectId: string, holder: Holder): void {
	clearTimeout(expiry.get(objectId));
	const timer = setTimeout(
		() => {
			expiry.delete(objectId);
			if (get<Holder>(sql, 'holder')?.token === holder.token) handOff(sql, objectId);
		},
		Math.max(0, holder.expires - Date.now())
	);
	expiry.set(objectId, timer);
}

function handOff(sql: SqlStorage, objectId: string): void {
	put(sql, 'holder', null);
	clearTimeout(expiry.get(objectId));
	expiry.delete(objectId);
	const next = waiters.get(objectId)?.shift();
	if (next) next.grant(grant(sql, objectId, next.ttlMs));
}

function held(sql: SqlStorage, token: number | undefined): Holder | null {
	const holder = get<Holder | null>(sql, 'holder');
	return holder && holder.token === token && holder.expires > Date.now() ? holder : null;
}

async function lock(sql: SqlStorage, objectId: string, req: SyncRequest): Promise<SyncAnswer> {
	const lost = () =>
		refuse('burrow.parallel.lock_lost', `lease ${req.token} is no longer the lock's holder`);
	switch (req.action) {
		case 'acquire': {
			const ttlMs = req.ttlMs ?? 10_000;
			const holder = get<Holder | null>(sql, 'holder');
			const queue = waiters.get(objectId) ?? [];
			waiters.set(objectId, queue);
			if ((!holder || holder.expires <= Date.now()) && !queue.length) {
				return grant(sql, objectId, ttlMs);
			}
			// the holder may have been granted before this object last left memory, with no timer
			if (holder && !expiry.has(objectId)) arm(sql, objectId, holder);
			return new Promise<SyncAnswer>((resolve) => {
				const waiter: Waiter = {
					ttlMs,
					grant: (answer) => {
						clearTimeout(timer);
						resolve(answer);
					}
				};
				const timer = setTimeout(() => {
					queue.splice(queue.indexOf(waiter), 1);
					resolve(
						refuse(
							'burrow.parallel.lock_timeout',
							`no grant within ${req.timeoutMs} ms`
						)
					);
				}, req.timeoutMs ?? 30_000);
				queue.push(waiter);
			});
		}
		case 'release':
			if (!held(sql, req.token)) return lost();
			handOff(sql, objectId);
			return { ok: true };
		case 'read':
			if (!held(sql, req.token)) return lost();
			return { ok: true, data: get(sql, `fence:${req.key}`) };
		case 'write':
			if (!held(sql, req.token)) return lost();
			put(sql, `fence:${req.key}`, req.data ?? null);
			return { ok: true };
		default:
			return refuse('burrow.parallel.frame_malformed', `unknown lock action ${req.action}`);
	}
}

function refuse(code: ParallelError['code'], message: string): SyncAnswer {
	return { ok: false, code, message };
}

/**
 * Serves a sync op. The object's input gate keeps every op linearizable, because nothing between
 * reading and writing its state awaits anything but its own storage.
 *
 * @internal
 */
export async function handleSync(state: DurableObjectState, req: SyncRequest): Promise<Response> {
	const sql = state.storage.sql;
	tables(sql);
	const answer =
		req.kind === 'atomic' ? atomic(sql, req) : await lock(sql, state.id.toString(), req);
	return Response.json(answer);
}

/** @internal sends one op to a sync object and throws what it refused */
export async function syncCall(
	transport: Transport,
	object: string,
	req: SyncRequest
): Promise<Extract<SyncAnswer, { ok: true }>> {
	return answerOf(object, () => transport.send(object, 'sync', JSON.stringify(req)));
}

/**
 * Reads an object's JSON answer, turning a refusal into its error and anything that is not an
 * answer at all into `burrow.parallel.object_failed`.
 *
 * @internal
 */
export async function answerOf<T extends { ok: true }>(
	object: string,
	send: () => Promise<Response>
): Promise<T> {
	let answer: T | { ok: false; code: ParallelError['code']; message: string };
	try {
		const res = await send();
		const text = await res.text();
		answer = JSON.parse(text) as typeof answer;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new ParallelError(`${object} failed: ${message}`, 'burrow.parallel.object_failed', {
			cause: e
		});
	}
	if (!answer.ok) throw new ParallelError(answer.message, answer.code);
	return answer;
}

/**
 * A number shared by every lane, with the operations of `Atomics`.
 *
 * Every op from inside a slice carries that slice's `(job, slice)` identity, so a hedged or retried
 * slice that repeats an op is answered what the first run got instead of applying it again. From
 * the caller, where nothing is hedged, ops apply as sent.
 *
 * @example
 * ```ts
 * const hits = pool.atomic('hits');
 * await hits.add(1);
 * ```
 *
 * @since 1.1.0
 */
export class LaneAtomic {
	/** @internal */
	constructor(
		private readonly transport: Transport,
		/** the sync object's id */
		readonly id: string,
		// numbers the ops of one slice in order, the same way on every run of it
		private readonly nextOp?: () => string
	) {}

	private op(action: string, value?: number, expected?: number): Promise<number> {
		const opId = this.nextOp && action !== 'load' ? this.nextOp() : undefined;
		return syncCall(this.transport, this.id, {
			kind: 'atomic',
			action,
			value,
			expected,
			opId
		}).then((a) => a.value ?? 0);
	}

	/** the current value */
	load(): Promise<number> {
		return this.op('load');
	}

	/** sets the value and answers it */
	store(value: number): Promise<number> {
		return this.op('store', value);
	}

	/** adds and answers the value from before the add */
	add(value: number): Promise<number> {
		return this.op('add', value);
	}

	/** sets `value` only if the current value is `expected`; answers the value from before */
	compareExchange(expected: number, value: number): Promise<number> {
		return this.op('compareExchange', value, expected);
	}
}

/** Options for {@link LaneMutex.acquire}. */
export interface AcquireOptions {
	/** how long the lease lasts before the lock is taken from a holder that never released; 10 s */
	ttlMs?: number;
	/** how long to wait for a grant before failing with `burrow.parallel.lock_timeout`; 30 s */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * A lock shared by every lane, granted as an expiring lease with a fencing token.
 *
 * A lock is a serial point: measured at about 40 ms per acquire and release and 17-21 critical
 * sections a second whatever the lane count, so keep it for correctness boundaries and use
 * {@link LaneAtomic} for counting.
 *
 * State the lock protects belongs in the lease ({@link LaneLease.read} and
 * {@link LaneLease.write}), which checks the lock's current token on every call. A separate
 * resource that only compares tokens it has already seen was measured accepting a dead holder's
 * write 5 of 5 times, before the new holder had written.
 *
 * @since 1.1.0
 */
export class LaneMutex {
	/** @internal */
	constructor(
		private readonly transport: Transport,
		/** the sync object's id */
		readonly id: string,
		// on a lane, waiting for the lock gives up the lane's slot like any other wait
		private readonly around: <R>(wait: () => Promise<R>) => Promise<R> = (wait) => wait()
	) {}

	/**
	 * Waits for the lock, first come first served.
	 *
	 * @throws {ParallelError} `burrow.parallel.lock_timeout` when no grant came in time, or
	 * `burrow.parallel.cancelled` when the signal aborted first
	 */
	async acquire(options: AcquireOptions = {}): Promise<LaneLease> {
		const cancelled = () =>
			new ParallelError('the acquire was cancelled', 'burrow.parallel.cancelled');
		if (options.signal?.aborted) throw cancelled();
		const pending = this.around(() =>
			syncCall(this.transport, this.id, {
				kind: 'lock',
				action: 'acquire',
				ttlMs: options.ttlMs,
				timeoutMs: options.timeoutMs
			})
		);
		const signal = options.signal;
		if (!signal) return this.lease(await pending);
		return new Promise<LaneLease>((resolve, reject) => {
			const abort = () => {
				reject(cancelled());
				// a grant that lands after the abort is handed straight back
				pending.then((a) => this.lease(a).release()).catch(() => {});
			};
			signal.addEventListener('abort', abort, { once: true });
			pending.then(
				(a) => {
					signal.removeEventListener('abort', abort);
					resolve(this.lease(a));
				},
				(e: unknown) => {
					signal.removeEventListener('abort', abort);
					reject(e);
				}
			);
		});
	}

	private lease(answer: { token?: number; expires?: number }): LaneLease {
		return new LaneLease(this.transport, this.id, answer.token ?? 0, answer.expires ?? 0);
	}
}

/**
 * A held lock. Disposing it releases the lock.
 *
 * @since 1.1.0
 */
export class LaneLease implements AsyncDisposable {
	/** @internal */
	constructor(
		private readonly transport: Transport,
		private readonly id: string,
		/** the fencing token; every grant's is larger than the last */
		readonly token: number,
		/** when the lease lapses, in epoch milliseconds */
		readonly expires: number
	) {}

	private call(action: string, key?: string, data?: unknown) {
		return syncCall(this.transport, this.id, {
			kind: 'lock',
			action,
			token: this.token,
			key,
			data
		});
	}

	/**
	 * Reads state the lock protects.
	 *
	 * @throws {ParallelError} `burrow.parallel.lock_lost` once the lease is no longer the holder
	 */
	async read<T = unknown>(key: string): Promise<T | undefined> {
		return (await this.call('read', key)).data as T | undefined;
	}

	/**
	 * Writes state the lock protects, refused unless this lease is the current holder.
	 *
	 * @throws {ParallelError} `burrow.parallel.lock_lost` once the lease is no longer the holder
	 */
	async write(key: string, value: unknown): Promise<void> {
		await this.call('write', key, value);
	}

	/**
	 * Releases the lock to the next waiter.
	 *
	 * @throws {ParallelError} `burrow.parallel.lock_lost` when the lease had already lapsed
	 */
	async release(): Promise<void> {
		await this.call('release');
	}

	async [Symbol.asyncDispose](): Promise<void> {
		// a lapsed lease has nothing left to release
		await this.release().catch((e: unknown) => {
			if (!(e instanceof ParallelError && e.code === 'burrow.parallel.lock_lost')) throw e;
		});
	}
}
