import { ParallelError } from '../errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One message between a caller, a coordinator and a lane: a JSON descriptor plus raw bytes. */
export interface Frame<D = unknown> {
	desc: D;
	payload: Uint8Array;
}

/**
 * Encodes a frame as `u32 descriptor length (little endian), descriptor JSON, payload`.
 *
 * Bytes travel in the body rather than as RPC arguments because concurrent RPC calls carrying byte
 * arguments were measured leaving some calls undelivered; request bodies never did.
 *
 * @internal
 */
export function encodeFrame(desc: unknown, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
	const json = encoder.encode(JSON.stringify(desc));
	const out = new Uint8Array(4 + json.length + payload.length);
	new DataView(out.buffer).setUint32(0, json.length, true);
	out.set(json, 4);
	out.set(payload, 4 + json.length);
	return out;
}

/**
 * The inverse of {@link encodeFrame}.
 *
 * @throws {ParallelError} with code `burrow.parallel.frame_malformed` when the bytes are not a frame
 * @internal
 */
export function decodeFrame<D = unknown>(bytes: Uint8Array): Frame<D> {
	if (bytes.length < 4) throw malformed(`${bytes.length} bytes is shorter than a frame header`);
	const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
	if (4 + length > bytes.length)
		throw malformed(`descriptor claims ${length} bytes, ${bytes.length - 4} present`);
	let desc: D;
	try {
		desc = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length))) as D;
	} catch (cause) {
		throw malformed('descriptor is not JSON', cause);
	}
	return { desc, payload: bytes.subarray(4 + length) };
}

/**
 * Wraps a frame in a `u32` length so several can share one stream.
 *
 * @internal
 */
export function encodeRecord(frame: Uint8Array): Uint8Array {
	const out = new Uint8Array(4 + frame.length);
	new DataView(out.buffer).setUint32(0, frame.length, true);
	out.set(frame, 4);
	return out;
}

/**
 * Reads length-prefixed frames off a stream as they arrive, so a coordinator's results reach the
 * caller one at a time rather than when the whole job ends.
 *
 * @throws {ParallelError} with code `burrow.parallel.frame_malformed` when the stream ends mid-record
 * @internal
 */
export async function* readRecords<D = unknown>(
	stream: ReadableStream<Uint8Array>
): AsyncGenerator<Frame<D>> {
	const reader = stream.getReader();
	let buf = new Uint8Array(0);
	try {
		for (;;) {
			while (buf.length >= 4) {
				const length = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
				if (buf.length < 4 + length) break;
				yield decodeFrame<D>(buf.slice(4, 4 + length));
				buf = buf.slice(4 + length);
			}
			const { value, done } = await reader.read();
			if (done) {
				if (buf.length) {
					throw malformed(
						`stream ended with ${buf.length} bytes of an unfinished record`
					);
				}
				return;
			}
			const next = new Uint8Array(buf.length + value.length);
			next.set(buf);
			next.set(value, buf.length);
			buf = next;
		}
	} finally {
		// a reader that stops early cancels the stream, so the far end sees it go
		reader.cancel().catch(() => {});
	}
}

function malformed(detail: string, cause?: unknown): ParallelError {
	return new ParallelError(`malformed frame: ${detail}`, 'burrow.parallel.frame_malformed', {
		cause
	});
}
