import { hasWasmMagic, readVaruint } from './doctor.js';
import { DylinkError } from './errors.js';
import type { Guest, HostFunction, WasmInterpreter } from './interpret.js';

/**
 * Loading dynamic libraries - `-s SIDE_MODULE` builds, PHP `.so` extensions, TeaVM C-backend
 * artifacts - without generating a single instruction.
 *
 * Emscripten's own loader cannot run on Cloudflare Workers. A position-independent module reaches
 * its symbols through imported globals, and where a symbol's address is a function pointer the
 * loader has to mint a `funcref` for it; emscripten does that by assembling module bytes and
 * calling `new WebAssembly.Module`, which is what the platform forbids at request time.
 *
 * An interpreter has no such step. A function pointer is an index into a table the interpreter
 * owns, `__memory_base` and `__table_base` are numbers it chooses, and a relocation is an addition.
 * The whole ABI is data.
 *
 * @example
 * ```ts
 * import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
 * import { createInterpreter } from '@drupflare/burrow/interpret';
 * import { createLinker } from '@drupflare/burrow/dylink';
 *
 * const linker = createLinker(await createInterpreter({ module: wasm3 }));
 * const lib = linker.load(new Uint8Array(await request.arrayBuffer()));
 * const answer = lib.call('ext_run', 20, 22);
 * ```
 *
 * @since 1.0.0
 */

/** The page size every wasm32 memory counts in. */
const PAGE = 65536;

const decoder = new TextDecoder();

/**
 * Stack reserved above a standalone library's static image, in bytes.
 *
 * Sized from the image rather than fixed, because the reservation is charged in full against the
 * isolate: a flat multi-megabyte address space per library costs more than most libraries do. A
 * library that recurses deeply wants `standalonePages` set explicitly.
 */
export const DEFAULT_STANDALONE_STACK = 256 * 1024;

/**
 * What a library will take out of the address space it is placed in, read from `dylink.0`.
 *
 * `memorySize` is the whole static image, initialized data plus bss, and it is the number to admit
 * on. A library's bss never appears in the file, so an 8 MiB demand can arrive in a 211-byte
 * artifact and a check against the byte length lets it straight through.
 *
 * @since 1.0.0
 */
export interface DylinkInfo {
	/** bytes of static data and bss the library needs, which `__memory_base` has to point at */
	memorySize: number;
	/** alignment of that region, as a power of two */
	memoryAlignment: number;
	/** table slots the library's own element segments fill */
	tableSize: number;
	/** alignment of the table region, as a power of two */
	tableAlignment: number;
	/** libraries this one was linked against, in the order the linker recorded them */
	needed: string[];
}

/** One import a library declares, decoded far enough to decide who answers it. */
export interface DylinkImport {
	module: string;
	field: string;
	kind: 'function' | 'table' | 'memory' | 'global';
	/** wasm3 signature notation, for a function import only */
	signature?: string;
}

/** What an export refers to. A data symbol is exported as a global holding its offset. */
export type ExportKind = 'function' | 'table' | 'memory' | 'global';

/**
 * A loaded library.
 *
 * `call`, `read` and `write` address the memory the library was placed in, which is the host's
 * when one was given, so a pointer crossing the boundary means the same thing on both sides.
 *
 * @since 1.0.0
 */
export interface Library {
	/** the name the library was loaded under, which is also its cache key */
	readonly name: string;
	/** what `dylink.0` declared */
	readonly info: DylinkInfo;
	/** where the library's static data was placed */
	readonly memoryBase: number;
	/** the first table slot the library's element segments filled */
	readonly tableBase: number;
	/** the underlying guest module, for the raw interpreter surface */
	readonly guest: Guest;
	/** whether the library exports a name */
	has(name: string): boolean;
	/**
	 * Calls an exported function with up to four i32 arguments.
	 *
	 * @throws {DylinkError} when the library exports no such function
	 */
	call(name: string, ...args: number[]): number;
	/** the address of an exported data symbol, already offset by `memoryBase` */
	address(name: string): number | null;
	/** the table slot an exported function occupies, allocating one if it has none yet */
	pointer(name: string): number;
	/** reads `length` bytes out of the library's address space */
	read(ptr: number, length: number): Uint8Array;
	/** reads a NUL-terminated string out of the library's address space */
	readText(ptr: number, length?: number): string;
	/** writes into the library's address space */
	write(ptr: number, data: string | Uint8Array): void;
	/** reads a little-endian unsigned 32-bit value, which is what a C out-parameter holds */
	readU32(ptr: number): number;
	/** writes a little-endian unsigned 32-bit value */
	writeU32(ptr: number, value: number): void;
}

