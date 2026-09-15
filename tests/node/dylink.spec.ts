import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	createLinker,
	customSection,
	readDylink,
	readExports,
	readImports,
	readSignatures
} from '../../src/dylink.js';
import { DylinkError } from '../../src/errors.js';
import { createInterpreter } from '../../src/interpret.js';
import { wat } from './wat.js';

/**
 * The dynamic linker, driven against modules built to the real `dylink.0` ABI.
 *
 * Fixtures are assembled here rather than committed, so the ABI under test is legible in the spec.
 * Every byte of the `dylink.0` payloads below is the encoding emcc emits: subsection 1 is MEM_INFO
 * carrying memory size, memory alignment, table size and table alignment as LEB128, and subsection 2
 * is NEEDED.
 */

let wasm3: WebAssembly.Module;

beforeAll(async () => {
	// workers-types declares WebAssembly.Module abstract, so the constructor is re-declared here
	const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
	wasm3 = new Module(
		await readFile(new URL('../../src/vendor/wasm3.wasm', import.meta.url).pathname)
	);
});

const vm = () => createInterpreter({ module: wasm3 });

/** mem_size 32, p2align 4, table_size 2, p2align 0 */
const MEM_INFO = '\\01\\04\\20\\04\\02\\00';

/**
 * A side module in the shape emcc produces: it imports both bases, reaches its own counter through
 * a GOT entry, places data at `__memory_base` and an element segment at `__table_base`.
 */
const LIBRARY = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 2 funcref))
  (import "GOT.mem" "counter" (global $got_counter (mut i32)))
  (func $bump (result i32)
    (i32.store (global.get $got_counter)
      (i32.add (i32.load (global.get $got_counter)) (i32.const 1)))
    (i32.load (global.get $got_counter)))
  (func $answer (result i32) (i32.const 42))
  (global (export "counter") i32 (i32.const 8))
  (export "bump" (func $bump))
  (export "answer" (func $answer))
  (elem (global.get $tb) $answer $bump)
  (data (global.get $mb) "PADDING!\\00\\00\\00\\00greetings")
)`;

/** imports a function nothing in the linker defines */
const NEEDS_HOST = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "triple" (func $triple (param i32) (result i32)))
  (func (export "call_out") (param i32) (result i32) (call $triple (local.get 0)))
  (data (global.get $mb) "x")
)`;

/**
 * Declares 8 MiB of bss in a module of a few hundred bytes, as a real bss-heavy library does.
 *
 * The MEM_INFO payload is 7 bytes: `80 80 80 04` is 8388608 in LEB128, then alignment 4, then a
 * table size and alignment of 0.
 */
const HUGE = `(module
  (@custom "dylink.0" "\\01\\07\\80\\80\\80\\04\\04\\00\\00")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (func (export "nothing") (result i32) (i32.const 1))
)`;

/**
 * A host runtime in miniature: it owns the memory, the table and the allocator, which is everything
 * a side module imports from `env`.
 *
 * A `-s MAIN_MODULE` build is exactly this surface with a libc behind it.
 */
const HOST = `(module
  (memory (export "memory") 4)
  (table (export "__indirect_function_table") 4 funcref)
  (global (export "__stack_pointer") (mut i32) (i32.const 262144))
  (global $brk (mut i32) (i32.const 1024))
  (func (export "malloc") (param i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $brk))
    (global.set $brk
      (i32.and (i32.add (i32.add (global.get $brk) (local.get 0)) (i32.const 31))
               (i32.const -16)))
    (local.get $p))
  (func (export "host_double") (param i32) (result i32)
    (i32.mul (local.get 0) (i32.const 2)))
  (func (export "host_peek") (param i32) (result i32)
    (i32.load8_u (local.get 0)))
)`;

