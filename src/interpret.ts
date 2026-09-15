import { InterpretError } from './errors.js';

/**
 * Executing WebAssembly that the deployment never saw.
 *
 * Cloudflare Workers forbids wasm code generation at request time, so bytes that arrive with a
 * request cannot be handed to V8. They can be handed to an interpreter that is itself compiled to
 * wasm, because to that interpreter the guest is data rather than code.
 *
 * What it costs: the interpreter's overhead is additive and nearly constant, about 2.2-2.7 ns per
 * guest memory access, so the ratio against native is set by how much the guest already stalls. A
 * pointer chase over 64 MiB measures 1.01x and the same chase over 16 KiB measures 4.41x; a
 * per-byte transform measures 20x. `ADVANCED_USAGE.md` carries the curve and the by-shape table.
 *
 * @since 1.0.0
 */

/** A host function an interpreted guest can import. Values are i32 unless the signature says else. */
export type HostFunction = (...args: number[]) => number | void;

/** wasm3 signature notation: a result character, then the parameters in parentheses. */
export type Signature = string;

export interface HostImport {
	/** wasm3 notation, e.g. `i(ii)` for `(i32, i32) -> i32`, `v(i)` for `(i32) -> void` */
	signature: Signature;
	fn: HostFunction;
}

/** `{ env: { now: { signature: 'i()', fn: () => Date.now() | 0 } } }` */
export type ImportMap = Record<string, Record<string, HostImport>>;

export interface InterpreterOptions {
	/**
	 * The vendored interpreter, already compiled.
	 *
	 * On Workers this is `import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm'`, which the
	 * platform compiles at upload. Nothing here compiles wasm at request time.
	 */
	module: WebAssembly.Module;
	/**
	 * wasm3's value-stack size in bytes. The default matches the interpreter's own linear-memory
	 * stack; a smaller value makes deep guest recursion trap as a stack overflow.
	 */
	stackBytes?: number;
}

export interface LoadOptions {
	/** host functions the guest imports, keyed by module then field */
	imports?: ImportMap;
}

export interface Guest {
	/** the guest's index in the interpreter, which is how the linker addresses one module of many */
	readonly index: number;
	/** whether the guest exports a name, so a caller can probe without treating a miss as an error */
	has(name: string): boolean;
	/**
	 * Calls an export with up to four i32 arguments.
	 *
	 * @throws {InterpretError} when the export is missing or the guest traps
	 */
	call(name: string, ...args: number[]): number;
	/** a view over the guest's linear memory; invalidated by anything that grows it */
	memory(): Uint8Array;
	/** reads `length` bytes of guest memory */
	read(ptr: number, length: number): Uint8Array;
	/** reads a NUL-terminated string out of guest memory */
	readText(ptr: number, length?: number): string;
	/** writes into guest memory at `ptr` */
	write(ptr: number, data: string | Uint8Array): void;
	/** allocates `size` bytes inside the interpreter and answers the pointer */
	alloc(size: number): number;
	/** frees a pointer from {@link Guest.alloc} */
	free(ptr: number): void;
}

/** @internal a host function plus what its signature says about the wasm3 value-stack layout */
interface LinkedImport {
	fn: HostFunction;
	/** parameter count, read from the signature rather than from `fn.length` */
	arity: number;
	/** whether sp[0] is the result slot */
	returns: boolean;
}

/**
 * Splits a wasm3 signature into its result and parameters.
 *
 * `i(ii)` is `(i32, i32) -> i32`; `v(i)` is `(i32) -> void`. The parameter count comes from here
 * rather than from `fn.length`, because a host function may legitimately ignore its arguments.
 *
 * @internal
 */
export function parseSignature(signature: Signature): { arity: number; returns: boolean } {
	const open = signature.indexOf('(');
	const close = signature.lastIndexOf(')');
	if (open < 1 || close < open) {
		throw new InterpretError(
			`signature ${JSON.stringify(signature)} is not wasm3 notation, e.g. i(ii)`,
			'burrow.interpret.link_failed'
		);
	}
	const params = signature.slice(open + 1, close).replace(/\s/g, '');
	return { arity: params.length, returns: signature[0] !== 'v' };
}

