import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { memoryFS } from '../../src/adapt.js';
import { Budget } from '../../src/budget.js';
import { Burrow } from '../../src/registry.js';
import { defineRuntime, type Interpreter, type RuntimeIo } from '../../src/runtime.js';

/**
 * Java via bytebox, and the question this lane exists to answer.
 *
 * Java is the only language here that is **compiled rather than interpreted**. bytebox is a
 * toolchain: a Gradle build turns Java into WebAssembly through TeaVM and the npm package is the
 * loader that runs the result. So there is no multi-megabyte runtime in `node_modules` to reach for
 * - the fixture is 19 KB because the program is the only thing in it.
 *
 * That difference is what the dynamic-class-loading tests below turn on. The other runtimes are
 * interpreters that take a program as DATA, so `burrow` gives them arbitrary source at request time.
 * bytebox's artifact **is** the program.
 *
 * The fixture is `tests/fixtures/java.wasm`, compiled from `Cartridge.java` beside it, and is the
 * same artifact `@drupflare/cartridge` drives. TeaVM emits no emscripten runtime and therefore no
 * filesystem at all, so the interpreter's `FS` is burrow's own `memoryFS()` and the compiled program
 * reads back through a module the adapter supplies under the name the Java source imported.
 */

const FS_MODULE = 'cartridge:fs';
const HERE = import.meta.url;

interface ByteboxModule {
	exports: Record<string, unknown>;
	call(name: string, ...args: unknown[]): unknown;
	drainAsync(): Promise<{ drained: boolean; pending: number }>;
}

interface ByteboxLike {
	load(options: {
		runtime: unknown;
		bytes: Uint8Array;
		print?: (line: string) => void;
		printErr?: (line: string) => void;
		modules?: Record<string, unknown>;
	}): ByteboxModule;
	requiredModules?: (bytes: Uint8Array) => unknown;
}

const bytebox = await (async () => {
	try {
		return (await import(/* @vite-ignore */ '@gmitch215/bytebox')) as unknown as ByteboxLike;
	} catch {
		return null;
	}
})();

const fixture = async () => ({
	runtime: await import('../fixtures/java.wasm-runtime.js'),
	// a path string rather than a URL: workers-types and node:url declare different URL classes, so
	// neither readFile's URL overload nor fileURLToPath accepts the one in scope here
	bytes: new Uint8Array(await readFile(new URL('../fixtures/java.wasm', HERE).pathname))
});

const javaRuntime = defineRuntime({
	name: 'java',
	load: async () => ({ bytebox, ...(await fixture()) }),
	instantiate: ({ loaded, io }): Interpreter => {
		const {
			bytebox: box,
			runtime,
			bytes
		} = loaded as {
			bytebox: ByteboxLike;
			runtime: unknown;
			bytes: Uint8Array;
		};
		const fs = memoryFS();
		const decoder = new TextDecoder();
		// rebound per instantiate rather than passed to load(), because the module is compiled before
		// the host hands its collectors over
		let sink: RuntimeIo = io;
		const module = box.load({
			runtime,
			bytes,
			print: (line) => sink.print(line),
			printErr: (line) => sink.printErr(line),
			// the reading half only; a compiled program has no business writing the script back
			modules: {
				[FS_MODULE]: {
					readText: (path: string) => {
						try {
							return decoder.decode(fs.readFile(path) as Uint8Array);
						} catch {
							return null;
						}
					}
				}
			}
		});
		sink = io;
		return {
			FS: fs,
			callMain: async (argv) => {
				try {
					module.call('main', argv);
					// awaited rather than drained synchronously: a Java thread on this target is a
					// fiber on the host queue, and work main queued has not run when it returns
					const drain = await module.drainAsync();
					if (!drain.drained) {
						io.printErr(`${drain.pending} fiber(s) still queued after main`);
						return 1;
					}
					return 0;
				} catch (cause) {
					io.printErr(`Exception in thread "main" ${String(cause)}`);
					return 1;
				}
			}
		};
	},
	memory: { peak: 8 * 1024 * 1024 }
});

const session = () =>
	new Burrow({
		runtimes: [javaRuntime],
		budget: new Budget({ limit: 256 * 1024 * 1024, reserve: 0 })
	}).session('java', { scriptName: 'main.txt', argv: (path) => ['java', path] });

describe.skipIf(bytebox === null)('Java via bytebox', () => {
	it('runs a compiled program and reads the script back as data', async () => {
		await using sh = await session();
		const result = await sh.eval('hello from the host');
		expect(result.exitCode).toBe(0);
		expect(result.stdoutText).toContain('argv:java,/burrow/main.txt');
		expect(result.stdoutText).toContain('read:hello from the host');
	});

	it('reports an uncaught throwable on stderr and exits nonzero', async () => {
		await using sh = await session();
		const result = await sh.eval('throw please');
		expect(result.exitCode).toBe(1);
		expect(result.stderrText).toContain('Exception in thread "main"');
	});

	it('keeps the compiled module across evaluations', async () => {
		await using sh = await session();
		await sh.eval('first');
		const before = sh.interpreter;
		await sh.eval('second');
		expect(sh.interpreter).toBe(before);
	});
});

/**
 * Does burrow unblock dynamic class loading for bytebox?
 *
 * No, and the reason is TeaVM's compilation model rather than Cloudflare's codegen ban. burrow
 * removes one barrier, executing code the deployment never saw; TeaVM's barrier sits upstream of
 * that, because whole-program closed-world compilation discards everything it proved unreachable,
 * so a class that was never compiled has no metadata and no name to resolve.
 *
 * The two assertions below measure that rather than assert it. Reasoning and the two things burrow
 * does unlock for Java are in `java-has-no-artifact.md` in project memory.
 */
describe.skipIf(bytebox === null)('Java: dynamic class loading', () => {
	it('exposes only what the build compiled, with no classloader surface', async () => {
		const { runtime, bytes } = await fixture();
		const module = (bytebox as ByteboxLike).load({
			runtime,
			bytes,
			modules: { [FS_MODULE]: { readText: () => null } }
		});
		const names = Object.keys(module.exports).map((n) => n.toLowerCase());
		// a JVM would offer one of these; an AOT artifact offers none, because there is no runtime
		// representation of a class for a new one to be attached to
		for (const surface of ['defineclass', 'loadclass', 'classloader', 'forname']) {
			expect(names.some((n) => n.includes(surface))).toBe(false);
		}
		expect(Object.keys(module.exports)).toContain('main');
	});

	it('has no entry point that accepts class bytes at runtime', async () => {
		const { runtime, bytes } = await fixture();
		const module = (bytebox as ByteboxLike).load({
			runtime,
			bytes,
			modules: { [FS_MODULE]: { readText: () => null } }
		});
		// every export is a compiled entry point taking the program's own argument shapes; there is
		// nowhere to hand a .class file, which is what "closed-world AOT" means concretely
		expect(() =>
			module.call('defineClass', new Uint8Array([0xca, 0xfe, 0xba, 0xbe]))
		).toThrow();
	});
});