/** A host function, either bare or with an explicit signature when the import's own is wrong. */
export type SuppliedImport = HostFunction | { signature: string; fn: HostFunction };

export interface LinkerOptions {
	/**
	 * A module already loaded into the interpreter whose memory, table and symbols the libraries
	 * share. Without one, each library is placed in an address space of its own.
	 *
	 * The host has to export `memory`, `__indirect_function_table` and an allocator, which is what
	 * an emscripten `-s MAIN_MODULE` build does.
	 */
	host?: Guest;
	/**
	 * Acknowledges what linking into a host costs, and is required whenever {@link host} is set.
	 *
	 * A library placed in a host's address space is not sandboxed from it. It shares one linear
	 * memory, so it can read and write every byte the host holds, including anything another request
	 * left there; it shares one table, so it can call anything the host can; and its relocations are
	 * addresses the linker hands it. That is what makes a real extension ABI work and it is
	 * indistinguishable from what a hostile library would want.
	 *
	 * Set it to `true` only for libraries you would run in-process anyway. Leave it unset for
	 * anything a user supplied, and load those without a host, where each gets an address space of
	 * its own and resolves no symbols across libraries.
	 *
	 * @since 1.0.0
	 */
	allowHostAccess?: boolean;
	/** the host export that allocates a library's static region; ignored when there is no host */
	allocator?: string;
	/** the host export that gives it back on {@link Linker.unload}; defaults to `free` */
	deallocator?: string;
	/** symbols the caller answers itself, tried after the host and the loaded libraries */
	imports?: Record<string, SuppliedImport>;
	/**
	 * Pages of address space for a library loaded without a host. Defaults to the library declared
	 * image plus {@link DEFAULT_STANDALONE_STACK}; raise it for anything that recurses deeply.
	 */
	standalonePages?: number;
}

export interface LoadLibraryOptions {
	/**
	 * What to call the library, and the cache key: loading the same name twice answers the first
	 * one. Prefer a content hash: emscripten's own name-keyed cache charges twice for the same bytes
	 * shipped under two paths.
	 */
	name?: string;
	/** symbols this library alone answers, tried before the linker-wide ones */
	imports?: Record<string, SuppliedImport>;
	/** skip `__wasm_apply_data_relocs` and `__wasm_call_ctors` */
	skipInitializers?: boolean;
}

/** rounds `value` up to a multiple of 2**`p2` */
function alignTo(value: number, p2: number): number {
	const mask = (1 << p2) - 1;
	return (value + mask) & ~mask;
}

function normalize(entry: SuppliedImport): { signature?: string; fn: HostFunction } {
	return typeof entry === 'function' ? { fn: entry } : entry;
}

/**
 * Finds a custom section by name.
 *
 * `sectionBody` in `./doctor.js` answers the first section carrying an id, which is not enough
 * here: a module has several custom sections and only one of them is `dylink.0`.
 *
 * @internal
 */
export function customSection(bytes: Uint8Array, wanted: string): Uint8Array | null {
	if (!hasWasmMagic(bytes)) return null;
	let at = 8;
	while (at < bytes.length) {
		const id = bytes[at++] as number;
		// readVaruint answers the offset AFTER the value, not the value's width
		const [size, afterSize] = readVaruint(bytes, at);
		if (afterSize < 0) return null;
		const end = afterSize + size;
		if (end > bytes.length) return null;
		if (id === 0) {
			const [nameLength, afterLength] = readVaruint(bytes, afterSize);
			if (afterLength < 0) return null;
			const name = decoder.decode(bytes.subarray(afterLength, afterLength + nameLength));
			if (name === wanted) return bytes.subarray(afterLength + nameLength, end);
		}
		at = end;
	}
	return null;
}

/** @internal the body of a non-custom section, by id */
function sectionOf(bytes: Uint8Array, wanted: number): Uint8Array | null {
	if (!hasWasmMagic(bytes)) return null;
	let at = 8;
	while (at < bytes.length) {
		const id = bytes[at++] as number;
		const [size, afterSize] = readVaruint(bytes, at);
		if (afterSize < 0) return null;
		if (id === wanted) return bytes.subarray(afterSize, afterSize + size);
		at = afterSize + size;
	}
	return null;
}