interface Shim {
	memory: WebAssembly.Memory;
	_initialize(): void;
	burrow_init(stackBytes: number): number;
	burrow_parse(ptr: number, len: number): number;
	burrow_instantiate(index: number): number;
	burrow_name(index: number, name: number): number;
	burrow_run_start(index: number): number;
	burrow_link(module: number, name: number, field: number, sig: number): number;
	burrow_reserve(module: number, name: number, field: number): number;
	burrow_bind(id: number): number;
	burrow_link_global(index: number, module: number, field: number, value: number): number;
	burrow_global(index: number, name: number, out: number): number;
	burrow_call(name: number, a0: number, a1: number, a2: number, a3: number): bigint;
	burrow_call_in(
		index: number,
		name: number,
		a0: number,
		a1: number,
		a2: number,
		a3: number
	): bigint;
	burrow_has(name: number): number;
	burrow_has_in(index: number, name: number): number;
	burrow_error(): number;
	burrow_alloc(size: number): number;
	burrow_free(ptr: number): void;
	burrow_mem_ptr(index: number): number;
	burrow_mem_size(index: number): number;
	burrow_grow_memory(index: number, pages: number): number;
	burrow_table_size(index: number): number;
	burrow_grow_table(index: number, extra: number): number;
	burrow_table_put(owner: number, slot: number, from: number, name: number): number;
	burrow_table_find(owner: number, from: number, name: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 8 MiB, matching the interpreter's own stack; below this, deep guest recursion traps */
export const DEFAULT_STACK_BYTES = 8 * 1024 * 1024;

/**
 * Instantiates the interpreter.
 *
 * One interpreter holds one wasm3 runtime, so guests loaded into it share a memory and can be
 * linked to each other. Create a second interpreter for isolation.
 *
 * @example
 * ```ts
 * import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
 *
 * const vm = await createInterpreter({ module: wasm3 });
 * const guest = vm.load(new Uint8Array(await request.arrayBuffer()));
 * const answer = guest.call('main');
 * ```
 *
 * @since 1.0.0
 */
export async function createInterpreter(options: InterpreterOptions): Promise<WasmInterpreter> {
	const handlers: LinkedImport[] = [];
	let shim: Shim;

	const instance = await WebAssembly.instantiate(options.module, {
		env: { emscripten_notify_memory_growth: () => {} },
		burrow: {
			// i32 only: wider values would need their own slot handling, and nothing burrow links
			// today needs them
			host_call: (id: number, sp: number, _mem: number): number => {
				const linked = handlers[id];
				if (!linked) return 1;
				// wasm3 reserves sp[0] for the result ONLY when the signature has one; a void import
				// starts its arguments at sp[0]. Reading from the wrong offset silently shifts every
				// argument by one and the guest sees plausible wrong values rather than an error
				const base = linked.returns ? 1 : 0;
				const slots = new BigUint64Array(shim.memory.buffer, sp);
				const args: number[] = [];
				for (let i = 0; i < linked.arity; i++) {
					args.push(Number(BigInt.asIntN(32, slots[base + i] ?? 0n)));
				}
				try {
					const result = linked.fn(...args);
					if (linked.returns && typeof result === 'number') {
						new BigUint64Array(shim.memory.buffer, sp)[0] =
							BigInt(result) & 0xffffffffn;
					}
					return 0;
				} catch {
					return 1;
				}
			}
		}
	});
	shim = instance.exports as unknown as Shim;
	shim._initialize();

	const rc = shim.burrow_init(options.stackBytes ?? DEFAULT_STACK_BYTES);
	if (rc !== 0) throw new InterpretError(readError(shim), 'burrow.interpret.init_failed');

	return new WasmInterpreter(shim, handlers);
}

/** @internal reads the shim's error buffer as text */
function readError(shim: Shim): string {
	const ptr = shim.burrow_error();
	const bytes = new Uint8Array(shim.memory.buffer);
	let end = ptr;
	while (bytes[end]) end++;
	return decoder.decode(bytes.subarray(ptr, end)) || 'unknown interpreter error';
}

/**
 * A wasm3 runtime, and the guests loaded into it.
 *
 * Named apart from {@link Interpreter} in `./runtime.js`, which is the `{ FS, callMain }` contract a
 * language runtime satisfies. This one is the wasm3 engine that executes guest modules.
 *
 * @since 1.0.0
 */
export class WasmInterpreter {
	/** @internal */
	constructor(
		private readonly shim: Shim,
		private readonly handlers: LinkedImport[]
	) {}

	/** the interpreter's own linear memory, which contains every guest's */
	get bytes(): Uint8Array {
		return new Uint8Array(this.shim.memory.buffer);
	}

	/** how much memory the interpreter currently holds, in bytes */
	get memoryBytes(): number {
		return this.shim.memory.buffer.byteLength;
	}

	/**
	 * Loads a guest module and links its imports.
	 *
	 * @throws {InterpretError} when the module does not parse or an import cannot be linked
	 */
	load(wasm: Uint8Array, options: LoadOptions = {}): Guest {
		const index = this.parse(wasm);
		this.instantiate(index);
		for (const [moduleName, fields] of Object.entries(options.imports ?? {})) {
			for (const [field, spec] of Object.entries(fields)) {
				this.linkFunction(index, moduleName, field, spec);
			}
		}
		return this.guest(index);
	}

	/**
	 * Parses a module without instantiating it, answering its index.
	 *
	 * Split from {@link WasmInterpreter.instantiate} because an imported global's value has to be
	 * supplied in between: the data and element segment offsets read it while the module is being
	 * instantiated. `load` does both and is what an ordinary guest wants.
	 *
	 * @internal
	 */
	parse(wasm: Uint8Array): number {
		const ptr = this.shim.burrow_alloc(wasm.length);
		if (!ptr) {
			throw new InterpretError('out of interpreter memory', 'burrow.interpret.load_failed');
		}
		this.bytes.set(wasm, ptr);
		const index = this.shim.burrow_parse(ptr, wasm.length);
		if (index < 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.load_failed');
		}
		return index;
	}

	/** @internal resolves the module's imports, backs its memory and runs its initializers */
	instantiate(index: number): void {
		if (this.shim.burrow_instantiate(index) !== 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.load_failed');
		}
	}

	/** @internal registers the module under a name, so later modules can import from it */
	nameModule(index: number, name: string): void {
		if (this.shim.burrow_name(index, this.cstring(name)) !== 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.link_failed');
		}
	}

	/** @internal runs the start function, which for a side module applies its data relocations */
	runStart(index: number): void {
		if (this.shim.burrow_run_start(index) !== 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.trap');
		}
	}

	/** @internal binds a host function to an import; the module must already be instantiated */
	linkFunction(index: number, moduleName: string, field: string, spec: HostImport): void {
		const shape = parseSignature(spec.signature);
		const id = this.shim.burrow_link(
			index,
			this.cstring(moduleName),
			this.cstring(field),
			this.cstring(spec.signature)
		);
		if (id < 0) {
			throw new InterpretError(
				`linking ${moduleName}.${field}: ${readError(this.shim)}`,
				'burrow.interpret.link_failed'
			);
		}
		this.handlers[id] = { fn: spec.fn, ...shape };
	}

	/**
	 * Claims a function import for a host function before the module is instantiated, answering an
	 * id for {@link WasmInterpreter.bindImport}.
	 *
	 * Needed whenever another module is registered under the import's module name: wasm3 resolves
	 * imports by module name at instantiation and rejects any the named module does not export, so
	 * an import the host cannot answer has to be taken out of its way first.
	 *
	 * @internal
	 */
	reserveImport(index: number, moduleName: string, field: string, spec: HostImport): number {
		const shape = parseSignature(spec.signature);
		const id = this.shim.burrow_reserve(index, this.cstring(moduleName), this.cstring(field));
		if (id < 0) {
			throw new InterpretError(
				`reserving ${moduleName}.${field}: ${readError(this.shim)}`,
				'burrow.interpret.link_failed'
			);
		}
		this.handlers[id] = { fn: spec.fn, ...shape };
		return id;
	}

	/** @internal installs the reserved host function; must run after {@link instantiate} */
	bindImport(id: number): void {
		if (this.shim.burrow_bind(id) !== 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.link_failed');
		}
	}

	/** @internal supplies an imported i32 global; must run before {@link instantiate} */
	linkGlobal(index: number, moduleName: string, field: string, value: number): void {
		const rc = this.shim.burrow_link_global(
			index,
			this.cstring(moduleName),
			this.cstring(field),
			value | 0
		);
		if (rc !== 0) {
			throw new InterpretError(
				`supplying ${moduleName}.${field}: ${readError(this.shim)}`,
				'burrow.interpret.link_failed'
			);
		}
	}

	/** @internal an exported i32 global's value, or null when the module does not export one */
	globalValue(index: number, name: string): number | null {
		const out = this.shim.burrow_alloc(4);
		try {
			if (this.shim.burrow_global(index, this.cstring(name), out) !== 0) return null;
			return new DataView(this.shim.memory.buffer).getInt32(out, true);
		} finally {
			this.shim.burrow_free(out);
		}
	}

	/** @internal grows memory 0 to at least `pages`, which a side module needs for a stack */
	growMemory(index: number, pages: number): void {
		if (this.shim.burrow_grow_memory(index, pages) !== 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.link_failed');
		}
	}

	/** @internal the number of slots in the module's table 0 */
	tableSize(index: number): number {
		return this.shim.burrow_table_size(index);
	}

	/** @internal grows table 0 by `extra` slots, answering the first new index */
	growTable(index: number, extra: number): number {
		const first = this.shim.burrow_grow_table(index, extra);
		if (first < 0) {
			throw new InterpretError(readError(this.shim), 'burrow.interpret.link_failed');
		}
		return first;
	}

	/** @internal writes a function into a table slot so call_indirect reaches it */
	tablePut(owner: number, slot: number, from: number, name: string): void {
		if (this.shim.burrow_table_put(owner, slot, from, this.cstring(name)) !== 0) {
			throw new InterpretError(
				`placing ${name} in table slot ${slot}: ${readError(this.shim)}`,
				'burrow.interpret.link_failed'
			);
		}
	}

	/** @internal the slot a function already occupies, or -1 */
	tableFind(owner: number, from: number, name: string): number {
		return this.shim.burrow_table_find(owner, from, this.cstring(name));
	}

	/** @internal copies a string into interpreter memory as NUL-terminated bytes */
	private cstring(value: string): number {
		const bytes = encoder.encode(`${value}\0`);
		const ptr = this.shim.burrow_alloc(bytes.length);
		this.bytes.set(bytes, ptr);
		return ptr;
	}

	/** @internal the guest handle for an already-loaded module */
	guest(index: number): Guest {
		const shim = this.shim;
		const self = this;
		return {
			index,
			has: (name) => shim.burrow_has_in(index, self.cstring(name)) === 1,
			call: (name, ...args) => {
				const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = args;
				const out = Number(shim.burrow_call_in(index, self.cstring(name), a0, a1, a2, a3));
				const error = readError(shim);
				// the shim clears its buffer on entry, so anything in it now came from this call
				if (error && error !== 'unknown interpreter error') {
					throw new InterpretError(`${name}: ${error}`, 'burrow.interpret.trap');
				}
				return out;
			},
			memory: () => {
				const base = shim.burrow_mem_ptr(index);
				const size = shim.burrow_mem_size(index);
				return new Uint8Array(shim.memory.buffer, base, size);
			},
			read: (ptr, length) => {
				const base = shim.burrow_mem_ptr(index);
				return new Uint8Array(shim.memory.buffer, base + ptr, length).slice();
			},
			readText: (ptr, length) => {
				const base = shim.burrow_mem_ptr(index);
				const all = new Uint8Array(shim.memory.buffer, base);
				if (length !== undefined) return decoder.decode(all.subarray(ptr, ptr + length));
				let end = ptr;
				while (all[end]) end++;
				return decoder.decode(all.subarray(ptr, end));
			},
			write: (ptr, data) => {
				const base = shim.burrow_mem_ptr(index);
				const bytes = typeof data === 'string' ? encoder.encode(data) : data;
				new Uint8Array(shim.memory.buffer, base).set(bytes, ptr);
			},
			alloc: (size) => shim.burrow_alloc(size),
			free: (ptr) => shim.burrow_free(ptr)
		};
	}
}
