import type { Interpreter, RuntimeFS } from './runtime.js';

/**
 * Adapts emscripten's byte-at-a-time `stdout`/`stderr` into the line sinks a host wants.
 *
 * Every published interpreter build differs here - php-wasm supplies `callMain` and needs a line
 * split, wasmoon's `FS` has no `utime`, quickjs exports no filesystem at all, ruby.wasm's filesystem
 * is a WASI preopen. Without this every consumer rewrites the same three shims.
 *
 * A trailing partial line is flushed when {@link LineSink.flush} is called; `null` and `undefined`
 * bytes are ignored, which is what emscripten passes at EOF.
 *
 * @since 1.0.0
 */
export interface LineSink {
	(byte: number | null | undefined): void;
	/** emits whatever is buffered without a trailing newline */
	flush(): void;
}

/**
 * Builds a byte sink that calls `sink` once per complete line, newline stripped.
 *
 * @example
 * ```ts
 * const out: string[] = [];
 * const stdout = lines((line) => out.push(line));
 * ```
 *
 * @since 1.0.0
 */
export function lines(sink: (line: string) => void): LineSink {
	let buf: number[] = [];
	const decoder = new TextDecoder();
	const emit = () => {
		if (!buf.length) return;
		sink(decoder.decode(new Uint8Array(buf)));
		buf = [];
	};
	const fn = ((byte: number | null | undefined) => {
		if (byte === null || byte === undefined) return;
		// 10 is \n; \r is dropped so a CRLF build does not emit a trailing carriage return
		if (byte === 10) emit();
		else if (byte !== 13) buf.push(byte);
	}) as LineSink;
	fn.flush = emit;
	return fn;
}

/**
 * An in-memory {@link RuntimeFS} for builds that export no filesystem.
 *
 * quickjs-emscripten is the case this exists for: it supplies both `callMain` and its own entry
 * point but no `FS`, so a host that writes a script somewhere has nowhere to write it. Anything the
 * guest actually reads has to be handed to it another way; this only keeps the contract satisfiable.
 *
 * @since 1.0.0
 */
export function memoryFS(): RuntimeFS & { analyzePath(path: string): { exists: boolean } } {
	const files = new Map<string, Uint8Array>();
	const dirs = new Set<string>(['/']);
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	return {
		writeFile(path, data) {
			files.set(path, typeof data === 'string' ? enc.encode(data) : data);
		},
		readFile(path, opts) {
			const b = files.get(path);
			if (!b) throw new Error(`no such file: ${path}`);
			return opts?.encoding ? dec.decode(b) : b;
		},
		mkdir(path) {
			dirs.add(path);
			return undefined;
		},
		analyzePath(path) {
			return { exists: files.has(path) || dirs.has(path) };
		}
	};
}

/**
 * Creates every missing parent of `path`, ignoring directories that already exist.
 *
 * emscripten's `FS.mkdir` throws on an existing directory rather than answering, so every consumer
 * writes this loop.
 *
 * @since 1.0.0
 */
export function mkdirp(fs: RuntimeFS, path: string): void {
	const parts = path.split('/').filter(Boolean);
	let cur = '';
	for (const part of parts) {
		cur += `/${part}`;
		// analyzePath is optional (wasmoon has none), so mkdir is the probe and its throw is the
		// answer; emscripten throws EEXIST on a directory that already exists, which is not a failure
		if (fs.analyzePath?.(cur).exists) continue;
		try {
			fs.mkdir(cur);
		} catch {
			// already there, or the build refuses nested creation; either way keep going
		}
	}
}

/**
 * Reads the linear memory currently backing an interpreter, in bytes, or `null` when the instance
 * does not expose one.
 *
 * The budget uses this to correct a spec's declared figure from observation.
 *
 * @since 1.0.0
 */
export function observedMemory(interpreter: Interpreter): number | null {
	const candidate = interpreter as unknown as {
		wasmMemory?: WebAssembly.Memory;
		HEAPU8?: { buffer?: ArrayBufferLike };
	};
	const fromMemory = candidate.wasmMemory?.buffer?.byteLength;
	if (typeof fromMemory === 'number') return fromMemory;
	const fromHeap = candidate.HEAPU8?.buffer?.byteLength;
	return typeof fromHeap === 'number' ? fromHeap : null;
}