/** @internal a cursor over a section body, throwing a coded error rather than running off the end */
function reader(body: Uint8Array, what: string) {
	let at = 0;
	const fail = (): never => {
		throw new DylinkError(`truncated ${what}`, 'burrow.dylink.malformed');
	};
	return {
		get at() {
			return at;
		},
		set at(value: number) {
			at = value;
		},
		get done() {
			return at >= body.length;
		},
		u32(): number {
			const [value, next] = readVaruint(body, at);
			if (next < 0) fail();
			at = next;
			return value;
		},
		byte(): number {
			if (at >= body.length) fail();
			return body[at++] as number;
		},
		peek(): number {
			return body[at] ?? -1;
		},
		/** signed LEB128, which is what a constant initializer holds */
		i32(): number {
			let result = 0;
			let shift = 0;
			for (;;) {
				const byte = body[at++];
				if (byte === undefined) return fail();
				result |= (byte & 0x7f) << shift;
				shift += 7;
				if ((byte & 0x80) === 0) {
					if (shift < 32 && byte & 0x40) result |= -(1 << shift);
					return result;
				}
			}
		},
		skip(n: number): void {
			at += n;
		},
		name(): string {
			const [length, next] = readVaruint(body, at);
			if (next < 0) fail();
			if (next + length > body.length) fail();
			at = next + length;
			return decoder.decode(body.subarray(next, next + length));
		}
	};
}

/**
 * Reads the `dylink.0` section.
 *
 * Every field sits within the first few dozen bytes of the file, so a library's whole memory demand
 * is known before anything is parsed, allocated or instantiated.
 *
 * @throws {DylinkError} `burrow.dylink.not_a_library` when the module carries no `dylink.0`
 * @since 1.0.0
 */
export function readDylink(bytes: Uint8Array): DylinkInfo {
	const body = customSection(bytes, 'dylink.0');
	if (!body) {
		throw new DylinkError(
			'no dylink.0 section: this is not a side module, rebuild it with -s SIDE_MODULE=1',
			'burrow.dylink.not_a_library'
		);
	}

	const info: DylinkInfo = {
		memorySize: 0,
		memoryAlignment: 0,
		tableSize: 0,
		tableAlignment: 0,
		needed: []
	};

	const r = reader(body, 'dylink.0 section');
	while (!r.done) {
		const kind = r.u32();
		const size = r.u32();
		const end = r.at + size;
		if (end > body.length) {
			throw new DylinkError(
				'dylink.0 subsection runs past the section',
				'burrow.dylink.malformed'
			);
		}
		// 1 is MEM_INFO and 2 is NEEDED; 3 to 5 carry per-symbol flags a loader may ignore
		if (kind === 1) {
			info.memorySize = r.u32();
			info.memoryAlignment = r.u32();
			info.tableSize = r.u32();
			info.tableAlignment = r.u32();
		} else if (kind === 2) {
			const count = r.u32();
			for (let i = 0; i < count; i++) info.needed.push(r.name());
		}
		r.at = end;
	}

	return info;
}

/** wasm value type bytes, mapped to the character wasm3's signature notation uses */
const VALUE_TYPES: Record<number, string> = { 0x7f: 'i', 0x7e: 'I', 0x7d: 'f', 0x7c: 'F' };

/**
 * Decodes the type section into wasm3 signature notation, one entry per type index.
 *
 * @internal
 */
export function readSignatures(bytes: Uint8Array): string[] {
	const body = sectionOf(bytes, 1);
	if (!body) return [];
	const r = reader(body, 'type section');
	const signatures: string[] = [];
	const count = r.u32();
	for (let i = 0; i < count; i++) {
		if (r.byte() !== 0x60) {
			// a recursion group or a GC type; wasm3 cannot run those and the load will say so
			signatures.push('');
			continue;
		}
		let params = '';
		const paramCount = r.u32();
		for (let p = 0; p < paramCount; p++) params += VALUE_TYPES[r.byte()] ?? '?';
		let result = 'v';
		const resultCount = r.u32();
		for (let n = 0; n < resultCount; n++) {
			const type = VALUE_TYPES[r.byte()] ?? '?';
			if (n === 0) result = type;
		}
		signatures.push(`${result}(${params})`);
	}
	return signatures;
}

/**
 * Decodes the import section.
 *
 * The linker answers every entry before the module is instantiated, which is what turns a load
 * failure into a list of missing symbols rather than one unknown-import message.
 *
 * @since 1.0.0
 */
