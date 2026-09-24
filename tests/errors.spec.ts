import { describe, expect, it } from 'vitest';
import {
	BudgetError,
	BurrowError,
	LeaseError,
	ParallelError,
	RuntimeError,
	UnknownRuntimeError
} from '../src/errors.js';

describe('the error vocabulary', () => {
	it('every error is a BurrowError with a dotted code', () => {
		const all: BurrowError[] = [
			new RuntimeError('x', 'burrow.runtime.load_failed'),
			new UnknownRuntimeError('ruby', ['php']),
			new BudgetError('php', 10, 5),
			new LeaseError('php'),
			new ParallelError('x', 'burrow.parallel.job_failed')
		];
		for (const e of all) {
			expect(e).toBeInstanceOf(BurrowError);
			expect(e).toBeInstanceOf(Error);
			expect(e.code).toMatch(/^burrow(\.[a-z_]+)+$/);
		}
	});

	it('names itself after its own class, not the base', () => {
		expect(new LeaseError('php').name).toBe('LeaseError');
		expect(new BudgetError('php', 1, 0).name).toBe('BudgetError');
	});

	it('carries the cause when one is given', () => {
		const cause = new Error('underlying');
		const e = new RuntimeError('wrapped', 'burrow.runtime.load_failed', { cause });
		expect(e.cause).toBe(cause);
	});

	it('UnknownRuntimeError lists what is available', () => {
		const e = new UnknownRuntimeError('ruby', ['php', 'lua']);
		expect(e.requested).toBe('ruby');
		expect(e.available).toEqual(['php', 'lua']);
		expect(e.message).toContain('php, lua');
	});

	it('UnknownRuntimeError says so when nothing is registered', () => {
		expect(new UnknownRuntimeError('ruby', []).message).toContain('none are registered');
	});

	it('BudgetError reports what it needed and what was free', () => {
		const e = new BudgetError('php', 100, 20);
		expect(e.required).toBe(100);
		expect(e.free).toBe(20);
		expect(e.runtime).toBe('php');
	});

	it('ParallelError names the failed slices and why, and defaults to none', () => {
		const e = new ParallelError('x', 'burrow.parallel.job_failed', {
			slices: [2],
			causes: ['boom']
		});
		expect(e.slices).toEqual([2]);
		expect(e.causes).toEqual(['boom']);
		expect(new ParallelError('x', 'burrow.parallel.no_lanes').slices).toEqual([]);
		expect(new ParallelError('x', 'burrow.parallel.no_lanes').committed).toEqual([]);
		const failed = new ParallelError('x', 'burrow.parallel.commit_failed', {
			committed: [0, 1]
		});
		expect(failed.committed).toEqual([0, 1]);
	});
});
