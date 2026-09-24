import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { InterpretError } from '../../src/errors.js';
import { createInterpreter, DEFAULT_STACK_BYTES } from '../../src/interpret.js';
import {
	DATA,
	DATA_WAT,
	IMPURE,
	IMPURE_WAT,
	RANGE,
	RANGE_TOTAL,
	RANGE_WAT
} from '../fixtures/guests.js';
import { wat } from './wat.js';

/**
 * The interpreter, driven against real guest modules.
 *
 * In the node lane rather than the workers one because it reads the vendored binary off disk. What
 * it proves is the contract: a guest arrives as bytes, is never handed to the host engine, and
 * still runs. Absolute timings belong to `burrow probe` on a deploy, never to a spec.
 */

const HERE = import.meta.url;

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
		const guest = (await fresh()).load(wat(ADDER));
		expect(guest.call('answer')).toBe(42);
		expect(guest.call('add', 20, 22)).toBe(42);
	});

	it('reports which exports exist', async () => {
		const guest = (await fresh()).load(wat(ADDER));
		expect(guest.has('add')).toBe(true);
		expect(guest.has('nope')).toBe(false);
	});

	it('throws a coded error for a missing export', async () => {
		const guest = (await fresh()).load(wat(ADDER));
		expect(() => guest.call('nope')).toThrow(InterpretError);
		try {
			guest.call('nope');
		} catch (e) {
			expect((e as InterpretError).code).toBe('burrow.interpret.trap');
		}
	});

	it('reads the guest data section out of guest memory', async () => {
		const guest = (await fresh()).load(wat(ADDER));
		expect(guest.readText(16, 6)).toBe('burrow');
	});

	it('round-trips bytes through guest memory', async () => {
		const guest = (await fresh()).load(wat(ADDER));
		guest.write(64, 'written by the host');
		expect(guest.readText(64)).toBe('written by the host');
		expect(guest.read(64, 7)).toEqual(new TextEncoder().encode('written'));
	});

	it('exposes a view over guest memory sized to the guest, not the interpreter', async () => {
		const guest = (await fresh()).load(wat(ADDER));
		// one declared page
		expect(guest.memory().length).toBe(65536);
	});
});

