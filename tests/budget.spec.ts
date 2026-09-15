import { describe, expect, it, vi } from 'vitest';
import { Budget, DEFAULT_RESERVE, ISOLATE_LIMIT } from '../src/budget.js';
import { BudgetError } from '../src/errors.js';

const MiB = 1024 * 1024;

describe('Budget', () => {
	it('defaults to the isolate ceiling less the reserve', () => {
		const b = new Budget();
		expect(b.limit).toBe(ISOLATE_LIMIT);
		expect(b.reserve).toBe(DEFAULT_RESERVE);
		expect(b.capacity).toBe(ISOLATE_LIMIT - DEFAULT_RESERVE);
		expect(b.free).toBe(b.capacity);
	});

	it('admits what fits and accounts it', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('php', 60 * MiB);
		expect(b.has('php')).toBe(true);
		expect(b.used).toBe(60 * MiB);
		expect(b.free).toBe(40 * MiB);
		expect(b.bytesOf('php')).toBe(60 * MiB);
	});

	it('refuses a runtime larger than capacity outright', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		expect(() => b.admit('huge', 200 * MiB)).toThrow(BudgetError);
		try {
			b.admit('huge', 200 * MiB);
		} catch (e) {
			expect((e as BudgetError).code).toBe('burrow.budget.exceeded');
			expect((e as BudgetError).runtime).toBe('huge');
			expect((e as BudgetError).required).toBe(200 * MiB);
		}
	});

	it('evicts the least recently used unleased resident to make room', () => {
		const onEvict = vi.fn();
		const b = new Budget({ limit: 100 * MiB, reserve: 0, onEvict });
		b.admit('a', 40 * MiB);
		b.admit('b', 40 * MiB);
		// touch a so b is the older one
		b.admit('a', 40 * MiB);
		b.admit('c', 40 * MiB);
		expect(onEvict).toHaveBeenCalledWith('b');
		expect(b.has('b')).toBe(false);
		expect(b.has('a')).toBe(true);
		expect(b.has('c')).toBe(true);
	});

	it('never evicts a leased resident', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 60 * MiB);
		b.lease('a');
		expect(() => b.admit('b', 60 * MiB)).toThrow(BudgetError);
		expect(b.has('a')).toBe(true);
	});

	it('makes a resident evictable again once every lease is released', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 60 * MiB);
		b.lease('a');
		b.lease('a');
		expect(b.leasesOn('a')).toBe(2);
		b.release('a');
		expect(() => b.admit('b', 60 * MiB)).toThrow(BudgetError);
		b.release('a');
		expect(b.leasesOn('a')).toBe(0);
		b.admit('b', 60 * MiB);
		expect(b.has('b')).toBe(true);
		expect(b.has('a')).toBe(false);
	});

	it('re-admitting a resident refreshes it rather than double counting', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 40 * MiB);
		b.admit('a', 40 * MiB);
		expect(b.used).toBe(40 * MiB);
	});

	it('replaces a declared size with an observed one', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 10 * MiB);
		b.record('a', 70 * MiB);
		expect(b.bytesOf('a')).toBe(70 * MiB);
		expect(b.free).toBe(30 * MiB);
	});

	it('reports an overcommit honestly rather than clamping it', () => {
		// a spec that under-declares can push used past capacity once observed; the next admission
		// is what deals with it, and hiding the overshoot here would hide the cause
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 10 * MiB);
		b.record('a', 150 * MiB);
		expect(b.used).toBe(150 * MiB);
		expect(b.free).toBeLessThan(0);
	});

	it('orders residents least recently used first', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 1);
		b.admit('b', 1);
		b.admit('c', 1);
		b.admit('a', 1);
		expect(b.residents()).toEqual(['b', 'c', 'a']);
	});

	it('forgets a resident outright, leased or not', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		b.admit('a', 40 * MiB);
		b.lease('a');
		b.forget('a');
		expect(b.has('a')).toBe(false);
		expect(b.used).toBe(0);
	});

	it('ignores lease bookkeeping for names that are not resident', () => {
		const b = new Budget({ limit: 100 * MiB, reserve: 0 });
		expect(() => {
			b.lease('ghost');
			b.release('ghost');
			b.record('ghost', 1);
		}).not.toThrow();
		expect(b.leasesOn('ghost')).toBe(0);
		expect(b.bytesOf('ghost')).toBeNull();
	});
});
