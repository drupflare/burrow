import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/budget.js';
import { Burrow } from '../../src/registry.js';
import { defineRuntime, type Interpreter, type RuntimeFS } from '../../src/runtime.js';

/**
 * CPython 3 through Pyodide, driven end to end.
 *
 * A real CPython built to wasm32-emscripten. Its `FS` is the complete emscripten one, `utime`
 * included, unlike wasmoon's - which is the measurement behind `RuntimeFS` declaring `analyzePath`
 * optional rather than requiring the full surface. `callMain` is `undefined`, so the adapter enters
 * through `runpy` and CPython opens and compiles the script out of its own filesystem.
 */

interface PyodideLike {
	FS: RuntimeFS & { utime?: unknown };
	runPython(source: string): unknown;
}

const pyodide = await (async () => {
	try {
		return (await import(/* @vite-ignore */ 'pyodide')) as unknown as {
			loadPyodide: (options: unknown) => Promise<PyodideLike>;
		};
	} catch {
		return null;
	}
})();

const pythonRuntime = defineRuntime({
	name: 'python',
	load: async () => pyodide,
	instantiate: async ({ loaded, io }): Promise<Interpreter> => {
		const { loadPyodide } = loaded as {
			loadPyodide: (options: unknown) => Promise<PyodideLike>;
		};
		const py = await loadPyodide({ stdout: io.print, stderr: io.printErr });
		return {
			FS: py.FS,
			callMain: (argv) => {
				const path = argv[argv.length - 1] ?? '';
				try {
					py.runPython(
						`import runpy; runpy.run_path(${JSON.stringify(path)}, run_name='__main__')`
					);
					return 0;
				} catch (cause) {
					io.printErr(String(cause));
					return 1;
				}
			}
		};
	},
	memory: { peak: 128 * 1024 * 1024 }
});

const session = () =>
	new Burrow({
		runtimes: [pythonRuntime],
		budget: new Budget({ limit: 512 * 1024 * 1024, reserve: 0 })
	}).session('python', { scriptName: 'main.py', argv: (path) => ['python', path] });

describe.skipIf(pyodide === null)(
	'CPython 3 via Pyodide',
	() => {
		it('runs a script written into the build own filesystem', async () => {
			await using sh = await session();
			const result = await sh.eval('import sys\nprint("python", sys.version_info.major)');
			expect(result.exitCode).toBe(0);
			expect(result.stdoutText).toContain('python 3');
		});

		it('exposes a complete emscripten FS, utime included', async () => {
			await using sh = await session();
			await sh.eval('pass');
			const fs = sh.interpreter?.FS as { utime?: unknown; mkdir?: unknown };
			expect(typeof fs.mkdir).toBe('function');
			expect(typeof fs.utime).toBe('function');
		});

		it('answers structured output through evalJson', async () => {
			await using sh = await session();
			const value = await sh.evalJson<{ n: number }>(
				'import json\nprint(json.dumps({"n": 42}))'
			);
			expect(value).toEqual({ n: 42 });
		});

		it('reports a traceback on stderr and exits nonzero', async () => {
			await using sh = await session();
			const result = await sh.eval('raise ValueError("deliberate")');
			expect(result.exitCode).toBe(1);
			expect(result.stderrText).toContain('deliberate');
		});

		it('seeds files the guest reads through its own filesystem', async () => {
			await using sh = await session();
			await sh.write('/data/in.txt', 'seeded');
			expect(await sh.evalText('print(open("/data/in.txt").read())')).toBe('seeded\n');
		});
	},
	180000
);
