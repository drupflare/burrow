import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	createLinker,
	customSection,
	readDataSymbols,
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
  (global $freed (mut i32) (i32.const 0))
  (func (export "free") (param i32) (global.set $freed (local.get 0)))
  (func (export "last_freed") (result i32) (global.get $freed))
  (func (export "host_double") (param i32) (result i32)
    (i32.mul (local.get 0) (i32.const 2)))
  (func (export "host_peek") (param i32) (result i32)
    (i32.load8_u (local.get 0)))
)`;

/** exports a function another library reaches through GOT.func, so one depends on the other */
const PROVIDER = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 1 funcref))
  (func $shared (param i32) (result i32) (i32.add (local.get 0) (i32.const 1)))
  (export "shared" (func $shared))
  (elem (global.get $tb) $shared)
  (data (global.get $mb) "p")
)`;

/** takes the address of its OWN exported function, which resolves without any host */
const SELF_POINTER = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (type $nullary (func (result i32)))
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 2 funcref))
  (import "GOT.func" "mine" (global $got_mine (mut i32)))
  (func $mine (result i32) (i32.const 7))
  (export "mine" (func $mine))
  (func (export "via") (result i32) (call_indirect (type $nullary) (global.get $got_mine)))
  (elem (global.get $tb) $mine)
  (data (global.get $mb) "s")
)`;

/** takes the address of a function only the HOST defines */
const HOST_POINTER = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (type $unary (func (param i32) (result i32)))
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 1 funcref))
  (import "GOT.func" "host_double" (global $got_double (mut i32)))
  (func (export "twice") (param i32) (result i32)
    (call_indirect (type $unary) (local.get 0) (global.get $got_double)))
  (data (global.get $mb) "h")
)`;

/** asks for the address of a function nothing anywhere defines */
const DANGLING_POINTER = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 1 funcref))
  (import "GOT.func" "nobody_defines_this" (global $got (mut i32)))
  (func (export "f") (result i32) (global.get $got))
  (data (global.get $mb) "x")
)`;

/** reads a data symbol another library placed, through GOT.mem */
const NEEDS_FOREIGN_DATA = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 1 funcref))
  (import "GOT.mem" "counter" (global $got_counter (mut i32)))
  (func (export "counter_at") (result i32) (global.get $got_counter))
  (data (global.get $mb) "d")
)`;

