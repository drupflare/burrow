import { ParallelError } from '../errors.js';
import { fromBytes, toBytes } from '../session.js';
import { encodeFrame, encodeRecord, readRecords, type Frame } from './frame.js';
import type { Transport } from './scheduler.js';
import { answerOf } from './sync.js';

/**
 * One message off a {@link LaneChannel}.
 *
 * @since 1.1.0
 */
export interface ChannelMessage {
	readonly bytes: Uint8Array;
	/** the bytes decoded as UTF-8 */
	text(): string;
	/**
	 * The bytes parsed as JSON.
	 *
	 * @throws {SyntaxError} when they are not JSON
	 */
	json<T = unknown>(): T;
}

interface Broker {
	buf: Uint8Array[];
	// message ids from slices, so a retried or hedged sender's repeats are dropped
	seen: Set<string>;
	capacity: number;
	closed: boolean;
	room: Array<() => void>;
	data: Array<() => void>;
}

// the buffer lives in memory: every open endpoint is a pending request, which keeps the broker
// object resident for as long as anyone is attached
const brokers = new Map<string, Promise<Broker>>();

function brokerFor(state: DurableObjectState, capacity: number): Promise<Broker> {
	const id = state.id.toString();
	let broker = brokers.get(id);
	if (!broker) {
		broker = state.storage.get<boolean>('burrow:chan:closed').then((closed) => ({
			buf: [],
			seen: new Set(),
			capacity,
			closed: closed ?? false,
			room: [],
			data: []
		}));
		brokers.set(id, broker);
	}
	return broker;
}

function wake(waiting: Array<() => void>): void {
	for (const w of waiting.splice(0)) w();
}

const closedAnswer = () =>
	Response.json({
		ok: false,
		code: 'burrow.parallel.channel_closed',
		message: 'the channel is closed'
	});

/**
 * Serves a channel op: one long request per sender and per receiver, each a stream of records, so a
 * message costs a write on an open stream rather than a request.
 *
 * @internal
 */
export async function handleChannel(
	state: DurableObjectState,
	op: string,
	request: Request,
	capacity: number
): Promise<Response> {
	const b = await brokerFor(state, capacity);
	if (op === 'chan-push') {
		const body = request.body ?? new ReadableStream();
		for await (const record of readRecords<{ id?: string }>(body)) {
			const id = record.desc.id;
			if (id !== undefined && b.seen.has(id)) continue;
			while (b.buf.length >= b.capacity && !b.closed) {
				await new Promise<void>((r) => b.room.push(r));
			}
			if (b.closed) return closedAnswer();
			if (id !== undefined) b.seen.add(id);
			b.buf.push(record.payload.slice());
			wake(b.data);
		}
		return Response.json({ ok: true });
	}
	if (op === 'chan-pull') {
		const out = new IdentityTransformStream();
		const writer = out.writable.getWriter();
		const pump = async () => {
			for (;;) {
				const message = b.buf.shift();
				if (message) {
					wake(b.room);
					try {
						await writer.write(encodeRecord(encodeFrame({}, message)));
					} catch {
						// the receiver went away; the message goes back to the head of the queue
						b.buf.unshift(message);
						return;
					}
				} else if (b.closed) {
					return writer.close();
				} else {
					await new Promise<void>((r) => b.data.push(r));
				}
			}
		};
		state.waitUntil(pump());
		return new Response(out.readable);
	}
	if (op === 'chan-close') {
		// persisted first, so a refused write leaves the channel open rather than closed in memory only
		await state.storage.put('burrow:chan:closed', true);
		b.closed = true;
		wake(b.data);
		wake(b.room);
		return Response.json({ ok: true });
	}
	return Response.json({ ok: true, buffered: b.buf.length, closed: b.closed });
}

function message(payload: Uint8Array): ChannelMessage {
	const bytes = payload.slice();
	return {
		bytes,
		text: () => fromBytes(bytes),
		json: <T>() => JSON.parse(fromBytes(bytes)) as T
	};
}

/**
 * A bounded queue between lanes, and between lanes and the caller.
 *
 * A broker object holds up to `capacity` messages; a sender waits while it is full and a receiver
 * while it is empty. Several senders and receivers may attach, and each message reaches one
 * receiver. Closing ends iteration for every receiver once the buffer drains, and a closed name
 * stays closed, so a job takes a fresh name for each channel.
 *
 * An open endpoint keeps both it and the broker billed as active, measured for the whole time a
 * channel sat idle, which is why {@link LaneScope.channel} closes its channels with the scope.
 *
 * @example
 * ```ts
 * const ch = pool.channel('frames', { capacity: 64 });
 * await ch.send('first');
 * for await (const m of ch) {
 * 	// each m is one message, as m.bytes, m.text() or m.json()
 * }
 * ```
 *
 * @since 1.1.0
 */
