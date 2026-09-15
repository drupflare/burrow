import { describe, expect, it, vi } from 'vitest';
import { memoryFS } from '../src/adapt.js';
import { Budget } from '../src/budget.js';
import { Burrow } from '../src/registry.js';
import { defineRuntime, type Interpreter, type RuntimeIo } from '../src/runtime.js';
import { fromBytes, makeResult, Session, toBytes } from '../src/session.js';

const MiB = 1024 * 1024;

/**
 * A runtime whose "program" is the script it is handed: whatever bytes land at the script path are
 * echoed to stdout, so a session can be driven without any real interpreter.
 */
function echoRuntime(name = 'echo', onCall?: () => void) {
	return defineRuntime({
		name,
		load: async () => ({}),
		instantiate: ({ io }): Interpreter => {
			const FS = memoryFS();
			return {
				FS,
				callMain: (argv) => {
					onCall?.();
					const path = argv[argv.length - 1] ?? '';
					const source = fromBytes(FS.readFile(path) as Uint8Array);
					if (source.startsWith('!fail')) {
						io.printErr(source.slice(5));
						return 1;
					}
					for (const line of source.split('\n')) io.print(line);
					return 0;
				}
			};
		},
		memory: { peak: 4 * MiB }
	});
}

function registry(spec = echoRuntime()) {
	return new Burrow({ runtimes: [spec], budget: new Budget({ limit: 64 * MiB, reserve: 0 }) });
}