describe('host imports', () => {
	it('calls back into JavaScript and returns a value', async () => {
		const guest = (await fresh()).load(wat(IMPORTER), {
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
		const guest = (await fresh()).load(wat(IMPORTER), {
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
		const bytes = wat(IMPORTER);
		expect(() =>
			vm.load(bytes, {
				imports: { host: { double: { signature: 'not a signature', fn: () => 0 } } }
			})
		).toThrow(InterpretError);
	});

	it('turns a throwing host function into a guest trap rather than a silent zero', async () => {
		const guest = (await fresh()).load(wat(IMPORTER), {
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

	it('refuses a SIMD guest at load, naming SIMD rather than trapping later', async () => {
		const vm = await fresh();
		// a v128 local is what toolchain output declares, and it is what the check reads; wasm3
		// compiles lazily, so without this the guest loads and the first call dies with "unknown
		// label", which says nothing about why
		const simd = wat(`(module
		  (memory 1)
		  (func (export "f") (result i32)
		    (local $v v128)
		    (local.set $v (i32x4.add (v128.const i32x4 1 2 3 4) (v128.const i32x4 10 20 30 40)))
		    (v128.store (i32.const 0) (local.get $v))
		    (i32.load (i32.const 0))))`);
		try {
			vm.load(simd);
			expect.unreachable('a guest the interpreter cannot execute must not load');
		} catch (e) {
			expect((e as InterpretError).code).toBe('burrow.interpret.unsupported');
			expect((e as InterpretError).message).toContain('SIMD');
		}
	});
});

describe('the memory ceiling', () => {
	const PAGE = 65536;
	const GROWER = `(module
	  (memory (export "m") 1)
	  (func (export "grow") (param i32) (result i32) (memory.grow (local.get 0)))
	  (func (export "poke") (param i32) (result i32)
	    (i32.store (local.get 0) (i32.const 7))
	    (i32.load (local.get 0))))`;

	it('lets a guest grow freely when no ceiling is set', async () => {
		const vm = await createInterpreter({ module });
		const guest = vm.load(wat(GROWER));
		expect(guest.call('grow', 16)).toBe(1);
		expect(guest.call('poke', 17 * PAGE - 4)).toBe(7);
	});

	it('stops backing memory past the ceiling, and the access is what fails', async () => {
		const vm = await createInterpreter({ module, maxMemoryBytes: 4 * PAGE });
		const guest = vm.load(wat(GROWER));

		// wasm3 clamps rather than refusing, so the guest is told the growth succeeded
		expect(guest.call('grow', 16)).toBe(1);
		// and learns otherwise at the first access past what was actually allocated
		expect(() => guest.call('poke', 17 * PAGE - 4)).toThrow(InterpretError);
		// memory inside the ceiling still works, so the cap bounds rather than breaks the guest
		expect(guest.call('poke', 2 * PAGE)).toBe(7);
	});
});

/**
 * The vendored wasm3 carries a patch that folds a loop's affine induction update into its back edge,
 * so loop compilation is no longer stock and a miscompile here would be silent and guest-specific.
 *
 * V8 is the oracle rather than a hand-computed constant: the same bytes run both ways and the answers
 * have to agree. That catches a wrong fold without anyone predicting what wrong would look like.
 */
describe('loops, against V8 running the same bytes', () => {
	const LOOPS = `(module
	  (func (export "counted") (param $n i32) (result i32)
	    (local $i i32) (local $acc i32)
	    (block $done (loop $l
	      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
	      (local.set $acc (i32.add (local.get $acc) (local.get $i)))
	      (local.set $i (i32.add (local.get $i) (i32.const 1)))
	      (br $l)))
	    (local.get $acc))
	  (func (export "readAfter") (param $n i32) (result i32)
	    (local $i i32)
	    (block $done (loop $l
	      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
	      (local.set $i (i32.add (local.get $i) (i32.const 3)))
	      (br $l)))
	    (local.get $i))
	  (func (export "varyingStride") (param $n i32) (result i32)
	    (local $i i32) (local $step i32)
	    (local.set $step (i32.const 1))
	    (block $done (loop $l
	      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
	      (local.set $i (i32.add (local.get $i) (local.get $step)))
	      (local.set $step (i32.add (local.get $step) (i32.const 1)))
	      (br $l)))
	    (local.get $i))
	  (func (export "earlyExit") (param $n i32) (result i32)
	    (local $i i32)
	    (block $done (loop $l
	      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
	      (br_if $done (i32.eq (local.get $i) (i32.const 7)))
	      (local.set $i (i32.add (local.get $i) (i32.const 1)))
	      (br $l)))
	    (local.get $i))
	  (func (export "bodyWritesInduction") (param $n i32) (result i32)
	    (local $i i32) (local $acc i32)
	    (block $done (loop $l
	      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
	      (if (i32.eq (i32.rem_s (local.get $i) (i32.const 5)) (i32.const 0))
	        (then (local.set $i (i32.add (local.get $i) (i32.const 2)))))
	      (local.set $acc (i32.add (local.get $acc) (local.get $i)))
	      (local.set $i (i32.add (local.get $i) (i32.const 1)))
	      (br $l)))
	    (local.get $acc))
	  (func (export "nestedSharing") (param $n i32) (result i32)
	    (local $i i32) (local $j i32) (local $acc i32)
	    (block $outer (loop $ol
	      (br_if $outer (i32.ge_s (local.get $i) (local.get $n)))
	      (local.set $j (local.get $i))
	      (block $inner (loop $il
	        (br_if $inner (i32.ge_s (local.get $j) (local.get $n)))
	        (local.set $acc (i32.add (local.get $acc) (i32.const 1)))
	        (local.set $j (i32.add (local.get $j) (i32.const 1)))
	        (br $il)))
	      (local.set $i (i32.add (local.get $i) (i32.const 1)))
	      (br $ol)))
	    (local.get $acc))
	)`;

	const SHAPES = [
		'counted',
		'readAfter',
		'varyingStride',
		'earlyExit',
		'bodyWritesInduction',
		'nestedSharing'
	] as const;
	// zero and one exercise the loop that never runs and the one that runs once, where a fold that
	// updates before testing goes wrong first
	const ARGS = [0, 1, 2, 7, 33, 100];

	it('answers what V8 answers, on every shape and argument', async () => {
		const bytes = wat(LOOPS);
		const Module = WebAssembly.Module as unknown as new (b: BufferSource) => WebAssembly.Module;
		const native = (await WebAssembly.instantiate(new Module(bytes), {}))
			.exports as unknown as Record<(typeof SHAPES)[number], (n: number) => number>;
		const vm = await fresh();
		const guest = vm.load(bytes);

		// an oracle test agrees when both sides return nothing, so anchor one answer absolutely
		expect(guest.call('counted', 100)).toBe(4950);
		// and the interpreter must actually be fusing, or this compares two unfused paths
		expect(vm.fusedSequences).toBeGreaterThan(0);

		for (const shape of SHAPES) {
			for (const n of ARGS) {
				expect([shape, n, guest.call(shape, n)]).toEqual([shape, n, native[shape](n)]);
			}
		}
	});
});

/**
 * Every entry point answers a negative return code from the shim with a coded error rather than a
 * bare throw or a silent wrong answer. A module index the shim has never issued reaches all of them
 * through one door, since `at()` rejects it.
 */
describe('a module index the interpreter never issued', () => {
	const ABSENT = 999;

	it('is refused by every entry point that takes one', async () => {
		const vm = await fresh();
		const attempts: [string, () => unknown][] = [
			['instantiate', () => vm.instantiate(ABSENT)],
			['nameModule', () => vm.nameModule(ABSENT, 'env')],
			['runStart', () => vm.runStart(ABSENT)],
			['unload', () => vm.unload(ABSENT)],
			['growMemory', () => vm.growMemory(ABSENT, 1)],
			['growTable', () => vm.growTable(ABSENT, 1)],
			['tableSizeThenPut', () => vm.tablePut(ABSENT, 0, ABSENT, 'f')],
			['tableClear', () => vm.tableClear(ABSENT, 0, 1)],
			['linkGlobal', () => vm.linkGlobal(ABSENT, 'env', 'g', 1)],
			[
				'linkFunction',
				() => vm.linkFunction(ABSENT, 'env', 'f', { signature: 'v()', fn: () => 0 })
			],
			[
				'reserveImport',
				() => vm.reserveImport(ABSENT, 'env', 'f', { signature: 'v()', fn: () => 0 })
			]
		];

		for (const [name, attempt] of attempts) {
			try {
				attempt();
				expect.unreachable(`${name} accepted a module index that does not exist`);
			} catch (e) {
				expect(e, name).toBeInstanceOf(InterpretError);
			}
		}
	});

	it('answers null for a global rather than throwing, because absence is not an error', async () => {
		const vm = await fresh();
		expect(vm.globalValue(ABSENT, 'anything')).toBeNull();
	});

	it('refuses an import id that was never reserved', async () => {
		const vm = await fresh();
		expect(() => vm.bindImport(ABSENT)).toThrow(InterpretError);
	});

	it('answers -1 rather than throwing when asked where an absent function sits', async () => {
		const vm = await fresh();
		expect(vm.tableFind(ABSENT, ABSENT, 'f')).toBe(-1);
	});

	it('does nothing when asked to clear no slots at all', async () => {
		const vm = await fresh();
		// the guard runs before the shim, so an empty range on a bad module is still not an error
		expect(() => vm.tableClear(ABSENT, 0, 0)).not.toThrow();
	});
});

// the parallel spec runs these under workerd, which cannot assemble wat, so they are pinned as bytes
describe('the parallel guest fixtures', () => {
	it('are the assembled bytes of their sources', () => {
		expect(wat(RANGE_WAT)).toEqual(RANGE);
		expect(wat(DATA_WAT)).toEqual(DATA);
		expect(wat(IMPURE_WAT)).toEqual(IMPURE);
	});

	it('pin a reference total that any split of the range sums to', async () => {
		const guest = (await fresh()).load(RANGE);
		expect(guest.call('range', 0, 4096, 200) >>> 0).toBe(RANGE_TOTAL);
		const halves =
			(guest.call('range', 0, 1000, 200) + guest.call('range', 1000, 4096, 200)) >>> 0;
		expect(halves).toBe(RANGE_TOTAL);
	});
});
