import { describe, expect, it } from 'vitest';
import { lines, memoryFS, mkdirp, observedMemory } from '../src/adapt.js';
import type { Interpreter } from '../src/runtime.js';

const bytes = (s: string) => [...new TextEncoder().encode(s)];

describe('lines', () => {
	it('emits one line per newline, stripped', () => {
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		for (const b of bytes('ab\ncd\n')) sink(b);
		expect(out).toEqual(['ab', 'cd']);
	});

	it('holds a partial line until flush', () => {
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		for (const b of bytes('partial')) sink(b);
		expect(out).toEqual([]);
		sink.flush();
		expect(out).toEqual(['partial']);
	});

	it('flushing twice does not repeat the line', () => {
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		for (const b of bytes('x')) sink(b);
		sink.flush();
		sink.flush();
		expect(out).toEqual(['x']);
	});

	it('drops carriage returns so a CRLF build does not leak them', () => {
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		for (const b of bytes('ab\r\n')) sink(b);
		expect(out).toEqual(['ab']);
	});

	it('ignores the null and undefined emscripten passes at EOF', () => {
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		sink(null);
		sink(undefined);
		for (const b of bytes('a\n')) sink(b);
		expect(out).toEqual(['a']);
	});

	it('decodes multi-byte utf-8 that straddles the buffer', () => {
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		for (const b of bytes('café\n')) sink(b);
		expect(out).toEqual(['café']);
	});

	it('emits nothing for an empty line rather than an empty string', () => {
		// emscripten calls print() per line; a bare newline carries no content worth forwarding
		const out: string[] = [];
		const sink = lines((l) => out.push(l));
		sink(10);
		expect(out).toEqual([]);
	});
});

describe('memoryFS', () => {
	it('round-trips bytes and text', () => {
		const fs = memoryFS();
		fs.writeFile('/a.txt', 'hello');
		expect(fs.readFile('/a.txt', { encoding: 'utf8' })).toBe('hello');
		expect(fs.readFile('/a.txt')).toBeInstanceOf(Uint8Array);
	});

	it('reports existence for files and directories', () => {
		const fs = memoryFS();
		expect(fs.analyzePath('/nope').exists).toBe(false);
		fs.mkdir('/dir');
		expect(fs.analyzePath('/dir').exists).toBe(true);
		fs.writeFile('/dir/f', new Uint8Array([1]));
		expect(fs.analyzePath('/dir/f').exists).toBe(true);
	});

	it('throws on a missing read', () => {
		expect(() => memoryFS().readFile('/ghost')).toThrow('no such file');
	});
});

describe('mkdirp', () => {
	it('creates every missing parent', () => {
		const fs = memoryFS();
		mkdirp(fs, '/a/b/c');
		expect(fs.analyzePath('/a').exists).toBe(true);
		expect(fs.analyzePath('/a/b').exists).toBe(true);
		expect(fs.analyzePath('/a/b/c').exists).toBe(true);
	});

	it('is idempotent, and survives an FS that throws on an existing directory', () => {
		const fs = memoryFS();
		const throwing = {
			...fs,
			mkdir: () => {
				throw new Error('EEXIST');
			}
		};
		mkdirp(fs, '/a/b');
		expect(() => mkdirp(fs, '/a/b')).not.toThrow();
		expect(() => mkdirp(throwing, '/x/y')).not.toThrow();
	});
});

describe('observedMemory', () => {
	const base: Interpreter = { FS: memoryFS(), callMain: () => 0 };

	it('reads a wasmMemory buffer', () => {
		const i = {
			...base,
			wasmMemory: { buffer: { byteLength: 4096 } }
		} as unknown as Interpreter;
		expect(observedMemory(i)).toBe(4096);
	});

	it('falls back to the emscripten heap view', () => {
		const i = { ...base, HEAPU8: { buffer: { byteLength: 8192 } } } as unknown as Interpreter;
		expect(observedMemory(i)).toBe(8192);
	});

	it('answers null when the instance exposes neither', () => {
		expect(observedMemory(base)).toBeNull();
	});
});
