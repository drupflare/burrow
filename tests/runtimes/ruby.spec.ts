import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { memoryFS } from '../../src/adapt.js';
import { Budget } from '../../src/budget.js';
import { Burrow } from '../../src/registry.js';
import { defineRuntime, type Interpreter } from '../../src/runtime.js';

/**
 * CRuby 3.4 through ruby.wasm, driven end to end.
 *
 * The only WASI build in the suite, and a different shape from every emscripten one. There is no
 * `FS` object at all: the filesystem is a WASI preopen the host supplies, so `memoryFS()` satisfies
 * the contract and Ruby never reads through it. There is no usable `callMain` either, because the
 * module's `_start` runs the interpreter to completion and cannot be re-entered; the adapter enters
 * through `vm.eval`, which is also what carries state across evaluations.
 *
 * The WASI shim is `@bjorn3/browser_wasi_shim` rather than node's built-in `wasi`, because workerd
 * has no such built-in. Verifying against the portable one is the point of the lane.
 */

const RUBY = '@ruby/3.4-wasm-wasi/dist/ruby+stdlib.wasm';
const SHIM = '@bjorn3/browser_wasi_shim';
const VM = '@ruby/wasm-wasi';

interface RbValue {
	toString(): string;
}

interface Loaded {
	module: WebAssembly.Module;
	RubyVM: new () => {
		eval(code: string): RbValue;
		initialize(args?: string[]): void;
		setInstance(instance: WebAssembly.Instance): Promise<void>;
		addToImports(imports: WebAssembly.Imports): void;
	};
	WASI: new (
		args: string[],
		env: string[],
		fds: unknown[]
	) => {
		wasiImport: WebAssembly.ModuleImports;
		initialize(instance: { exports: WebAssembly.Exports }): void;
	};
	OpenFile: new (file: unknown) => unknown;
	File: new (data: Uint8Array) => unknown;
	PreopenDirectory: new (name: string, contents: Map<string, unknown>) => unknown;
}

const loaded = await (async (): Promise<Loaded | null> => {
	try {
		const { RubyVM } = (await import(/* @vite-ignore */ VM)) as unknown as {
			RubyVM: Loaded['RubyVM'];
		};
		const shim = (await import(/* @vite-ignore */ SHIM)) as unknown as {
			WASI: Loaded['WASI'];
			OpenFile: Loaded['OpenFile'];
			File: Loaded['File'];
			PreopenDirectory: Loaded['PreopenDirectory'];
		};
		const path = new URL(`../../node_modules/${RUBY}`, import.meta.url).pathname;
		// workers-types declares WebAssembly.Module abstract, so the constructor is re-declared here
		const Module = WebAssembly.Module as unknown as new (b: BufferSource) => WebAssembly.Module;
		return { module: new Module(await readFile(path)), RubyVM, ...shim };
	} catch {
		return null;
	}
})();

const rubyRuntime = defineRuntime({
	name: 'ruby',
	load: async () => loaded,
	instantiate: async ({ loaded: built, io }): Promise<Interpreter> => {
		const { module, RubyVM, WASI, OpenFile, File, PreopenDirectory } = built as Loaded;

		// fds 0, 1 and 2, then a preopen; ruby.wasm refuses to boot without a writable root
		const wasi = new WASI(
			[],
			[],
			[
				new OpenFile(new File(new Uint8Array())),
				new OpenFile(new File(new Uint8Array())),
				new OpenFile(new File(new Uint8Array())),
				new PreopenDirectory('/', new Map())
			]
		);

		const fs = memoryFS();
		const vm = new RubyVM();
		const imports: WebAssembly.Imports = { wasi_snapshot_preview1: wasi.wasiImport };
		vm.addToImports(imports);

		const instance = await WebAssembly.instantiate(module, imports);
		wasi.initialize(instance as unknown as { exports: WebAssembly.Exports });
		await vm.setInstance(instance);
		vm.initialize(['ruby.wasm', '-EUTF-8', '-e_=0']);
		// required once, so a caller's script does not have to ask for the capture buffers itself
		vm.eval('require "stringio"; require "json"');

		return {
			FS: fs,
			callMain: (argv) => {
				// the session writes the script into FS and passes its PATH, as every lane does
				const path = argv[argv.length - 1] ?? '';
				try {
					const source = fs.readFile(path, { encoding: 'utf8' }) as string;
					// JSON rather than a separator character: all three parts are arbitrary user
					// output and any sentinel could occur inside them
					const out = vm.eval(`$stdout = StringIO.new; $stderr = StringIO.new
begin
  ${source}
  [0, $stdout.string, $stderr.string].to_json
rescue Exception => e
  [1, $stdout.string, $stderr.string + e.message].to_json
end`);
					const [code, stdout, stderr] = JSON.parse(out.toString()) as [
						number,
						string,
						string
					];
					// io.print supplies the newline, so the captured trailing one is stripped
					if (stdout) io.print(stdout.replace(/\n$/, ''));
					if (stderr) io.printErr(stderr.replace(/\n$/, ''));
					return code;
				} catch (cause) {
					io.printErr(String(cause));
					return 1;
				}
			}
		};
	},
	memory: { peak: 64 * 1024 * 1024 }
});

const registry = () =>
	new Burrow({
		runtimes: [rubyRuntime],
		budget: new Budget({ limit: 512 * 1024 * 1024, reserve: 0 })
	});

const session = () => registry().session('ruby', { scriptName: 'main.rb' });

describe.skipIf(loaded === null)('CRuby 3.4 via ruby.wasm over WASI', () => {
	it('runs arbitrary Ruby supplied at request time', async () => {
		await using sh = await session();
		const result = await sh.eval('puts "ruby #{RUBY_VERSION}"');
		expect(result.exitCode).toBe(0);
		expect(result.stdoutText).toMatch(/^ruby 3\.4\./);
	});

	it('evaluates expressions the deployment never saw', async () => {
		await using sh = await session();
		expect(await sh.evalText('puts [1,2,3].sum * 7')).toBe('42\n');
	});

	it('answers structured output through evalJson', async () => {
		await using sh = await session();
		const value = await sh.evalJson<{ n: number }>('puts({ n: 20 + 22 }.to_json)');
		expect(value).toEqual({ n: 42 });
	});

	it('keeps state between evaluations, which is what a session is for', async () => {
		await using sh = await session();
		await sh.eval('$carried = "kept"');
		expect(await sh.evalText('puts $carried')).toBe('kept\n');
	});

	it('reports a nonzero exit and routes the message to stderr', async () => {
		await using sh = await session();
		const result = await sh.eval('raise "deliberate"');
		expect(result.exitCode).toBe(1);
		expect(result.stderrText).toContain('deliberate');
	});

	it('satisfies the FS contract from burrow rather than from the build', async () => {
		await using sh = await session();
		await sh.eval('puts 1');
		// a WASI preopen is not an emscripten FS, so there is nothing on the module to adapt
		expect(typeof sh.interpreter?.FS.writeFile).toBe('function');
	});
});