/** a library that reaches the host for both a function and its allocator */
const GUEST_OF_HOST = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 1 funcref))
  (import "env" "host_double" (func $double (param i32) (result i32)))
  (import "GOT.mem" "label" (global $got_label (mut i32)))
  (func $twice (param i32) (result i32) (call $double (local.get 0)))
  (func (export "label_at") (result i32) (global.get $got_label))
  (global (export "label") i32 (i32.const 4))
  (export "twice" (func $twice))
  (elem (global.get $tb) $twice)
  (data (global.get $mb) "pad!burrow")
)`;

describe('readDylink', () => {
	it('decodes the memory and table demands emcc declares', () => {
		expect(readDylink(wat(LIBRARY))).toEqual({
			memorySize: 32,
			memoryAlignment: 4,
			tableSize: 2,
			tableAlignment: 0,
			needed: []
		});
	});

	it('reads the demand of a library whose image is almost entirely bss', () => {
		// the point of the check: 8 MiB of demand arriving in a module of a few hundred bytes
		const bytes = wat(HUGE);
		expect(readDylink(bytes).memorySize).toBe(8 * 1024 * 1024);
		expect(bytes.length).toBeLessThan(1024);
	});

	it('decodes the NEEDED list', () => {
		// subsection 1 MEM_INFO, then subsection 2 NEEDED with one name, "libbase.so"
		const needy = `(module
		  (@custom "dylink.0" "\\01\\04\\04\\02\\00\\00\\02\\0c\\01\\0alibbase.so")
		  (func (export "f") (result i32) (i32.const 1))
		)`;
		expect(readDylink(wat(needy)).needed).toEqual(['libbase.so']);
	});

	it('refuses a module that is not a side module, and says how to build one', () => {
		const plain = wat('(module (func (export "f") (result i32) (i32.const 1)))');
		expect(() => readDylink(plain)).toThrow(DylinkError);
		try {
			readDylink(plain);
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.not_a_library');
			expect((e as DylinkError).message).toContain('SIDE_MODULE');
		}
	});

	it('refuses bytes that are not wasm at all', () => {
		expect(() => readDylink(new Uint8Array([1, 2, 3, 4]))).toThrow(DylinkError);
	});
});

describe('the section readers', () => {
	it('finds a custom section by name rather than by position', () => {
		expect(customSection(wat(LIBRARY), 'dylink.0')).not.toBeNull();
		expect(customSection(wat(LIBRARY), 'name.that.is.absent')).toBeNull();
		expect(customSection(new Uint8Array([1, 2, 3]), 'dylink.0')).toBeNull();
	});

	it('decodes every import with its module, field and kind', () => {
		const imports = readImports(wat(LIBRARY));
		const seen = imports.map((entry) => `${entry.module}.${entry.field}:${entry.kind}`);
		expect(seen).toContain('env.memory:memory');
		expect(seen).toContain('env.__indirect_function_table:table');
		expect(seen).toContain('env.__memory_base:global');
		expect(seen).toContain('GOT.mem.counter:global');
	});

	it('gives a function import the wasm3 signature its type says', () => {
		const imports = readImports(wat(NEEDS_HOST));
		const triple = imports.find((entry) => entry.field === 'triple');
		expect(triple?.signature).toBe('i(i)');
	});

	it('answers an empty list for a module with no imports', () => {
		expect(readImports(wat('(module (func (export "f")))'))).toEqual([]);
	});

	it('separates exported functions from exported data symbols', () => {
		const exports = readExports(wat(LIBRARY));
		expect(exports.get('answer')).toBe('function');
		// a PIC build exports a data symbol as a global holding its module-relative offset
		expect(exports.get('counter')).toBe('global');
	});

	it('translates the value types a signature can carry', () => {
		const signatures = readSignatures(
			wat('(module (func (param i32 i64 f32 f64) (result i64) (i64.const 0)))')
		);
		expect(signatures).toContain('I(iIfF)');
	});
});

describe('loading a library', () => {
	it('places it, relocates it and runs it', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY), { name: 'demo' });

		expect(lib.call('answer')).toBe(42);
		// the data segment landed at __memory_base, past the padding and the counter
		expect(lib.readText(lib.memoryBase + 12)).toBe('greetings');
	});

	it('resolves a GOT.mem entry to the library its own data symbol lives in', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY));

		// the symbol sits at offset 8, not 0. A GOT entry read from the runtime before the module is
		// instantiated answers 0 for every data symbol, which relocates cleanly and reads the wrong
		// bytes; a fixture whose symbol lived at offset 0 would pass anyway
		expect(lib.address('counter')).toBe(lib.memoryBase + 8);

		// bump reaches the counter only through GOT.mem.counter, so a wrong address reads elsewhere
		expect(lib.call('bump')).toBe(1);
		expect(lib.call('bump')).toBe(2);
		expect(lib.readU32(lib.address('counter') as number)).toBe(2);
		// the padding either side is untouched, so the write landed where it was meant to
		expect(lib.readText(lib.memoryBase, 8)).toBe('PADDING!');
		expect(lib.readText(lib.memoryBase + 12)).toBe('greetings');
	});

	it('reports what dylink.0 declared', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY));
		expect(lib.info.memorySize).toBe(32);
		expect(lib.tableBase).toBe(0);
	});

	it('loads the same name once', async () => {
		const linker = createLinker(await vm());
		const first = linker.load(wat(LIBRARY), { name: 'once' });
		const second = linker.load(wat(LIBRARY), { name: 'once' });
		expect(second).toBe(first);
		expect(linker.loaded.size).toBe(1);
	});

	it('admits on the declared memory size rather than on the byte length', async () => {
		const linker = createLinker(await vm(), { standalonePages: 16 });
		expect(() => linker.load(wat(HUGE))).toThrow(DylinkError);
		try {
			linker.load(wat(HUGE));
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.no_space');
		}
	});

	it('inspects a library without loading it', async () => {
		const linker = createLinker(await vm());
		expect(linker.inspect(wat(LIBRARY)).memorySize).toBe(32);
		expect(linker.loaded.size).toBe(0);
	});
});

describe('resolving imports', () => {
	it('calls a host function the caller supplied', async () => {
		const linker = createLinker(await vm(), { imports: { triple: (n) => (n ?? 0) * 3 } });
		const lib = linker.load(wat(NEEDS_HOST));
		expect(lib.call('call_out', 14)).toBe(42);
	});

	it('takes a per-library import ahead of a linker-wide one', async () => {
		const linker = createLinker(await vm(), { imports: { triple: () => 0 } });
		const lib = linker.load(wat(NEEDS_HOST), { imports: { triple: (n) => (n ?? 0) * 3 } });
		expect(lib.call('call_out', 14)).toBe(42);
	});

	it('names every symbol nothing resolved rather than failing on the first', async () => {
		const linker = createLinker(await vm());
		try {
			linker.load(wat(NEEDS_HOST), { name: 'lonely' });
			expect.unreachable('a library with an unanswered import must not load');
		} catch (e) {
			const error = e as DylinkError;
			expect(error.code).toBe('burrow.dylink.unresolved');
			expect(error.unresolved).toEqual(['env.triple']);
			expect(error.message).toContain('env.triple');
		}
	});

	it('hands out one table slot per function, so two pointers to it compare equal', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY));
		const slot = lib.pointer('answer');
		expect(lib.pointer('answer')).toBe(slot);
		// the library's own element segments own slots 0 and 1, so a GOT slot comes after them
		expect(slot).toBeGreaterThanOrEqual(lib.info.tableSize);
	});
});

describe('the Library surface', () => {
	it('round-trips bytes, text and 32-bit values', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY));
		const scratch = lib.memoryBase + 64;

		lib.write(scratch, 'written across the boundary');
		expect(lib.readText(scratch)).toBe('written across the boundary');
		expect(lib.read(scratch, 7)).toEqual(new TextEncoder().encode('written'));

		lib.writeU32(scratch, 0xdeadbeef);
		expect(lib.readU32(scratch)).toBe(0xdeadbeef);
	});

	it('answers null for a data symbol the library does not export', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY));
		expect(lib.address('absent')).toBeNull();
		expect(lib.has('absent')).toBe(false);
		expect(lib.has('answer')).toBe(true);
	});

	it('throws a coded error rather than trapping for a missing export', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY));
		expect(() => lib.call('absent')).toThrow(DylinkError);
		try {
			lib.call('absent');
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.link_failed');
		}
	});
});

describe('linking against a host runtime', () => {
	async function linked() {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		const linker = createLinker(interpreter, { host });
		return { host, linker, lib: linker.load(wat(GUEST_OF_HOST), { name: 'guest' }) };
	}

	it('places the library inside the host address space using the host allocator', async () => {
		const { host, lib } = await linked();
		// the brk starts at 1024, so a base above it is one the host's own malloc handed out
		expect(lib.memoryBase).toBeGreaterThanOrEqual(1024);
		expect(host.call('malloc', 16)).toBeGreaterThan(lib.memoryBase);
	});

	it('lets the host read what the library placed, at the same address', async () => {
		const { host, lib } = await linked();
		expect(lib.readText(lib.memoryBase + 4)).toBe('burrow');
		// 'b' is 98, read through the host, which only agrees if the two share one memory
		expect(host.call('host_peek', lib.memoryBase + 4)).toBe(98);
	});

	it('resolves a function import against the host exports', async () => {
		const { lib } = await linked();
		expect(lib.call('twice', 21)).toBe(42);
	});

	it('takes table slots from the host table rather than starting at zero', async () => {
		const { host, lib } = await linked();
		// the host table already has entries, so the library's base is past them
		expect(lib.tableBase).toBeGreaterThanOrEqual(0);
		expect(lib.pointer('twice')).toBeGreaterThanOrEqual(lib.tableBase);
		expect(host.index).not.toBe(lib.guest.index);
	});

	it('offsets a GOT.mem entry by the base the host allocator chose', async () => {
		const { lib } = await linked();
		// the same value the library sees through its own GOT import
		expect(lib.call('label_at')).toBe(lib.memoryBase + 4);
		expect(lib.address('label')).toBe(lib.memoryBase + 4);
	});

	it('refuses when the host exports no allocator', async () => {
		const interpreter = await vm();
		const bare = interpreter.load(wat('(module (memory (export "memory") 1))'));
		const linker = createLinker(interpreter, { host: bare });
		try {
			linker.load(wat(GUEST_OF_HOST));
			expect.unreachable('a host with no allocator has nowhere to place a library');
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.no_space');
			expect((e as DylinkError).message).toContain('malloc');
		}
	});

	it('takes the allocator name the caller names', async () => {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		const linker = createLinker(interpreter, { host, allocator: 'not_an_export' });
		expect(() => linker.load(wat(GUEST_OF_HOST))).toThrow(DylinkError);
	});
});
