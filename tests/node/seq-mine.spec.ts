import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInterpreter } from '../../src/interpret.js';
import { profile, runsOf, stubImports, type Site } from '../../tools/interp/trace.js';
import { formatTrace, main, mine, parseTrace, toFuseCatalog } from '../../tools/seq-mine.js';
import { wat } from './wat.js';

/**
 * The sequence miner and burrow's trace producer.
 *
 * The miner is interpreter-agnostic, so its cases are written in made-up operation names. What they
 * pin is the accounting: a sequence fires as often as its first operation, and a merge is never
 * taken where it would remove less than it gives up.
 */

describe('parseTrace', () => {
	it('reads operations and weights, a blank line ending a run', () => {
		expect(parseTrace('# header\na 3\nb\n\nc 2\n')).toEqual([
			{ ops: ['a', 'b'], weights: [3, 1] },
			{ ops: ['c'], weights: [2] }
		]);
	});

	it('merges identical runs by summing position by position', () => {
		expect(parseTrace('a 1\nb 2\n\na 10\nb 20\n\n\n')).toEqual([
			{ ops: ['a', 'b'], weights: [11, 22] }
		]);
	});

	it('refuses a weight that is not a non-negative number, or a third column', () => {
		expect(() => parseTrace('a x')).toThrow(/line 1/);
		expect(() => parseTrace('a 1\nb -1')).toThrow(/line 2/);
		expect(() => parseTrace('a 1 2')).toThrow(/line 1/);
	});

	it('round-trips through formatTrace', () => {
		const runs = [
			{ ops: ['a', 'b'], weights: [4, 5] },
			{ ops: ['c'], weights: [0] }
		];
		expect(parseTrace(formatTrace(runs))).toEqual(runs);
	});
});

describe('mine', () => {
	const runs = parseTrace('a 10\nb 10\nc 10\n\na 5\nb 5\n');

	it('merges the pair that removes the most, then grows it', () => {
		const [one, two] = mine(runs, { budgets: [1, 2] }).catalogs;
		expect(one?.entries).toEqual([{ ops: ['a', 'b'], fires: 15, removed: 15 }]);
		expect(one?.coverage).toBeCloseTo(30 / 40);
		expect(one?.removed).toBeCloseTo(15 / 40);
		expect(two?.entries.map((e) => e.ops.join(''))).toEqual(['abc', 'ab']);
		expect(two?.coverage).toBeCloseTo(1);
		expect(two?.removed).toBeCloseTo(25 / 40);
	});

	it('fires a sequence as often as its first operation', () => {
		// b is also entered from elsewhere; fusing a with it removes only a's dispatches
		const [c] = mine(parseTrace('a 1\nb 100\n'), { budgets: [4] }).catalogs;
		expect(c?.entries).toEqual([{ ops: ['a', 'b'], fires: 1, removed: 1 }]);
	});

	it('never takes a merge that gives up more than it removes', () => {
		// once q r is fused, prefixing p would fire it once instead of fifty times
		const [c] = mine(parseTrace('p 1\nq 50\nr 50\n'), { budgets: [4] }).catalogs;
		expect(c?.entries.map((e) => e.ops)).toEqual([['q', 'r']]);
	});

	it('keeps sequences within the width limit', () => {
		const [c] = mine(parseTrace('a\nb\nc\nd\n'), { budgets: [8], maxWidth: 2 }).catalogs;
		expect(c?.entries.every((e) => e.ops.length === 2)).toBe(true);
		expect(c?.entries).toHaveLength(2);
	});

	it('pairs a repeated operation without overlap', () => {
		const [c] = mine(parseTrace('a\na\na\n'), { budgets: [8], maxWidth: 2 }).catalogs;
		expect(c?.entries).toEqual([{ ops: ['a', 'a'], fires: 1, removed: 1 }]);
	});

	it('answers an empty catalog when nothing repeats or nothing ran', () => {
		const mined = mine(parseTrace('a 3\n\nb 0\nc 0\n'));
		expect(mined.total).toBe(3);
		expect(mined.catalogs.map((c) => c.entries.length)).toEqual([0, 0, 0]);
		expect(mine([]).catalogs[0]?.coverage).toBe(0);
	});
});

describe('toFuseCatalog', () => {
	it('answers gen-fuse shape, keeping only the widths its operations need', () => {
		const [c] = mine(runs(), { budgets: [1] }).catalogs;
		expect(toFuseCatalog(c!, { a: 2, b: 3, z: 9 })).toEqual({
			handlers: [['a', 'b']],
			widths: { a: 2, b: 3 }
		});
		expect(toFuseCatalog(c!).widths).toEqual({});
	});

	function runs() {
		return parseTrace('a 4\nb 4\n');
	}
});