export function readImports(bytes: Uint8Array): DylinkImport[] {
	const body = sectionOf(bytes, 2);
	if (!body) return [];
	const signatures = readSignatures(bytes);
	const imports: DylinkImport[] = [];
	const r = reader(body, 'import section');

	const count = r.u32();
	for (let i = 0; i < count; i++) {
		const module = r.name();
		const field = r.name();
		const kind = r.byte();
		if (kind === 0) {
			const typeIndex = r.u32();
			imports.push({
				module,
				field,
				kind: 'function',
				signature: signatures[typeIndex] || 'v()'
			});
		} else if (kind === 1 || kind === 2) {
			if (kind === 1) r.byte(); // element type
			const flags = r.u32();
			r.u32(); // initial
			if (flags & 1) r.u32(); // maximum
			imports.push({ module, field, kind: kind === 1 ? 'table' : 'memory' });
		} else if (kind === 3) {
			r.byte(); // value type
			r.byte(); // mutability
			imports.push({ module, field, kind: 'global' });
		} else {
			throw new DylinkError(`unknown import kind ${kind}`, 'burrow.dylink.malformed');
		}
	}
	return imports;
}

/**
 * Decodes the export section into names and what kind of thing each one is.
 *
 * A position-independent build exports every data symbol it defines as an immutable i32 global
 * holding a module-relative offset, which is where a `GOT.mem` entry's value comes from.
 *
 * @since 1.0.0
 */
export function readExports(bytes: Uint8Array): Map<string, ExportKind> {
	const exports = new Map<string, ExportKind>();
	const body = sectionOf(bytes, 7);
	if (!body) return exports;

	const kinds: ExportKind[] = ['function', 'table', 'memory', 'global'];
	const r = reader(body, 'export section');
	const count = r.u32();
	for (let i = 0; i < count; i++) {
		const name = r.name();
		const kind = kinds[r.byte()];
		r.u32(); // index
		if (kind) exports.set(name, kind);
	}
	return exports;
}

/**
 * Reads the constant initializer of every exported i32 global, answering export name to value.
 *
 * A `GOT.mem` entry has to carry its address BEFORE the module is instantiated, and until then
 * wasm3 has not run the global initializers, so asking the runtime for the value answers 0. Every
 * data symbol would then resolve to the start of the library's image, which relocates cleanly and
 * reads the wrong bytes, so the library loads, runs and returns wrong answers.
 *
 * @since 1.0.0
 */
export function readDataSymbols(bytes: Uint8Array): Map<string, number> {
	const symbols = new Map<string, number>();

	// the global index space puts imported globals first, so exports index past them
	let imported = 0;
	for (const entry of readImports(bytes)) if (entry.kind === 'global') imported++;

	const values: (number | null)[] = [];
	const body = sectionOf(bytes, 6);
	if (body) {
		const r = reader(body, 'global section');
		const count = r.u32();
		for (let i = 0; i < count; i++) {
			const type = r.byte();
			r.byte(); // mutability
			// only `i32.const <value>` is a data symbol's initializer; every other form is decoded
			// exactly far enough to stay in step with the section
			const opcode = r.byte();
			if (type === 0x7f && opcode === 0x41) values.push(r.i32());
			else {
				values.push(null);
				if (opcode === 0x42) r.i32();
				else if (opcode === 0x43) r.skip(4);
				else if (opcode === 0x44) r.skip(8);
				else if (opcode === 0x23) r.u32();
			}
			if (r.byte() !== 0x0b) {
				throw new DylinkError(
					'global initializer is not a single constant',
					'burrow.dylink.malformed'
				);
			}
		}
	}

	const exportBody = sectionOf(bytes, 7);
	if (!exportBody) return symbols;
	const r = reader(exportBody, 'export section');
	const count = r.u32();
	for (let i = 0; i < count; i++) {
		const name = r.name();
		const kind = r.byte();
		const index = r.u32();
		if (kind !== 3 || index < imported) continue;
		const value = values[index - imported];
		if (value !== null && value !== undefined) symbols.set(name, value);
	}
	return symbols;
}

/** @internal a symbol some loaded module defines, and where */
interface Definition {
	kind: 'function' | 'data';
	/** the interpreter module index that defines it */
	owner: number;
	/** the placed address, for data only */
	address?: number;
}

/** @internal where a library's static image and table entries went */
interface Placement {
	memoryBase: number;
	tableBase: number;
	/** pages the memory must reach after instantiation, for a standalone library */
	growTo?: number;
	/** the unaligned block the host allocator answered, which is what has to be handed back */
	rawPointer?: number;
}

/** @internal what unloading a library has to give back */
interface Residency {
	index: number;
	rawPointer?: number;
	tableOwner: number;
	tableBase: number;
	tableSize: number;
	/** modules this library resolved symbols from, so one still in use cannot be unloaded */
	dependsOn: Set<number>;
}

/** @internal a table slot handed out for a function, tracked so unloading can reclaim it */
interface Slot {
	key: string;
	tableOwner: number;
	slot: number;
}