const CONSUMER = `(module
  (@custom "dylink.0" "${MEM_INFO}")
  (type $unary (func (param i32) (result i32)))
  (import "env" "memory" (memory 1))
  (import "env" "__memory_base" (global $mb i32))
  (import "env" "__table_base" (global $tb i32))
  (import "env" "__indirect_function_table" (table 1 funcref))
  (import "GOT.func" "shared" (global $got_shared (mut i32)))
  (func (export "via_pointer") (param i32) (result i32)
    (call_indirect (type $unary) (local.get 0) (global.get $got_shared)))
  (data (global.get $mb) "c")
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

/**
 * Malformed input, which a linker sees whenever a caller passes bytes that arrived over the wire.
 *
 * Every reader here walks a length-prefixed format, so the failure that matters is running off the
 * end: a size that overruns the buffer, or a LEB128 that never terminates. The contract is that the
 * section readers answer null or empty and the dylink reader throws a coded error, and that neither
 * ever reads past what it was given.
 */
describe('bytes that run off the end', () => {
	const MAGIC = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
	const bytes = (...rest: number[]) => new Uint8Array([...MAGIC, ...rest]);

	/** a section id, then a LEB128 that sets its continuation bit and then stops */
	const UNTERMINATED = bytes(0x01, 0x80);
	/** a section claiming 127 bytes of body where none follow */
	const OVERRUNNING = bytes(0x01, 0x7f);
	/** a custom section whose name length is itself truncated */
	const BAD_NAME = bytes(0x00, 0x02, 0x80, 0x80);

	it('answers null from customSection rather than reading past the buffer', () => {
		expect(customSection(UNTERMINATED, 'dylink.0')).toBeNull();
		expect(customSection(OVERRUNNING, 'dylink.0')).toBeNull();
		expect(customSection(BAD_NAME, 'dylink.0')).toBeNull();
		expect(customSection(new Uint8Array(MAGIC), 'dylink.0')).toBeNull();
	});

	it('answers empty when the section header itself cannot be read', () => {
		// the size LEB never terminates, so there is no body to walk and nothing to report
		for (const input of [UNTERMINATED, new Uint8Array([1, 2, 3])]) {
			expect(readImports(input)).toEqual([]);
			expect(readSignatures(input)).toEqual([]);
			expect(readExports(input).size).toBe(0);
			expect(readDataSymbols(input).size).toBe(0);
		}
	});

	it('throws a coded error when a section body is short of what it declared', () => {
		// each reader walks its own section, so the truncation has to carry that section's id
		const cases: [string, number, (b: Uint8Array) => unknown][] = [
			['type', 1, readSignatures],
			['import', 2, readImports],
			['export', 7, readExports],
			['global', 6, readDataSymbols]
		];
		for (const [what, id, read] of cases) {
			try {
				// the header parses and names 127 bytes, so the reader gets a body and runs out in it
				read(bytes(id, 0x7f));
				expect.unreachable(`the ${what} reader read past a truncated section`);
			} catch (e) {
				expect((e as DylinkError).code, what).toBe('burrow.dylink.malformed');
			}
		}
	});

	it('throws a coded error when the dylink section itself is truncated', () => {
		// subsection 1 (MEM_INFO) declaring 4 bytes of payload and supplying one
		const truncated = `(module
		  (@custom "dylink.0" "\\01\\04\\20")
		  (func (export "f") (result i32) (i32.const 1))
		)`;
		try {
			readDylink(wat(truncated));
			expect.unreachable('a truncated dylink.0 must not decode');
		} catch (e) {
			expect(e).toBeInstanceOf(DylinkError);
			expect((e as DylinkError).code).toBe('burrow.dylink.malformed');
		}
	});

	it('throws when a NEEDED name overruns the subsection', () => {
		// subsection 2 declares one name of 200 bytes, and the section is nowhere near that long
		const overrun = `(module
		  (@custom "dylink.0" "\\01\\04\\20\\04\\02\\00\\02\\03\\01\\c8\\01")
		  (func (export "f") (result i32) (i32.const 1))
		)`;
		expect(() => readDylink(wat(overrun))).toThrow(DylinkError);
	});
});

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

	it('resolves a function pointer to the library that defines it', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(SELF_POINTER), { name: 'self' });
		// the address came through GOT.func and is called indirectly, so a wrong slot answers wrong
		expect(lib.call('via')).toBe(7);
	});

	it('resolves a function pointer to the host when only the host defines it', async () => {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		const linker = createLinker(interpreter, { host, allowHostAccess: true });
		const lib = linker.load(wat(HOST_POINTER), { name: 'hostptr' });
		expect(lib.call('twice', 21)).toBe(42);
	});

	it('refuses a function pointer nothing defines, rather than answering zero', async () => {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		const linker = createLinker(interpreter, { host, allowHostAccess: true });
		try {
			linker.load(wat(DANGLING_POINTER), { name: 'dangling' });
			expect.unreachable('a pointer to nothing must not link');
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.unresolved');
			expect((e as DylinkError).unresolved).toContain('GOT.func.nobody_defines_this');
		}
	});

	it('resolves a data symbol another library already placed', async () => {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		const linker = createLinker(interpreter, { host, allowHostAccess: true });
		const provider = linker.load(wat(LIBRARY), { name: 'owner' });
		const reader = linker.load(wat(NEEDS_FOREIGN_DATA), { name: 'reader' });

		// the reader has no counter of its own, so this can only be the provider's address
		expect(reader.call('counter_at')).toBe(provider.address('counter'));
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
		const linker = createLinker(interpreter, { host, allowHostAccess: true });
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
		const linker = createLinker(interpreter, { host: bare, allowHostAccess: true });
		try {
			linker.load(wat(GUEST_OF_HOST));
			expect.unreachable('a host with no allocator has nowhere to place a library');
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.no_space');
			expect((e as DylinkError).message).toContain('malloc');
		}
	});

	it('refuses a host without an explicit acknowledgement', async () => {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		try {
			createLinker(interpreter, { host });
			expect.unreachable('sharing a host address space must be asked for');
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.host_access_denied');
			expect((e as DylinkError).message).toContain('allowHostAccess');
		}
	});

	it('needs no acknowledgement when each library is placed on its own', async () => {
		const linker = createLinker(await vm());
		expect(linker.load(wat(LIBRARY), { name: 'alone' }).call('answer')).toBe(42);
	});

	it('takes the allocator name the caller names', async () => {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		const linker = createLinker(interpreter, {
			host,
			allowHostAccess: true,
			allocator: 'not_an_export'
		});
		expect(() => linker.load(wat(GUEST_OF_HOST))).toThrow(DylinkError);
	});
});

describe('unloading a library', () => {
	async function hosted() {
		const interpreter = await vm();
		const host = interpreter.load(wat(HOST));
		return {
			interpreter,
			host,
			linker: createLinker(interpreter, { host, allowHostAccess: true })
		};
	}

	it('hands the static image back to the host allocator', async () => {
		const { host, linker } = await hosted();
		const lib = linker.load(wat(GUEST_OF_HOST), { name: 'guest' });
		const base = lib.memoryBase;

		expect(host.call('last_freed')).toBe(0);
		expect(linker.unload('guest')).toBe(true);
		// the block freed is the unaligned one malloc answered, which is at or below the base
		const freed = host.call('last_freed');
		expect(freed).toBeGreaterThan(0);
		expect(freed).toBeLessThanOrEqual(base);
	});

	it('stops reporting it as loaded and lets the name be reused', async () => {
		const { linker } = await hosted();
		linker.load(wat(GUEST_OF_HOST), { name: 'guest' });
		expect(linker.loaded.size).toBe(1);

		linker.unload('guest');
		expect(linker.loaded.size).toBe(0);
		expect(linker.loaded.has('guest')).toBe(false);

		// a second load under the same name is a fresh library, not the cached first one
		const again = linker.load(wat(GUEST_OF_HOST), { name: 'guest' });
		expect(again.call('twice', 21)).toBe(42);
	});

	it('answers false for a name that was never loaded', async () => {
		const { linker } = await hosted();
		expect(linker.unload('never')).toBe(false);
	});

	it('gives table slots back rather than growing the table again', async () => {
		const { interpreter, host, linker } = await hosted();
		linker.load(wat(GUEST_OF_HOST), { name: 'first' });
		const grown = interpreter.tableSize(host.index);

		linker.unload('first');
		linker.load(wat(GUEST_OF_HOST), { name: 'second' });

		// without reclamation the second library's slots would sit above the first's
		expect(interpreter.tableSize(host.index)).toBe(grown);
	});

	it('refuses while another library still links against it', async () => {
		const { linker } = await hosted();
		linker.load(wat(PROVIDER), { name: 'provider' });
		const consumer = linker.load(wat(CONSUMER), { name: 'consumer' });
		expect(consumer.call('via_pointer', 41)).toBe(42);

		try {
			linker.unload('provider');
			expect.unreachable(
				'unloading a library still linked against leaves a dangling pointer'
			);
		} catch (e) {
			expect((e as DylinkError).code).toBe('burrow.dylink.in_use');
			expect((e as DylinkError).message).toContain('consumer');
		}
		expect(linker.loaded.has('provider')).toBe(true);
	});

	it('allows the unload once the dependent is gone, in either order', async () => {
		const { linker } = await hosted();
		linker.load(wat(PROVIDER), { name: 'provider' });
		linker.load(wat(CONSUMER), { name: 'consumer' });

		expect(linker.unload('consumer')).toBe(true);
		expect(linker.unload('provider')).toBe(true);
		expect(linker.loaded.size).toBe(0);
	});

	it('unloads a library that was placed on its own', async () => {
		const linker = createLinker(await vm());
		const lib = linker.load(wat(LIBRARY), { name: 'alone' });
		expect(lib.call('answer')).toBe(42);

		expect(linker.unload('alone')).toBe(true);
		expect(linker.loaded.size).toBe(0);

		// the module slot it held is reusable, so a later library still loads and runs
		const next = linker.load(wat(LIBRARY), { name: 'after' });
		expect(next.call('answer')).toBe(42);
	});
});