describe('the command line', () => {
	it('prints coverage at each budget and writes the chosen catalog', () => {
		const dir = mkdtempSync(join(tmpdir(), 'burrow-mine-'));
		writeFileSync(join(dir, 'trace.txt'), 'a 4\nb 4\nc 4\n');
		writeFileSync(join(dir, 'widths.json'), JSON.stringify({ a: 2, b: 2, c: 3 }));
		const lines: string[] = [];
		const code = main(
			[
				join(dir, 'trace.txt'),
				'--budget',
				'1',
				'--max-width',
				'3',
				'--widths',
				join(dir, 'widths.json'),
				'--out',
				join(dir, 'catalog.json')
			],
			(l) => lines.push(l)
		);
		expect(code).toBe(0);
		expect(lines).toHaveLength(4);
		expect(JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'))).toEqual({
			handlers: [['a', 'b', 'c']],
			widths: { a: 2, b: 2, c: 3 }
		});
	});

	it('weighs several traces equally under --balance', () => {
		const dir = mkdtempSync(join(tmpdir(), 'burrow-mine-'));
		// b's pair runs far more often, so without balancing it wins the only slot
		writeFileSync(join(dir, 'a.txt'), 'x 3\ny 3\n\np 1\nq 1\n');
		writeFileSync(join(dir, 'b.txt'), 'p 1000\nq 1000\n\nz 99000\n');
		writeFileSync(join(dir, 'w1.json'), JSON.stringify({ x: 2 }));
		writeFileSync(join(dir, 'w2.json'), JSON.stringify({ y: 3 }));
		const run = (...extra: string[]) => {
			const out = join(dir, 'catalog.json');
			const args = [join(dir, 'a.txt'), join(dir, 'b.txt'), '--budget', '1', '--out', out];
			expect(main([...args, ...extra], () => {})).toBe(0);
			return JSON.parse(readFileSync(out, 'utf8')) as {
				handlers: string[][];
				widths: object;
			};
		};
		expect(run().handlers).toEqual([['p', 'q']]);
		const balanced = run(
			'--balance',
			'--widths',
			join(dir, 'w1.json'),
			'--widths',
			join(dir, 'w2.json')
		);
		expect(balanced.handlers).toEqual([['x', 'y']]);
		expect(balanced.widths).toEqual({ x: 2, y: 3 });
	});

	it('answers 2 with usage for a missing trace or a bad number', () => {
		const lines: string[] = [];
		expect(main([], (l) => lines.push(l))).toBe(2);
		expect(main(['t', '--budget', '0'], (l) => lines.push(l))).toBe(2);
		expect(main(['t', '--max-width', '1'], (l) => lines.push(l))).toBe(2);
		expect(lines.every((l) => l.startsWith('usage'))).toBe(true);
	});
});

describe('runsOf', () => {
	const site = (pc: number, op: string, count = 7): Site => ({ pc, op, count });
	const fusible = new Set(['add', 'load', 'store']);

	it('joins fusible neighbours one operation apart and learns each width', () => {
		const { runs, widths } = runsOf(
			[site(100, 'add'), site(108, 'load'), site(120, 'store'), site(132, 'add')],
			fusible
		);
		expect(widths).toEqual({ add: 2, load: 3, store: 3 });
		expect(runs).toEqual([{ ops: ['add', 'load', 'store', 'add'], weights: [7, 7, 7, 7] }]);
	});

	it('gives an operation no tile can hold a run of its own', () => {
		const { runs } = runsOf(
			[site(0, 'add'), site(8, 'call'), site(16, 'add'), site(24, 'add')],
			fusible
		);
		expect(runs.map((r) => r.ops)).toEqual([['add'], ['call'], ['add', 'add']]);
	});

	it('cuts at a site that never ran and at a gap in the code', () => {
		const { runs } = runsOf(
			[site(0, 'add'), site(8, 'add', 0), site(16, 'add'), site(24, 'add'), site(64, 'add')],
			fusible
		);
		expect(runs.map((r) => r.ops.length)).toEqual([1, 2, 1]);
	});
});

describe('stubImports', () => {
	it('links every import, refusing the calls that would need a real host', () => {
		const map = stubImports(
			wat(`(module
			  (import "env" "grow" (func (param i32)))
			  (import "wasi_snapshot_preview1" "fd_close" (func (param i32) (result i32)))
			  (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32))))`)
		);
		expect(map.env?.grow?.signature).toBe('v(i)');
		expect(map.env?.grow?.fn()).toBe(0);
		expect(map.wasi_snapshot_preview1?.fd_close?.fn()).toBe(52);
		expect(() => map.wasi_snapshot_preview1?.fd_write?.fn()).toThrow(/fd_write/);
	});

	it('refuses an import wasm3 cannot link', () => {
		expect(() =>
			stubImports(wat('(module (import "e" "r" (func (param externref))))'))
		).toThrow(/e\.r/);
	});
});

describe('profile', () => {
	it('refuses an interpreter that was not built to count', async () => {
		const Module = WebAssembly.Module as unknown as new (b: BufferSource) => WebAssembly.Module;
		const vm = await createInterpreter({
			module: new Module(
				await readFile(new URL('../../src/vendor/wasm3.wasm', import.meta.url).pathname)
			)
		});
		expect(() => profile(vm, new Map(), () => {})).toThrow(/BURROW_PROFILE/);
	});
});