/**
 * The dynamic linker.
 *
 * One linker owns one address space. With a host, every library shares the host's memory, table
 * and symbols, which is what a PHP extension needs: the structs it registers have to be readable
 * by the runtime registering them. Without one, each library is placed on its own, which is what a
 * self-contained library wants and which resolves no symbols across libraries.
 *
 * @since 1.0.0
 */
export class Linker {
	private readonly libraries = new Map<string, Library>();
	private readonly definitions = new Map<string, Definition>();
	private readonly slots = new Map<string, number>();
	/** next free slot per table-owning module, so a slot can be named before the table exists */
	private readonly tableTop = new Map<number, number>();
	/** slots an unload gave back, reused before the top is raised again */
	private readonly reusable = new Map<number, number[]>();
	/** slots handed out per defining module, so unloading it can clear and reclaim them */
	private readonly slotsByModule = new Map<number, Slot[]>();
	/** what each loaded library holds, so unloading it can give it back */
	private readonly residency = new Map<string, Residency>();
	/** the library currently being loaded, collecting the modules it resolves against */
	private loading: Set<number> | null = null;
	/** table writes waiting on the owning module to be instantiated */
	private pending: { tableOwner: number; slot: number; owner: number; name: string }[] = [];
	private anonymous = 0;

	/** @internal use {@link createLinker} */
	constructor(
		private readonly vm: WasmInterpreter,
		private readonly options: LinkerOptions = {}
	) {
		if (options.host && !options.allowHostAccess) {
			throw new DylinkError(
				'linking into a host address space gives the library the host memory and table in ' +
					'full, so it must be asked for: pass allowHostAccess: true, or omit host to ' +
					'place each library on its own',
				'burrow.dylink.host_access_denied'
			);
		}
		// a side module imports from "env", so this is what makes the host answer for it
		if (options.host) this.vm.nameModule(options.host.index, 'env');
	}

	/** every library loaded so far, keyed by the name it was loaded under */
	get loaded(): ReadonlyMap<string, Library> {
		return this.libraries;
	}

	/**
	 * Reads what a library will cost, without loading it.
	 *
	 * Admit on `memorySize` rather than on `bytes.length`: the static image is data plus bss, and
	 * bss occupies no bytes in the file at all.
	 *
	 * @since 1.0.0
	 */
	inspect(bytes: Uint8Array): DylinkInfo {
		return readDylink(bytes);
	}

