import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLinker, readDylink, type Library, type SuppliedImport } from '../../src/dylink.js';
import { createInterpreter } from '../../src/interpret.js';

/**
 * Dynamic linking against a real third-party library.
 *
 * The node lane drives fixtures written by hand. This one drives zlib 1.3.2, from emscripten's own
 * port, compiled as an ordinary `-s SIDE_MODULE` and linked at what would be request time.
 *
 * The check does not rely on the library agreeing with itself: node's native zlib inflates what the
 * interpreted library compressed, and `zlib.crc32` is compared against the library's own `crc32`.
 *
 * Skipped rather than failed without emcc, because a lane that could not run must not read as one
 * that passed.
 */

const HAVE_EMCC = (() => {
	try {
		execFileSync('emcc', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

const PAGES = 64;
let wasm3: WebAssembly.Module;
let side: Uint8Array;

/** the port's position-independent archive, built into emscripten's cache by -sUSE_ZLIB=1 */
function zlibArchive(): string {
	const root = execFileSync('em-config', ['CACHE'], { encoding: 'utf8' }).trim();
	return join(root, 'sysroot', 'lib', 'wasm32-emscripten', 'pic', 'libz.a');
}

beforeAll(async () => {
	const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
	wasm3 = new Module(
		await readFile(new URL('../../src/vendor/wasm3.wasm', import.meta.url).pathname)
	);
	if (!HAVE_EMCC) return;

	const source = new URL('../fixtures/dylink/zext.c', import.meta.url).pathname;
	const out = join(mkdtempSync(join(tmpdir(), 'burrow-side-')), 'zext.so');
	// -sUSE_ZLIB=1 alone supplies zlib's headers and then leaves its symbols as imports, because a
	// side module expects system libraries from the main module. -Wl,--whole-archive over the port's
	// own PIC archive is what puts zlib inside the .so, which is the case worth testing
	execFileSync(
		'emcc',
		[
			'-O2',
			'-sUSE_ZLIB=1',
			'-sSIDE_MODULE=1',
			source,
			'-o',
			out,
			'-Wl,--whole-archive',
			zlibArchive(),
			'-Wl,--no-whole-archive'
		],
		{ stdio: 'pipe' }
	);
	side = new Uint8Array(readFileSync(out));
}, 180_000);

/**
 * A bump allocator and the handful of libc entries a self-contained library leaves undefined.
 *
 * With a host runtime these come from the host and none of this is needed. Without one the caller
 * supplies them, or the library has nothing to allocate from.
 */
function heap(at: () => Library, start: number) {
	// errno gets the first word and the allocator starts after it; handing both the same address
	// makes the first malloc alias errno, which corrupts whatever the library allocated first
	const errno = start;
	let brk = (start + 16 + 15) & ~15;
	const sbrk = (n: number): number => {
		const p = brk;
		brk = (brk + Math.max(n, 1) + 15) & ~15;
		if (brk > (PAGES - 8) * 65536) throw new Error('library heap exhausted');
		return p;
	};
	const imports: Record<string, SuppliedImport> = {
		malloc: (n) => sbrk(n ?? 0),
		free: () => undefined,
		strlen: (p) => at().readText(p ?? 0).length,
		memchr: (p, c, n) => {
			const found = at()
				.read(p ?? 0, n ?? 0)
				.indexOf((c ?? 0) & 0xff);
			return found < 0 ? 0 : (p ?? 0) + found;
		},
		// a scratch word below the heap, so errno has somewhere real to live
		__errno_location: () => errno,
		snprintf: () => 0,
		vsnprintf: () => 0,
		strerror: () => 0,
		open: () => -1,
		close: () => -1,
		read: () => -1,
		write: () => -1,
		lseek: () => -1,
		fcntl: () => -1
	};
	return { imports, sbrk, used: () => brk - start };
}

describe.skipIf(!HAVE_EMCC)('zlib as a side module', () => {
	it('declares a memory demand far smaller than its code', () => {
		const info = readDylink(side);
		// mem_size is data plus bss and code contributes nothing, which is why admission reads it
		expect(info.memorySize).toBeGreaterThan(0);
		expect(info.memorySize).toBeLessThan(side.length);
	});

	it('links, compresses, and node inflates what it produced', async () => {
		const vm = await createInterpreter({ module: wasm3 });
		let lib!: Library;
		const info = readDylink(side);
		const region = heap(() => lib, (info.memorySize + 4095) & ~4095);
		const linker = createLinker(vm, { standalonePages: PAGES, imports: region.imports });
		lib = linker.load(side, { name: 'zlib' });

		const text = 'burrow links a real library at request time with no codegen anywhere';
		const src = region.sbrk(text.length);
		lib.write(src, text);

		const cap = lib.call('ext_bound', text.length);
		const dst = region.sbrk(cap);
		const packed = lib.call('ext_deflate', src, text.length, dst, cap);
		expect(packed).toBeGreaterThan(0);

		// the decisive check: a native zlib reads what the interpreted one wrote
		const wire = lib.read(dst, packed);
		expect(inflateSync(Buffer.from(wire)).toString()).toBe(text);
	});

	it('agrees with node on crc32, so the linked code computes and does not merely run', async () => {
		const zlib = await import('node:zlib');
		const vm = await createInterpreter({ module: wasm3 });
		let lib!: Library;
		const info = readDylink(side);
		const region = heap(() => lib, (info.memorySize + 4095) & ~4095);
		lib = createLinker(vm, { standalonePages: PAGES, imports: region.imports }).load(side);

		const text = 'the ratio is the guest instruction-level parallelism';
		const src = region.sbrk(text.length);
		lib.write(src, text);
		expect(lib.call('ext_crc', src, text.length) >>> 0).toBe(zlib.crc32(text));
	});

	it('round-trips through its own inflate', async () => {
		const vm = await createInterpreter({ module: wasm3 });
		let lib!: Library;
		const info = readDylink(side);
		const region = heap(() => lib, (info.memorySize + 4095) & ~4095);
		lib = createLinker(vm, { standalonePages: PAGES, imports: region.imports }).load(side);

		const text = 'x'.repeat(4096) + 'and a tail that does not compress as well';
		const src = region.sbrk(text.length);
		lib.write(src, text);
		const cap = lib.call('ext_bound', text.length);
		const dst = region.sbrk(cap);
		const packed = lib.call('ext_deflate', src, text.length, dst, cap);
		// 4 KiB of one byte is the easy case for deflate, so this also checks it really ran
		expect(packed).toBeLessThan(text.length / 4);

		const back = region.sbrk(text.length + 64);
		const got = lib.call('ext_inflate', dst, packed, back, text.length + 64);
		expect(lib.readText(back, got)).toBe(text);
	});
});

/**
 * The shape a language runtime and its extensions have: one address space, the runtime's allocator,
 * and pointers that mean the same thing on both sides.
 *
 * This is the case emscripten's loader cannot serve on Workers, because placing a library needs a
 * function pointer minted for every address-taken symbol and minting one is code generation.
 */
describe.skipIf(!HAVE_EMCC)('an extension linked into a host runtime', () => {
	let hostWasm: Uint8Array;
	let extWasm: Uint8Array;

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), 'burrow-host-'));
		const at = (name: string) =>
			new URL(`../fixtures/dylink/${name}`, import.meta.url).pathname;

		execFileSync(
			'emcc',
			[
				'-O2',
				'-sMAIN_MODULE=2',
				'-sSTANDALONE_WASM=1',
				'-sEXPORTED_FUNCTIONS=' +
					'["_main","_malloc","_free","_strcpy","_host_register","_host_sum",' +
					'"_host_registered","_host_slot"]',
				at('host.c'),
				'-o',
				join(dir, 'host.wasm')
			],
			{ stdio: 'pipe' }
		);
		execFileSync('emcc', ['-O2', '-sSIDE_MODULE=1', at('ext.c'), '-o', join(dir, 'ext.so')], {
			stdio: 'pipe'
		});
		hostWasm = new Uint8Array(readFileSync(join(dir, 'host.wasm')));
		extWasm = new Uint8Array(readFileSync(join(dir, 'ext.so')));
	}, 180_000);

	async function link() {
		const vm = await createInterpreter({ module: wasm3 });
		const host = vm.load(hostWasm);
		const lib = createLinker(vm, { host }).load(extWasm, { name: 'ext' });
		return { host, lib };
	}

	it('places the library inside the host heap rather than beside it', async () => {
		const { host, lib } = await link();
		// the base came from the host's own malloc, so it sits above whatever the host had allocated
		expect(lib.memoryBase).toBeGreaterThan(0);
		expect(host.call('malloc', 16)).toBeGreaterThan(lib.memoryBase);
	});

	it('lets the extension call into the host and the host see the result', async () => {
		const { host, lib } = await link();
		expect(host.call('host_registered')).toBe(0);
		expect(lib.call('ext_install')).toBe(1);
		expect(host.call('host_registered')).toBe(1);
		// host_sum("ext_greeting") is 1285 and the extension adds its own state of 7
		expect(host.call('host_slot', 0)).toBe(1292);
	});

	it('hands the host a pointer into the extension image that the host can dereference', async () => {
		const { host, lib } = await link();
		const ptr = lib.call('ext_name');
		expect(ptr).toBeGreaterThanOrEqual(lib.memoryBase);
		// read through the HOST, which is the whole claim: one address space, not two
		expect(host.readText(ptr)).toBe('ext_greeting');
		expect(host.call('host_sum', ptr)).toBe(1285);
	});

	it('keeps the extension mutable state across calls', async () => {
		const { lib } = await link();
		expect(lib.call('ext_bump', 5)).toBe(12);
		expect(lib.call('ext_bump', 30)).toBe(42);
	});

	it('takes table slots from the host table', async () => {
		const { lib } = await link();
		// the host owns the table, so the library's base is past everything the host already placed
		expect(lib.tableBase).toBeGreaterThan(0);
	});
});