describe('Session', () => {
	it('evaluates and answers stdout as bytes and text', async () => {
		await using sh = await registry().session('echo');
		const result = await sh.eval('hello');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBeInstanceOf(Uint8Array);
		expect(result.stdoutText).toBe('hello\n');
		expect(result.text()).toBe('hello\n');
	});

	it('accepts bytes as readily as a string', async () => {
		await using sh = await registry().session('echo');
		expect(await sh.evalText(toBytes('from bytes'))).toBe('from bytes\n');
	});

	it('parses stdout as JSON', async () => {
		await using sh = await registry().session('echo');
		expect(await sh.evalJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
	});

	it('throws a SyntaxError when stdout is not JSON', async () => {
		await using sh = await registry().session('echo');
		await expect(sh.evalJson('not json')).rejects.toThrow(SyntaxError);
	});

	it('separates stderr from stdout and reports a nonzero exit', async () => {
		await using sh = await registry().session('echo');
		const result = await sh.eval('!fail something broke');
		expect(result.exitCode).toBe(1);
		expect(result.stdoutText).toBe('');
		expect(result.stderrText).toBe(' something broke\n');
	});

	it('boots once across evaluations, which is what makes state persist', async () => {
		const onCall = vi.fn();
		const boots = vi.fn();
		const spec = defineRuntime({
			name: 'counting',
			load: async () => ({}),
			instantiate: ({ io }): Interpreter => {
				boots();
				const FS = memoryFS();
				return {
					FS,
					callMain: () => {
						onCall();
						io.print('ok');
						return 0;
					}
				};
			}
		});
		await using sh = await registry(spec).session('counting');
		await sh.eval('a');
		await sh.eval('b');
		expect(boots).toHaveBeenCalledTimes(1);
		expect(onCall).toHaveBeenCalledTimes(2);
	});

	it('does not leak one evaluation output into the next', async () => {
		await using sh = await registry().session('echo');
		await sh.eval('first');
		const second = await sh.eval('second');
		expect(second.stdoutText).toBe('second\n');
	});

	it('round-trips files through the guest filesystem', async () => {
		await using sh = await registry().session('echo');
		await sh.write('/data/nested/file.txt', 'payload');
		expect(await sh.readText('/data/nested/file.txt')).toBe('payload');
		expect(await sh.read('/data/nested/file.txt')).toBeInstanceOf(Uint8Array);
	});

	it('seeds files before the first evaluation', async () => {
		await using sh = await registry().session('echo', {
			files: { '/seed.txt': 'seeded', '/bin/data': toBytes('bytes') }
		});
		await sh.eval('trigger the boot');
		expect(await sh.readText('/seed.txt')).toBe('seeded');
		expect(await sh.readText('/bin/data')).toBe('bytes');
	});

	it('honours a custom script path and argv', async () => {
		const seen: string[][] = [];
		const spec = defineRuntime({
			name: 'argv',
			load: async () => ({}),
			instantiate: ({ io }): Interpreter => ({
				FS: memoryFS(),
				callMain: (argv) => {
					seen.push(argv);
					io.print('done');
					return 0;
				}
			})
		});
		await using sh = await registry(spec).session('argv', {
			scriptDir: '/opt/scripts/',
			scriptName: 'run.php',
			argv: (path) => ['-f', path]
		});
		await sh.eval('x');
		expect(seen[0]).toEqual(['-f', '/opt/scripts/run.php']);
	});

	it('exposes the interpreter only once booted', async () => {
		await using sh = await registry().session('echo');
		expect(sh.interpreter).toBeNull();
		await sh.eval('x');
		expect(sh.interpreter).not.toBeNull();
	});

	it('releases its lease on dispose, idempotently', async () => {
		const budget = new Budget({ limit: 64 * MiB, reserve: 0 });
		const b = new Burrow({ runtimes: [echoRuntime()], budget });
		const sh = await b.session('echo');
		expect(budget.leasesOn('echo')).toBe(1);
		sh.dispose();
		sh.dispose();
		expect(budget.leasesOn('echo')).toBe(0);
	});

	it('releases its lease when the block exits', async () => {
		const budget = new Budget({ limit: 64 * MiB, reserve: 0 });
		const b = new Burrow({ runtimes: [echoRuntime()], budget });
		{
			await using sh = await b.session('echo');
			await sh.eval('x');
			expect(budget.leasesOn('echo')).toBe(1);
		}
		expect(budget.leasesOn('echo')).toBe(0);
	});

	it('treats a void exit status as success', async () => {
		const spec = defineRuntime({
			name: 'voidmain',
			load: async () => ({}),
			instantiate: (): Interpreter => ({ FS: memoryFS(), callMain: () => undefined })
		});
		await using sh = await registry(spec).session('voidmain');
		expect((await sh.eval('x')).exitCode).toBe(0);
	});

	it('awaits an asynchronous callMain', async () => {
		const spec = defineRuntime({
			name: 'async',
			load: async () => ({}),
			instantiate: ({ io }): Interpreter => ({
				FS: memoryFS(),
				callMain: async () => {
					await Promise.resolve();
					io.print('late');
					return 7;
				}
			})
		});
		await using sh = await registry(spec).session('async');
		const result = await sh.eval('x');
		expect(result.exitCode).toBe(7);
		expect(result.stdoutText).toBe('late\n');
	});
});

describe('the byte codecs', () => {
	it('round-trips text', () => {
		expect(fromBytes(toBytes('café'))).toBe('café');
	});

	it('passes bytes through untouched', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		expect(toBytes(bytes)).toBe(bytes);
	});
});

describe('makeResult', () => {
	it('exposes the same stdout as a field, a getter and a call', () => {
		const r = makeResult(0, [...toBytes('hi')], []);
		expect(r.stdoutText).toBe('hi');
		expect(r.text()).toBe('hi');
		expect(fromBytes(r.stdout)).toBe('hi');
	});

	it('keeps stderr separate', () => {
		const r = makeResult(2, [], [...toBytes('bad')]);
		expect(r.exitCode).toBe(2);
		expect(r.stderrText).toBe('bad');
		expect(r.stdoutText).toBe('');
	});
});

describe('a Session built directly', () => {
	it('drives a host without a registry', async () => {
		const FS = memoryFS();
		const release = vi.fn();
		const io: { current?: RuntimeIo } = {};
		const sh = new Session({
			instantiate: async (given) => {
				io.current = given;
				return {
					FS,
					callMain: () => {
						io.current?.print('direct');
						return 0;
					}
				};
			},
			release
		});
		expect(await sh.evalText('x')).toBe('direct\n');
		sh.dispose();
		expect(release).toHaveBeenCalledTimes(1);
	});
});