	/**
	 * Places a library in the address space and links it.
	 *
	 * @throws {DylinkError} `burrow.dylink.not_a_library` when there is no `dylink.0`;
	 *   `burrow.dylink.unresolved` when a symbol has no answer, listing every one in `unresolved`;
	 *   `burrow.dylink.no_space` when there is nowhere to place the static image
	 * @since 1.0.0
	 */
	load(bytes: Uint8Array, options: LoadLibraryOptions = {}): Library {
		const name = options.name ?? `lib${this.anonymous++}`;
		const cached = this.libraries.get(name);
		if (cached) return cached;

		const info = readDylink(bytes);
		const imports = readImports(bytes);
		const exports = readExports(bytes);
		const own = readDataSymbols(bytes);
		const supplied = { ...this.options.imports, ...options.imports };

		const index = this.vm.parse(bytes);
		const deps = new Set<number>();
		this.loading = deps;
		const placement = this.options.host
			? this.placeInHost(this.options.host, info)
			: this.placeStandalone(index, info);

		// only what the module actually imports: wasm3 refuses to supply a global nothing asked for,
		// and a library with no relocations at all imports neither base
		const declared = new Set(imports.map((entry) => `${entry.module}.${entry.field}`));
		if (declared.has('env.__memory_base')) {
			this.vm.linkGlobal(index, 'env', '__memory_base', placement.memoryBase);
		}
		if (declared.has('env.__table_base')) {
			this.vm.linkGlobal(index, 'env', '__table_base', placement.tableBase);
		}

		const unresolved: string[] = [];
		const hostFunctions: DylinkImport[] = [];

		for (const entry of imports) {
			if (entry.module === 'GOT.mem' || entry.module === 'GOT.func') {
				const value = this.resolveGot(entry, index, exports, own, placement.memoryBase);
				if (value === null) unresolved.push(`${entry.module}.${entry.field}`);
				else this.vm.linkGlobal(index, entry.module, entry.field, value);
				continue;
			}
			if (entry.module !== 'env') continue;
			if (
				entry.kind === 'global' &&
				entry.field === '__stack_pointer' &&
				!this.options.host
			) {
				// a standalone library's stack grows down from the top of its own address space
				this.vm.linkGlobal(index, 'env', '__stack_pointer', (placement.growTo ?? 1) * PAGE);
				continue;
			}
			if (entry.kind !== 'function') continue;
			// a function the host module exports is resolved by the interpreter at instantiate;
			// anything else has to come from the caller, and is reserved now and bound after
			if (supplied[entry.field]) hostFunctions.push(entry);
			else if (!this.hostAnswers(entry.field)) unresolved.push(`env.${entry.field}`);
		}

		this.loading = null;

		if (unresolved.length) {
			throw new DylinkError(
				`${name}: nothing resolves ${unresolved.length} symbol(s): ${unresolved.join(', ')}`,
				'burrow.dylink.unresolved',
				{ unresolved }
			);
		}

		// reserved before instantiation so a host module registered as "env" cannot reject an import
		// only the caller answers, and bound after, when the module has a runtime to compile into
		const reserved = hostFunctions.map((entry) => {
			const { signature, fn } = normalize(supplied[entry.field] as SuppliedImport);
			return this.vm.reserveImport(index, 'env', entry.field, {
				signature: signature ?? entry.signature ?? 'v()',
				fn
			});
		});

		this.vm.instantiate(index);
		// a library with no memory import owns nothing to grow, and asking wasm3 to is an error
		if (placement.growTo && declared.has('env.memory')) {
			this.vm.growMemory(index, placement.growTo);
		}
		this.flush();
		for (const id of reserved) this.vm.bindImport(id);

		const guest = this.vm.guest(index);
		this.record(index, exports, own, placement.memoryBase);
		const library = this.build(name, info, placement, guest, exports, own);
		this.libraries.set(name, library);
		this.residency.set(name, {
			index,
			rawPointer: placement.rawPointer,
			tableOwner: this.options.host?.index ?? index,
			tableBase: placement.tableBase,
			tableSize: info.tableSize,
			dependsOn: deps
		});

		if (!options.skipInitializers) {
			// emcc emits a start section whenever a pointer in the static image needs __memory_base
			// added to it; the two named exports are the same work when there is no start section
			this.vm.runStart(index);
			if (guest.has('__wasm_apply_data_relocs')) guest.call('__wasm_apply_data_relocs');
			if (guest.has('__wasm_call_ctors')) guest.call('__wasm_call_ctors');
		}

		return library;
	}

	/**
	 * Unloads a library and gives back everything it held.
	 *
	 * Reclaims the static image (handed back to the host allocator), the table slots the library
	 * owns and any handed out for its functions, its symbols, its host-import bindings and the
	 * module itself. A later {@link load} reuses the freed slots rather than growing the table again.
	 *
	 * Compiled code pages are the one thing NOT reclaimed: wasm3 gates that on
	 * `d_m3EnableCodePageRefCounting`, which upstream leaves off, so code for functions that actually
	 * ran stays with the interpreter until it is dropped.
	 *
	 * @returns whether a library of that name was loaded
	 * @throws {DylinkError} `burrow.dylink.in_use` when another loaded library resolved a symbol
	 *   from this one, because unloading it would leave that library holding a dangling pointer
	 * @since 1.0.0
	 */
	unload(name: string): boolean {
		const held = this.residency.get(name);
		if (!held) return false;

		const users = [...this.residency]
			.filter(([other, record]) => other !== name && record.dependsOn.has(held.index))
			.map(([other]) => other);
		if (users.length) {
			throw new DylinkError(
				`${name} is still linked against by ${users.join(', ')}`,
				'burrow.dylink.in_use'
			);
		}

		// clear before freeing the module: wasm3 stops a freed module from freeing a table it
		// borrowed, but the entries it wrote into the host's table are left pointing at freed memory
		const recycled = this.reusable.get(held.tableOwner) ?? [];
		for (const slot of this.slotsByModule.get(held.index) ?? []) {
			this.vm.tableClear(slot.tableOwner, slot.slot, 1);
			this.slots.delete(slot.key);
			if (slot.tableOwner === held.tableOwner) recycled.push(slot.slot);
		}
		this.slotsByModule.delete(held.index);

		if (this.options.host && held.tableSize > 0) {
			this.vm.tableClear(held.tableOwner, held.tableBase, held.tableSize);
			for (let i = 0; i < held.tableSize; i++) recycled.push(held.tableBase + i);
		}
		if (recycled.length) this.reusable.set(held.tableOwner, recycled);

		for (const [symbol, definition] of [...this.definitions]) {
			if (definition.owner === held.index) this.definitions.delete(symbol);
		}

		this.vm.unload(held.index);

		// after the module is gone, so a trap during unload cannot leave the heap block orphaned
		if (held.rawPointer !== undefined && this.options.host) {
			const free = this.options.deallocator ?? 'free';
			if (this.options.host.has(free)) this.options.host.call(free, held.rawPointer);
		}

		this.libraries.delete(name);
		this.residency.delete(name);
		return true;
	}

