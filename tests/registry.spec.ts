import { describe, expect, it, vi } from 'vitest';
import { memoryFS } from '../src/adapt.js';
import { Budget } from '../src/budget.js';
import { LeaseError, RuntimeError, UnknownRuntimeError } from '../src/errors.js';
import { Burrow, contractProblem } from '../src/registry.js';
import { defineRuntime, type Interpreter, type RuntimeIo } from '../src/runtime.js';

const MiB = 1024 * 1024;
const io: RuntimeIo = { print: () => {}, printErr: () => {} };

function fakeRuntime(name: string, opts: { bytes?: number; boot?: () => void } = {}) {
	return defineRuntime({
		name,
		load: async () => ({ tag: name }),
		instantiate: ({ loaded }): Interpreter => {
			opts.boot?.();
			return {
				FS: memoryFS(),
				callMain: () => (loaded as { tag: string }).tag.length
			};
		},
		memory: { peak: opts.bytes ?? 8 * MiB }
	});
}

describe('Burrow', () => {
	it('lists what it was given', () => {
		const b = new Burrow({ runtimes: [fakeRuntime('php'), fakeRuntime('lua')] });
		expect(b.names().sort()).toEqual(['lua', 'php']);
		expect(b.has('php')).toBe(true);
		expect(b.has('ruby')).toBe(false);
	});

	it('refuses two runtimes with the same name', () => {
		expect(() => new Burrow({ runtimes: [fakeRuntime('php'), fakeRuntime('php')] })).toThrow(
			RuntimeError
		);
	});

	it('throws a naming error for an unknown runtime', async () => {
		const b = new Burrow({ runtimes: [fakeRuntime('php')] });
		await expect(b.acquire('ruby')).rejects.toThrow(UnknownRuntimeError);
		try {
			await b.acquire('ruby');
		} catch (e) {
			expect((e as UnknownRuntimeError).code).toBe('burrow.registry.unknown_runtime');
			expect((e as UnknownRuntimeError).available).toEqual(['php']);
		}
	});

	it('boots once and reuses the interpreter across leases', async () => {
		const boot = vi.fn();
		const b = new Burrow({ runtimes: [fakeRuntime('php', { boot })] });

		const first = await b.acquire('php');
		const a = await first.instantiate(io);
		first.release();

		const second = await b.acquire('php');
		const c = await second.instantiate(io);
		second.release();

		expect(boot).toHaveBeenCalledTimes(1);
		expect(a).toBe(c);
	});

	it('exposes the booted interpreter on the lease', async () => {
		const b = new Burrow({ runtimes: [fakeRuntime('php')] });
		const lease = await b.acquire('php');
		expect(lease.interpreter).toBeNull();
		await lease.instantiate(io);
		expect(lease.interpreter).not.toBeNull();
		lease.release();
	});

	it('refuses to instantiate through a released lease', async () => {
		const b = new Burrow({ runtimes: [fakeRuntime('php')] });
		const lease = await b.acquire('php');
		lease.release();
		await expect(lease.instantiate(io)).rejects.toThrow(LeaseError);
	});

	it('releases idempotently', async () => {
		const budget = new Budget({ limit: 100 * MiB, reserve: 0 });
		const b = new Burrow({ runtimes: [fakeRuntime('php')], budget });
		const lease = await b.acquire('php');
		lease.release();
		lease.release();
		expect(budget.leasesOn('php')).toBe(0);
	});

	it('releases through await using', async () => {
		const budget = new Budget({ limit: 100 * MiB, reserve: 0 });
		const b = new Burrow({ runtimes: [fakeRuntime('php')], budget });
		{
			await using lease = await b.acquire('php');
			expect(lease.name).toBe('php');
			expect(budget.leasesOn('php')).toBe(1);
		}
		expect(budget.leasesOn('php')).toBe(0);
	});

	it('surfaces a load failure as a coded error', async () => {
		const spec = defineRuntime({
			name: 'broken',
			load: async () => {
				throw new Error('module not found');
			},
			instantiate: (): Interpreter => ({ FS: memoryFS(), callMain: () => 0 })
		});
		const b = new Burrow({ runtimes: [spec] });
		const lease = await b.acquire('broken');
		await expect(lease.instantiate(io)).rejects.toMatchObject({
			code: 'burrow.runtime.load_failed'
		});
	});

	it('surfaces an instantiate failure as a coded error, and allows a retry', async () => {
		let attempts = 0;
		const spec = defineRuntime({
			name: 'flaky',
			load: async () => ({}),
			instantiate: (): Interpreter => {
				attempts++;
				if (attempts === 1) throw new Error('transient');
				return { FS: memoryFS(), callMain: () => 0 };
			}
		});
		const b = new Burrow({ runtimes: [spec] });
		const lease = await b.acquire('flaky');
		await expect(lease.instantiate(io)).rejects.toMatchObject({
			code: 'burrow.runtime.instantiate_failed'
		});
		// a stuck booting promise would make one bad boot permanent for the isolate's life
		await expect(lease.instantiate(io)).resolves.toBeDefined();
		expect(attempts).toBe(2);
	});

	it('rejects a runtime that does not satisfy the contract', async () => {
		const spec = defineRuntime({
			name: 'shapeless',
			load: async () => ({}),
			instantiate: () => ({}) as unknown as Interpreter
		});
		const b = new Burrow({ runtimes: [spec] });
		const lease = await b.acquire('shapeless');
		await expect(lease.instantiate(io)).rejects.toMatchObject({
			code: 'burrow.runtime.contract_violation'
		});
	});

	it('admits against the budget and evicts unleased residents', async () => {
		const budget = new Budget({ limit: 100 * MiB, reserve: 0 });
		const b = new Burrow({
			runtimes: [
				fakeRuntime('a', { bytes: 60 * MiB }),
				fakeRuntime('b', { bytes: 60 * MiB })
			],
			budget
		});
		const first = await b.acquire('a');
		await first.instantiate(io);
		first.release();

		const second = await b.acquire('b');
		expect(budget.has('a')).toBe(false);
		expect(b.isResident('a')).toBe(false);
		expect(budget.has('b')).toBe(true);
		second.release();
	});

	it('refuses a boot that cannot fit because the resident is leased', async () => {
		const budget = new Budget({ limit: 100 * MiB, reserve: 0 });
		const b = new Burrow({
			runtimes: [
				fakeRuntime('a', { bytes: 60 * MiB }),
				fakeRuntime('b', { bytes: 60 * MiB })
			],
			budget
		});
		const held = await b.acquire('a');
		await expect(b.acquire('b')).rejects.toMatchObject({ code: 'burrow.budget.exceeded' });
		held.release();
	});

	it('imports without booting', async () => {
		const boot = vi.fn();
		const b = new Burrow({ runtimes: [fakeRuntime('php', { boot })] });
		const loaded = await b.tryImport('php');
		expect(loaded).toEqual({ tag: 'php' });
		expect(boot).not.toHaveBeenCalled();
		expect(await b.tryImport('nope')).toBeNull();
	});

	it('drops every resident on dispose', async () => {
		const budget = new Budget({ limit: 100 * MiB, reserve: 0 });
		const b = new Burrow({ runtimes: [fakeRuntime('php')], budget });
		const lease = await b.acquire('php');
		await lease.instantiate(io);
		b.dispose();
		expect(b.isResident('php')).toBe(false);
		expect(budget.has('php')).toBe(false);
	});

	it('shares one budget across registries when given a Budget instance', async () => {
		const budget = new Budget({ limit: 100 * MiB, reserve: 0 });
		const one = new Burrow({ runtimes: [fakeRuntime('a', { bytes: 60 * MiB })], budget });
		const two = new Burrow({ runtimes: [fakeRuntime('b', { bytes: 60 * MiB })], budget });
		const held = await one.acquire('a');
		await expect(two.acquire('b')).rejects.toMatchObject({ code: 'burrow.budget.exceeded' });
		held.release();
	});
});

describe('contractProblem', () => {
	const cases: Array<[unknown, string]> = [
		[null, 'instantiate() did not answer an object'],
		[undefined, 'instantiate() did not answer an object'],
		['nope', 'instantiate() did not answer an object'],
		[{}, 'no callMain()'],
		[{ callMain: () => 0 }, 'no FS'],
		[{ callMain: () => 0, FS: {} }, 'FS has no writeFile()']
	];

	it.each(cases)('rejects %s', (value, expected) => {
		expect(contractProblem(value)).toBe(expected);
	});

	it('accepts a well-formed interpreter', () => {
		expect(contractProblem({ callMain: () => 0, FS: memoryFS() })).toBeNull();
	});
});
