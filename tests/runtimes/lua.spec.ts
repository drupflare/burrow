import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/budget.js';
import { Burrow } from '../../src/registry.js';
import { defineRuntime, type Interpreter, type RuntimeFS } from '../../src/runtime.js';

/**
 * Lua 5.4 through wasmoon, driven end to end.
 *
 * Two things this build says about the contract. `FS` is the real emscripten MEMFS, so the script a
 * session writes lands in the filesystem Lua itself reads through - nothing is faked on that path.
 * `callMain` is NOT exported, and reading it does not answer undefined: emscripten replaces an
 * unexported runtime method with a getter that calls `abort()`, so the adapter must supply one over
 * `doFileSync` rather than probe for it.
 */

const PACKAGE = 'wasmoon';

interface LuaEngineLike {
	global: { set(name: string, value: unknown): void };
	doFileSync(path: string): unknown;
}

interface LuaFactoryLike {
	getLuaModule(): Promise<{ module: { FS: RuntimeFS & { utime?: unknown } } }>;
	createEngine(): Promise<LuaEngineLike>;
}

const wasmoon = await (async () => {
	try {
		return (await import(/* @vite-ignore */ PACKAGE)) as unknown as {
			LuaFactory: new () => LuaFactoryLike;
		};
	} catch {
		return null;
	}
})();

const luaRuntime = defineRuntime({
	name: 'lua',
	load: async () => wasmoon,
	instantiate: async ({ loaded, io }): Promise<Interpreter> => {
		const { LuaFactory } = loaded as { LuaFactory: new () => LuaFactoryLike };
		const factory = new LuaFactory();
		const wasm = await factory.getLuaModule();
		const engine = await factory.createEngine();
		// Lua's own print writes to stdout, which node owns; routing it through io.print is what
		// puts the output where a host can collect it
		engine.global.set('print', (...args: unknown[]) =>
			io.print(args.map((arg) => String(arg)).join('\t'))
		);
		return {
			FS: wasm.module.FS,
			callMain: (argv) => {
				try {
					engine.doFileSync(argv[argv.length - 1] ?? '');
					return 0;
				} catch (cause) {
					io.printErr(String(cause));
					return 1;
				}
			}
		};
	},
	memory: { peak: 16 * 1024 * 1024 }
});

const registry = () =>
	new Burrow({
		runtimes: [luaRuntime],
		budget: new Budget({ limit: 256 * 1024 * 1024, reserve: 0 })
	});

const session = () => registry().session('lua', { scriptName: 'main.lua' });

describe.skipIf(wasmoon === null)('Lua 5.4 via wasmoon', () => {
	it('runs a script written into the build own filesystem', async () => {
		await using sh = await session();
		const result = await sh.eval('print("lua " .. _VERSION)\nprint(1 + 1)');
		expect(result.exitCode).toBe(0);
		expect(result.stdoutText).toBe('lua Lua 5.4\n2\n');
	});

	it('has no utime, which is why the FS contract does not require one', async () => {
		await using sh = await session();
		await sh.eval('print(1)');
		expect((sh.interpreter?.FS as { utime?: unknown }).utime).toBeUndefined();
	});

	it('answers structured output through evalJson', async () => {
		await using sh = await session();
		const value = await sh.evalJson<{ n: number }>(
			'print(string.format(\'{"n": %d}\', 20 + 22))'
		);
		expect(value).toEqual({ n: 42 });
	});

	it('keeps state between evaluations', async () => {
		await using sh = await session();
		await sh.eval('carried = "kept"');
		expect(await sh.evalText('print(carried)')).toBe('kept\n');
	});

	it('reports a nonzero exit and routes the error to stderr', async () => {
		await using sh = await session();
		const result = await sh.eval('error("deliberate")');
		expect(result.exitCode).toBe(1);
		expect(result.stderrText).toContain('deliberate');
	});
});