	/** @internal whether the host module exports the symbol, so the interpreter resolves it itself */
	private hostAnswers(field: string): boolean {
		const host = this.options.host;
		return host ? host.has(field) : false;
	}

	/** @internal carves the library's static image out of the host's heap */
	private placeInHost(host: Guest, info: DylinkInfo): Placement {
		const allocator = this.options.allocator ?? 'malloc';
		if (!host.has(allocator)) {
			throw new DylinkError(
				`the host module exports no ${allocator}, so there is nowhere to place a library`,
				'burrow.dylink.no_space'
			);
		}
		// over-allocate by the alignment so the aligned base is still inside the block
		const raw = host.call(allocator, info.memorySize + (1 << info.memoryAlignment));
		if (!raw) {
			throw new DylinkError(
				`the host allocator refused ${info.memorySize} bytes`,
				'burrow.dylink.no_space'
			);
		}
		// the host is already instantiated, so its table can be grown now; the library's element
		// segments write into those slots while it is being instantiated
		const recycled = this.takeRun(host.index, info.tableSize);
		const tableBase = recycled ?? this.vm.growTable(host.index, info.tableSize);
		if (recycled === null) this.tableTop.set(host.index, tableBase + info.tableSize);
		// the unaligned block is what free() wants back, not the aligned base the library sees
		return { memoryBase: alignTo(raw, info.memoryAlignment), tableBase, rawPointer: raw };
	}

	/**
	 * @internal gives the library an address space of its own.
	 *
	 * The static image goes at 0, because that is the only base the module's own declared memory is
	 * guaranteed to cover and memory cannot be grown before it exists. The stack lives above the
	 * image, in the pages grown on once the module is instantiated.
	 */
	private placeStandalone(index: number, info: DylinkInfo): Placement {
		// sized from what the library declared, not fixed: the reservation is charged in full
		// against the isolate, so a flat allowance costs more than a small library does
		const needed = Math.ceil((info.memorySize + DEFAULT_STANDALONE_STACK) / PAGE);
		const pages = this.options.standalonePages ?? needed;
		if (info.memorySize >= pages * PAGE) {
			throw new DylinkError(
				`the library's static image is ${info.memorySize} bytes and standalonePages ` +
					`leaves ${pages * PAGE}; raise standalonePages`,
				'burrow.dylink.no_space'
			);
		}
		// its own element segments fill the first tableSize slots, so a GOT slot starts after them
		this.tableTop.set(index, info.tableSize);
		return { memoryBase: 0, tableBase: 0, growTo: pages };
	}

	/**
	 * @internal takes `count` adjacent slots an unload gave back, or null when no run is that long.
	 *
	 * A library's element segments write a contiguous block from `__table_base`, so its slots have to
	 * come back as a run; the loose slots handed out for individual functions do not.
	 */
	private takeRun(tableOwner: number, count: number): number | null {
		if (count <= 0) return null;
		const free = this.reusable.get(tableOwner);
		if (!free || free.length < count) return null;

		const sorted = [...free].sort((a, b) => a - b);
		for (let i = 0; i + count <= sorted.length; i++) {
			if ((sorted[i + count - 1] as number) - (sorted[i] as number) !== count - 1) continue;
			const run = new Set(sorted.slice(i, i + count));
			this.reusable.set(
				tableOwner,
				free.filter((slot) => !run.has(slot))
			);
			return sorted[i] as number;
		}
		return null;
	}

	/** @internal answers one GOT entry, or null when nothing defines the symbol */
	private resolveGot(
		entry: DylinkImport,
		index: number,
		exports: Map<string, ExportKind>,
		own: Map<string, number>,
		memoryBase: number
	): number | null {
		const host = this.options.host;

		if (entry.module === 'GOT.func') {
			if (exports.get(entry.field) === 'function') return this.pointerFor(index, entry.field);
			if (!host) return null;
			const known = this.definitions.get(entry.field);
			if (known?.kind === 'function') {
				this.loading?.add(known.owner);
				return this.pointerFor(known.owner, entry.field);
			}
			if (host.has(entry.field)) return this.pointerFor(host.index, entry.field);
			return null;
		}

		// read statically: the module is parsed but not instantiated, so wasm3 has not yet run the
		// initializer and would answer 0 for every one of these
		const offset = own.get(entry.field);
		if (offset !== undefined) return memoryBase + offset;
		if (!host) return null;
		const known = this.definitions.get(entry.field);
		if (known?.kind === 'data' && known.address !== undefined) {
			this.loading?.add(known.owner);
			return known.address;
		}
		return this.vm.globalValue(host.index, entry.field);
	}