export class LaneChannel implements AsyncIterable<ChannelMessage> {
	private push: {
		writer: WritableStreamDefaultWriter;
		answered: Promise<Response>;
		refused: Promise<never>;
	} | null = null;
	private pull: Promise<AsyncGenerator<Frame>> | null = null;

	/** @internal */
	constructor(
		private readonly transport: Transport,
		/** the broker object's id */
		readonly id: string,
		/** the most messages the broker holds before a sender waits */
		readonly capacity = 64,
		// on a lane, waiting on the channel gives up the lane's slot like any other wait
		private readonly around: <R>(wait: () => Promise<R>) => Promise<R> = (wait) => wait(),
		// numbers a slice's sends the same way on every run of it, so the broker drops repeats
		private readonly nextId?: () => string
	) {}

	private query() {
		return { cap: String(this.capacity) };
	}

	/**
	 * Sends one message, waiting while the channel is full.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.channel_closed` once the channel is closed
	 */
	send(message: string | Uint8Array): Promise<void> {
		return this.around(() => this.write(message));
	}

	private async write(message: string | Uint8Array): Promise<void> {
		if (!this.push) {
			// a push stream accepts writes before the broker has looked at it, so ask first
			if ((await this.size()).closed) {
				throw new ParallelError('the channel is closed', 'burrow.parallel.channel_closed');
			}
			const { readable, writable } = new IdentityTransformStream();
			const answered = this.transport.send(this.id, 'chan-push', readable, this.query());
			const refused = answerOf(this.id, () => answered).then(() => {
				throw new ParallelError('the channel is closed', 'burrow.parallel.channel_closed');
			});
			refused.catch(() => {});
			this.push = { writer: writable.getWriter(), answered, refused };
		}
		const record = encodeRecord(encodeFrame({ id: this.nextId?.() }, toBytes(message)));
		try {
			const written = this.push.writer.write(record);
			// the loser of the race must not surface later as an unhandled rejection
			written.catch(() => {});
			await Promise.race([written, this.push.refused]);
		} catch (e) {
			this.push = null;
			if (e instanceof ParallelError) throw e;
			// a broker that stops reading breaks the stream before its refusal arrives
			throw new ParallelError(
				`the channel stopped accepting messages: ${e instanceof Error ? e.message : String(e)}`,
				'burrow.parallel.channel_closed',
				{ cause: e }
			);
		}
	}

	/**
	 * Sends a value as JSON.
	 *
	 * @throws {ParallelError} with code `burrow.parallel.channel_closed` once the channel is closed
	 */
	sendJson(value: unknown): Promise<void> {
		return this.send(JSON.stringify(value));
	}

	/** the next message, waiting while the channel is empty; `null` once it is closed and drained */
	receive(): Promise<ChannelMessage | null> {
		return this.around(async () => {
			this.pull ??= this.transport
				.send(this.id, 'chan-pull', '', this.query())
				.then((res) => readRecords(res.body ?? new ReadableStream()));
			const next = await (await this.pull).next();
			return next.done ? null : message(next.value.payload);
		});
	}

	async *[Symbol.asyncIterator](): AsyncIterator<ChannelMessage> {
		for (let m = await this.receive(); m; m = await this.receive()) yield m;
	}

	/** how many messages the broker holds, and whether the channel is closed */
	async size(): Promise<{ buffered: number; closed: boolean }> {
		const { buffered, closed } = await answerOf<{
			ok: true;
			buffered: number;
			closed: boolean;
		}>(this.id, () => this.transport.send(this.id, 'chan-size', '', this.query()));
		return { buffered, closed };
	}

	/**
	 * Detaches this endpoint without closing the channel for anyone else.
	 *
	 * A receiver that detaches with messages still in transit loses them.
	 */
	async detach(): Promise<void> {
		const pull = this.pull;
		this.pull = null;
		await this.endPush();
		if (pull) await (await pull).return(undefined);
	}

	/** Closes the channel for every sender and receiver; buffered messages are still delivered. */
	async close(): Promise<void> {
		await this.endPush();
		await answerOf(this.id, () => this.transport.send(this.id, 'chan-close', '', this.query()));
	}

	// the broker answers the push once it has read the last record, so nothing sent is still in
	// transit when a close lands behind it
	private async endPush(): Promise<void> {
		const push = this.push;
		this.push = null;
		if (!push) return;
		await push.writer.close().catch(() => {});
		await push.answered.catch(() => {});
	}
}
