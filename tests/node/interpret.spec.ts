import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { InterpretError } from '../../src/errors.js';
import { createInterpreter, DEFAULT_STACK_BYTES } from '../../src/interpret.js';

/**
 * The interpreter, driven against real guest modules.
 *
 * In the node lane rather than the workers one because it reads the vendored binary off disk. What
 * it proves is the contract: a guest arrives as bytes, is never handed to the host engine, and
 * still runs. Absolute timings belong to `burrow probe` on a deploy, never to a spec.
 */

const HERE = import.meta.url;

/** hand-assembled so the test does not depend on a toolchain being installed */
function wat(body: string): Promise<Uint8Array> {
	return import('node:child_process').then(({ execFileSync }) => {
		const { mkdtempSync, writeFileSync, readFileSync } =
			require('node:fs') as typeof import('node:fs');
		const { tmpdir } = require('node:os') as typeof import('node:os');
		const { join } = require('node:path') as typeof import('node:path');
		const dir = mkdtempSync(join(tmpdir(), 'burrow-wat-'));
		const watPath = join(dir, 'm.wat');
		const wasmPath = join(dir, 'm.wasm');
		writeFileSync(watPath, body);
		execFileSync('wat2wasm', [watPath, '-o', wasmPath]);
		return new Uint8Array(readFileSync(wasmPath));
	});
}

const ADDER = `(module
  (func (export "add") (param i32 i32) (result i32) (i32.add (local.get 0) (local.get 1)))
  (func (export "answer") (result i32) (i32.const 42))
  (memory (export "memory") 1)
  (data (i32.const 16) "burrow")
)`;

const IMPORTER = `(module
  (import "host" "double" (func $double (param i32) (result i32)))
  (import "host" "note" (func $note (param i32)))
  (func (export "twice") (param i32) (result i32) (call $double (local.get 0)))
  (func (export "tell") (param i32) (call $note (local.get 0)))
  (memory (export "memory") 1)
)`;

let module: WebAssembly.Module;

beforeAll(async () => {
	// workers-types declares WebAssembly.Module abstract, so the constructor is re-declared here
	const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
	module = new Module(await readFile(new URL('../../src/vendor/wasm3.wasm', HERE).pathname));
});

/** a fresh runtime per test: one interpreter holds one wasm3 runtime, and guests in it share state */
const fresh = () => createInterpreter({ module });

describe('createInterpreter', () => {
	it('starts with a usable memory and a default stack', async () => {
		const vm = await fresh();
		expect(vm.memoryBytes).toBeGreaterThan(0);
		expect(DEFAULT_STACK_BYTES).toBe(8 * 1024 * 1024);
	});
});

describe('a loaded guest', () => {
	it('runs a function the host never compiled', async () => {
		const guest = (await fresh()).load(await wat(ADDER));
		expect(guest.call('answer')).toBe(42);
		expect(guest.call('add', 20, 22)).toBe(42);
	});

	it('reports which exports exist', async () => {
		const guest = (await fresh()).load(await wat(ADDER));
		expect(guest.has('add')).toBe(true);
		expect(guest.has('nope')).toBe(false);
	});

	it('throws a coded error for a missing export', async () => {
		const guest = (await fresh()).load(await wat(ADDER));
		expect(() => guest.call('nope')).toThrow(InterpretError);
		try {
			guest.call('nope');
		} catch (e) {
			expect((e as InterpretError).code).toBe('burrow.interpret.trap');
		}
	});

	it('reads the guest data section out of guest memory', async () => {
		const guest = (await fresh()).load(await wat(ADDER));
		expect(guest.readText(16, 6)).toBe('burrow');
	});

	it('round-trips bytes through guest memory', async () => {
		const guest = (await fresh()).load(await wat(ADDER));
		guest.write(64, 'written by the host');
		expect(guest.readText(64)).toBe('written by the host');
		expect(guest.read(64, 7)).toEqual(new TextEncoder().encode('written'));
	});

	it('exposes a view over guest memory sized to the guest, not the interpreter', async () => {
		const guest = (await fresh()).load(await wat(ADDER));
		// one declared page
		expect(guest.memory().length).toBe(65536);
	});
});

describe('host imports', () => {
	it('calls back into JavaScript and returns a value', async () => {
		const guest = (await fresh()).load(await wat(IMPORTER), {
			imports: {
				host: {
					double: { signature: 'i(i)', fn: (n) => (n ?? 0) * 2 },
					note: { signature: 'v(i)', fn: () => undefined }
				}
			}
		});
		expect(guest.call('twice', 21)).toBe(42);
	});

	it('routes a void import without expecting a result', async () => {
		const seen: number[] = [];
		const guest = (await fresh()).load(await wat(IMPORTER), {
			imports: {
				host: {
					double: { signature: 'i(i)', fn: (n) => n ?? 0 },
					note: { signature: 'v(i)', fn: (n) => void seen.push(n ?? 0) }
				}
			}
		});
		guest.call('tell', 7);
		expect(seen).toEqual([7]);
	});

	it('fails the link with a coded error when a signature is wrong', async () => {
		const vm = await fresh();
		const bytes = await wat(IMPORTER);
		expect(() =>
			vm.load(bytes, {
				imports: { host: { double: { signature: 'not a signature', fn: () => 0 } } }
			})
		).toThrow(InterpretError);
	});

	it('turns a throwing host function into a guest trap rather than a silent zero', async () => {
		const guest = (await fresh()).load(await wat(IMPORTER), {
			imports: {
				host: {
					double: {
						signature: 'i(i)',
						fn: () => {
							throw new Error('host refused');
						}
					},
					note: { signature: 'v(i)', fn: () => undefined }
				}
			}
		});
		expect(() => guest.call('twice', 1)).toThrow(InterpretError);
	});
});

describe('load failures', () => {
	it('rejects bytes that are not wasm', async () => {
		const vm = await fresh();
		expect(() => vm.load(new Uint8Array([1, 2, 3, 4]))).toThrow(InterpretError);
		try {
			vm.load(new Uint8Array([1, 2, 3, 4]));
		} catch (e) {
			expect((e as InterpretError).code).toBe('burrow.interpret.load_failed');
		}
	});
});