	/**
	 * @internal the table slot a function occupies, allocating one if it has none.
	 *
	 * The slot is named here and written in {@link flush}, because a GOT entry has to carry its
	 * value before the module is instantiated and the module's table does not exist until it is.
	 * Kept one-to-one, so two GOT entries for the same symbol compare equal - which is what C code
	 * comparing function pointers expects.
	 */
	private pointerFor(owner: number, name: string): number {
		const tableOwner = this.options.host?.index ?? owner;
		const key = `${tableOwner}:${owner}:${name}`;
		const cached = this.slots.get(key);
		if (cached !== undefined) return cached;

		const recycled = this.reusable.get(tableOwner);
		const reused = recycled?.pop();
		let slot: number;
		if (reused !== undefined) {
			slot = reused;
		} else {
			slot = this.tableTop.get(tableOwner) ?? 0;
			this.tableTop.set(tableOwner, slot + 1);
		}
		this.slots.set(key, slot);
		const held = this.slotsByModule.get(owner);
		if (held) held.push({ key, tableOwner, slot });
		else this.slotsByModule.set(owner, [{ key, tableOwner, slot }]);
		this.pending.push({ tableOwner, slot, owner, name });
		return slot;
	}

	/** @internal grows each table to hold the slots handed out, then writes the functions into them */
	private flush(): void {
		const owners = new Set(this.pending.map((entry) => entry.tableOwner));
		for (const owner of owners) {
			const want = this.tableTop.get(owner) ?? 0;
			const have = this.vm.tableSize(owner);
			if (want > have) this.vm.growTable(owner, want - have);
		}
		for (const entry of this.pending) {
			this.vm.tablePut(entry.tableOwner, entry.slot, entry.owner, entry.name);
		}
		this.pending = [];
	}

	/** @internal publishes a library's exports so the next library can link against them */
	private record(
		index: number,
		exports: Map<string, ExportKind>,
		own: Map<string, number>,
		memoryBase: number
	): void {
		for (const [name, kind] of exports) {
			if (this.definitions.has(name)) continue;
			if (kind === 'function') {
				this.definitions.set(name, { kind: 'function', owner: index });
			} else {
				const offset = own.get(name);
				if (offset !== undefined) {
					this.definitions.set(name, {
						kind: 'data',
						owner: index,
						address: memoryBase + offset
					});
				}
			}
		}
	}

	/** @internal */
	private build(
		name: string,
		info: DylinkInfo,
		placement: Placement,
		guest: Guest,
		exports: Map<string, ExportKind>,
		own: Map<string, number>
	): Library {
		const linker = this;
		return {
			name,
			info,
			memoryBase: placement.memoryBase,
			tableBase: placement.tableBase,
			guest,
			has: (symbol) => exports.has(symbol),
			call: (symbol, ...args) => {
				if (exports.get(symbol) !== 'function') {
					throw new DylinkError(
						`${name} exports no function named ${JSON.stringify(symbol)}`,
						'burrow.dylink.link_failed'
					);
				}
				return guest.call(symbol, ...args);
			},
			address: (symbol) => {
				const offset = own.get(symbol);
				return offset === undefined ? null : placement.memoryBase + offset;
			},
			pointer: (symbol) => linker.pointerFor(guest.index, symbol),
			read: (ptr, length) => guest.read(ptr, length),
			readText: (ptr, length) => guest.readText(ptr, length),
			write: (ptr, data) => guest.write(ptr, data),
			readU32: (ptr) => {
				const bytes = guest.read(ptr, 4);
				return (
					((bytes[0] as number) |
						((bytes[1] as number) << 8) |
						((bytes[2] as number) << 16) |
						((bytes[3] as number) << 24)) >>>
					0
				);
			},
			writeU32: (ptr, value) => {
				const bytes = new Uint8Array(4);
				bytes[0] = value & 0xff;
				bytes[1] = (value >>> 8) & 0xff;
				bytes[2] = (value >>> 16) & 0xff;
				bytes[3] = (value >>> 24) & 0xff;
				guest.write(ptr, bytes);
			}
		};
	}
}

/**
 * Creates a linker over an interpreter.
 *
 * @since 1.0.0
 */
export function createLinker(vm: WasmInterpreter, options: LinkerOptions = {}): Linker {
	return new Linker(vm, options);
}
