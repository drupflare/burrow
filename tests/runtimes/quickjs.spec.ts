import { describe, expect, it } from 'vitest';
import { memoryFS } from '../../src/adapt.js';
import { Budget } from '../../src/budget.js';
import { Burrow } from '../../src/registry.js';
import { defineRuntime, type Interpreter } from '../../src/runtime.js';
import { fromBytes } from '../../src/session.js';

/**
 * QuickJS through quickjs-emscripten, the weakest build here against the contract.
 *
 * Its module exports NEITHER member. The runtime-method list is trimmed to `cwrap`, `UTF8ToString`
 * and the heap views, so there is no `FS` at all and no `callMain`. Both halves of the adapter are
 * therefore host-side: `memoryFS()` for the filesystem and a `newContext()` eval for the entry
 * point. This is the case `memoryFS` exists for.
 *
 * What is still real: the wasm QuickJS engine parses and executes the script, and `print` inside it
 * is a host function calling back out.
 */

interface QuickJSHandle {
	dispose(): void;
}

interface QuickJSContext {
	global: QuickJSHandle;
	newFunction(name: string, fn: (...args: QuickJSHandle[]) => void): QuickJSHandle;
	setProp(target: QuickJSHandle, key: string, value: QuickJSHandle): void;
	evalCode(source: string): { error?: QuickJSHandle; value: QuickJSHandle };
	dump(handle: QuickJSHandle): unknown;
	dispose(): void;
}

interface QuickJSLike {
	newContext(): QuickJSContext;
}

const quickjs = await (async () => {
	try {
		return (await import(/* @vite-ignore */ 'quickjs-emscripten')) as unknown as {
			getQuickJS: () => Promise<QuickJSLike>;
		};
	} catch {
		return null;
	}
})();

const quickjsRuntime = defineRuntime({
	name: 'quickjs',
	load: async () => quickjs,
	instantiate: async ({ loaded, io }): Promise<Interpreter> => {
		const { getQuickJS } = loaded as { getQuickJS: () => Promise<QuickJSLike> };
		const engine = await getQuickJS();
		const fs = memoryFS();
		return {
			FS: fs,
			callMain: (argv) => {
				const ctx = engine.newContext();
				try {
					const print = ctx.newFunction('print', (...args) =>
						io.print(args.map((arg) => String(ctx.dump(arg))).join(' '))
					);
					ctx.setProp(ctx.global, 'print', print);
					print.dispose();
					const source = fromBytes(
						fs.readFile(argv[argv.length - 1] ?? '') as Uint8Array
					);
					const evaluated = ctx.evalCode(source);
					if (evaluated.error) {
						const dumped = ctx.dump(evaluated.error) as { message?: unknown };
						io.printErr(String(dumped?.message ?? evaluated.error));
						evaluated.error.dispose();
						return 1;
					}
					evaluated.value.dispose();
					return 0;
				} finally {
					ctx.dispose();
				}
			}
		};
	},
	memory: { peak: 8 * 1024 * 1024 }
});

const session = () =>
	new Burrow({
		runtimes: [quickjsRuntime],
		budget: new Budget({ limit: 256 * 1024 * 1024, reserve: 0 })
	}).session('quickjs', { scriptName: 'main.js', argv: (path) => ['qjs', path] });

describe.skipIf(quickjs === null)('QuickJS via quickjs-emscripten', () => {
	it('runs a script through a filesystem burrow supplies', async () => {
		await using sh = await session();
		const result = await sh.eval('print("quickjs", 1 + 1)');
		expect(result.exitCode).toBe(0);
		expect(result.stdoutText).toBe('quickjs 2\n');
	});

	it('answers structured output through evalJson', async () => {
		await using sh = await session();
		expect(await sh.evalJson<{ n: number }>('print(JSON.stringify({n: 42}))')).toEqual({
			n: 42
		});
	});

	it('reports a thrown error on stderr and exits nonzero', async () => {
		await using sh = await session();
		const result = await sh.eval('throw new Error("deliberate")');
		expect(result.exitCode).toBe(1);
		expect(result.stderrText).toContain('deliberate');
	});

	it('does NOT carry state between evaluations, because each run is a fresh context', async () => {
		// the one runtime here that cannot keep session state: quickjs-emscripten's entry point is a
		// context per evaluation, and a context is the unit of isolation. Recorded rather than worked
		// around, because a caller needs to know which runtimes persist
		await using sh = await session();
		await sh.eval('globalThis.carried = "kept"');
		const result = await sh.eval('print(typeof globalThis.carried)');
		expect(result.stdoutText).toBe('undefined\n');
	});
});
