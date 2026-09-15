import { RuntimeError } from './errors.js';

/**
 * Line-oriented output, matching what emscripten's `print`/`printErr` hand back and what
 * `@drupflare/cartridge` passes into its `instantiate`.
 *
 * @since 1.0.0
 */
export interface RuntimeIo {
	/** one line of stdout, newline already stripped */
	print(line: string): void;
	/** one line of stderr, newline already stripped */
	printErr(line: string): void;
}

/**
 * The emscripten filesystem surface a host needs to write a script and read results back.
 *
 * Structural rather than imported, so this package does not depend on `@drupflare/cartridge` or on
 * emscripten's own types. Any object with these members satisfies it.
 *
 * @since 1.0.0
 */
export interface RuntimeFS {
	writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string }): void;
	readFile(path: string, opts?: { encoding?: string }): Uint8Array | string;
	mkdir(path: string): unknown;
	/**
	 * Optional because a real build measured without it: wasmoon's emscripten FS exports `mkdir` and
	 * `writeFile` but no `analyzePath`. Requiring it would have excluded a runtime this package
	 * otherwise drives end to end, so callers probe with `mkdir` and tolerate the throw instead.
	 */
	analyzePath?(path: string): { exists: boolean };
}

/**
 * What a wasm interpreter has to look like for burrow - and for cartridge - to drive it.
 *
 * Two members. Anything wider is the caller's to reach for through the instance the
 * spec closed over.
 *
 * @since 1.0.0
 */
export interface Interpreter {
	/** the filesystem a script is written into */
	FS: RuntimeFS;
	/**
	 * runs `main(argc, argv)` and answers its exit status
	 *
	 * May answer a promise: an emscripten build returns a number synchronously, but an adapter over
	 * an ahead-of-time compiled program can have work to finish after `main` returns.
	 */
	callMain(argv: string[]): number | void | Promise<number | void>;
}

/** What {@link RuntimeSpec.instantiate} is handed. */
export interface InstantiateContext<L> {
	/** whatever {@link RuntimeSpec.load} resolved to */
	loaded: L;
	/** the line sinks to forward into the module */
	io: RuntimeIo;
	/** byte-to-line adapter, because emscripten hands back one byte at a time */
	lines: (sink: (line: string) => void) => (byte: number) => void;
}

/**
 * How much of the isolate a runtime expects to take, in bytes.
 *
 * Both are claims by the consumer. The budget corrects them from observation after the first boot,
 * so an optimistic `peak` is survivable, but the first boot is taken on trust.
 */
export interface RuntimeMemory {
	/** linear memory at boot */
	initial?: number;
	/** the high-water mark under real load */
	peak?: number;
}

/**
 * A runtime burrow can acquire. **burrow ships none** - the consumer supplies it.
 *
 * @since 1.0.0
 */
export interface RuntimeSpec<L = unknown> {
	/** the name {@link Burrow.acquire} looks up */
	name: string;
	/**
	 * Imports the runtime.
	 *
	 * **Must be a thunk around a literal specifier**, e.g. `() => import('./runtimes/php.js')`.
	 * esbuild, which is what `wrangler deploy` bundles with, cannot follow `import(someVariable)`, so
	 * a registry that built a specifier at runtime would bundle clean and then find nothing.
	 */
	load: () => Promise<L>;
	/** turns the loaded module into the two members a host drives */
	instantiate(ctx: InstantiateContext<L>): Interpreter | Promise<Interpreter>;
	/** what it costs, so the budget can refuse it before the isolate OOMs */
	memory?: RuntimeMemory;
}

/**
 * A spec whose loaded type has been erased.
 *
 * The registry never inspects `loaded` - it only passes it back to the spec's own `instantiate` -
 * so the parameter is existential at that boundary. `unknown` will not do: `L` appears in an
 * argument position, so `RuntimeSpec<unknown>` is not a supertype of `RuntimeSpec<Something>`.
 */
// oxlint-disable-next-line no-explicit-any
export type AnyRuntimeSpec = RuntimeSpec<any>;

/**
 * emscripten's `ENVIRONMENT=worker` glue reads `self.location.href` at factory time and workerd has
 * no `location`, so every such build throws `Cannot read properties of undefined (reading 'href')`
 * before it reaches any of its own code. Installed once, on first use, and never overwrites a real
 * `location`.
 */
export function installLocationShim(): void {
	const g = globalThis as { location?: { href: string } };
	if (g.location) return;
	// only on workerd. node also has no `location`, and libraries branch on that to decide they are in
	// a browser: wasmoon reads `location.href` and hands it to `fs` as a filename, so shimming it
	// under node turns a working runtime into ERR_INVALID_ARG_VALUE
	if (!isWorkerd()) return;
	g.location = { href: 'https://burrow.invalid/' };
}

/**
 * Whether this is the Workers runtime.
 *
 * The user agent rather than `process.versions.node`, which `nodejs_compat` also defines: measured
 * inside workerd it reports node 22.19.0 alongside `Cloudflare-Workers`, so the node check answers
 * true in both environments and cannot tell them apart.
 *
 * @internal
 */
export function isWorkerd(): boolean {
	const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
	return nav?.userAgent === 'Cloudflare-Workers';
}

/**
 * Declares a runtime.
 *
 * Identity function at runtime beyond validation and the `location` shim; it exists so a spec is
 * type-checked against {@link RuntimeSpec} at the point it is written rather than where it is used.
 *
 * @example
 * ```ts
 * export const php = defineRuntime({
 * 	name: 'php',
 * 	load: () => import('./runtimes/php.js'),
 * 	async instantiate({ loaded, io, lines }) {
 * 		const mod = await loaded.PHPFactory({
 * 			noInitialRun: true,
 * 			stdin: () => null,
 * 			stdout: lines(io.print),
 * 			stderr: lines(io.printErr),
 * 			instantiateWasm(imports, receive) {
 * 				WebAssembly.instantiate(loaded.wasmModule, imports).then((i) =>
 * 					receive(i, loaded.wasmModule)
 * 				);
 * 				return {};
 * 			}
 * 		});
 * 		return { FS: mod.FS, callMain: (argv) => mod.callMain(argv) };
 * 	},
 * 	memory: { initial: 96 * 1024 * 1024, peak: 116 * 1024 * 1024 }
 * });
 * ```
 *
 * @throws {RuntimeError} with code `burrow.runtime.contract_violation` if the spec is malformed
 * @since 1.0.0
 */
export function defineRuntime<L>(spec: RuntimeSpec<L>): RuntimeSpec<L> {
	if (!spec.name || typeof spec.name !== 'string') {
		throw new RuntimeError(
			'a runtime spec needs a non-empty string name',
			'burrow.runtime.contract_violation'
		);
	}
	if (typeof spec.load !== 'function') {
		throw new RuntimeError(
			`runtime ${spec.name} needs a load() thunk, e.g. () => import('./php.js')`,
			'burrow.runtime.contract_violation'
		);
	}
	if (typeof spec.instantiate !== 'function') {
		throw new RuntimeError(
			`runtime ${spec.name} needs an instantiate()`,
			'burrow.runtime.contract_violation'
		);
	}
	installLocationShim();
	return spec;
}
