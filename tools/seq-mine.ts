/**
 * Mines recurring operation sequences out of a weighted trace into a bounded fusion catalog.
 *
 * It knows nothing about wasm3. Any interpreter that can say which operations it executed, and
 * where its control flow breaks, can feed it; burrow's `tools/interp/trace.mjs` is one producer.
 *
 * ## Trace format
 *
 * Plain text, one operation per line:
 *
 * ```text
 * # a comment
 * op_i32_Add_rs 1200
 * op_SetSlot_i32 1200
 * op_i32_Load_i32_s 1350
 *
 * op_CopySlot_32
 * ```
 *
 * - a line is an operation name, optionally followed by a weight (default 1)
 * - the weight is how often the operation at that position ran; a producer that would rather
 *   weight by CPU can scale a whole run by what a dispatch costs there
 * - a blank line ends a run, and no sequence is mined across one; put one wherever control can
 *   leave a run, and around any operation that cannot be fused
 * - identical runs are merged, summing weights position by position, so a raw dynamic stream
 *   (every line weight 1) and a site profile (each static run once, weighted by its count) are
 *   both valid and give the same catalog
 *
 * ## Mining
 *
 * Byte-pair style: the adjacent pair whose merge removes the most weight is merged, and that
 * repeats. A sequence fires as often as its first operation, because control entering it part way
 * runs the rest unfused, and it removes one dispatch per firing per operation after the first. A
 * merge is applied only where it removes weight. The catalog at a budget is the set of sequences
 * in use at the last point there were no more than that many.
 *
 * ## Catalog
 *
 * `{ handlers: string[][], widths: Record<string, number> }`, which is what
 * `tools/interp/gen-fuse.mjs` reads. Widths come from the producer (`--widths`), since only it
 * knows how many code words each operation takes.
 *
 * ```sh
 * bun tools/seq-mine.ts trace.txt --budget 64 --widths widths.json --out catalog.json
 * # one catalog for several guests, each weighed equally
 * bun tools/seq-mine.ts a.txt b.txt --balance --max-width 2 --widths a.json --widths b.json
 * ```
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** one straight-line run, weights position by position */
export interface Run {
	ops: string[];
	weights: number[];
}

export interface MineOptions {
	/** catalog sizes to report, ascending; the largest bounds the search */
	budgets?: number[];
	/** the most operations one sequence may hold */
	maxWidth?: number;
}

export interface CatalogEntry {
	ops: string[];
	/** how many times the sequence fires under the miner's own tiling */
	fires: number;
	/** the weight it removes: fires times one less than its width */
	removed: number;
}

export interface Catalog {
	budget: number;
	entries: CatalogEntry[];
	/** share of all trace weight that falls inside a catalog sequence */
	coverage: number;
	/** share of all trace weight the catalog removes */
	removed: number;
}

export interface Mined {
	/** the whole trace's weight */
	total: number;
	catalogs: Catalog[];
}

/**
 * Reads the trace format, merging identical runs.
 *
 * @throws {Error} on a weight that is not a finite non-negative number
 */
export function parseTrace(text: string): Run[] {
	const runs = new Map<string, Run>();
	let ops: string[] = [];
	let weights: number[] = [];
	const flush = () => {
		if (!ops.length) return;
		const key = ops.join('\n');
		const seen = runs.get(key);
		if (seen) weights.forEach((w, i) => (seen.weights[i] = (seen.weights[i] ?? 0) + w));
		else runs.set(key, { ops, weights });
		ops = [];
		weights = [];
	};
	text.split('\n').forEach((raw, line) => {
		const s = raw.trim();
		if (s.startsWith('#')) return;
		if (!s) return flush();
		const [op, w, extra] = s.split(/\s+/);
		const weight = w === undefined ? 1 : Number(w);
		if (extra !== undefined || !Number.isFinite(weight) || weight < 0) {
			throw new Error(
				`trace line ${line + 1}: expected "<op> [weight]", found ${JSON.stringify(s)}`
			);
		}
		ops.push(op as string);
		weights.push(weight);
	});
	flush();
	return [...runs.values()];
}

/** writes runs back out in the trace format, so a producer can build them in memory */
export function formatTrace(runs: Run[]): string {
	return `${runs.map((r) => r.ops.map((op, i) => `${op} ${r.weights[i] ?? 0}`).join('\n')).join('\n\n')}\n`;
}

/** mines the runs into one catalog per budget */
export function mine(runs: Run[], options: MineOptions = {}): Mined {
	const budgets = [...(options.budgets ?? [64, 256, 1024])].sort((a, b) => a - b);
	const maxWidth = options.maxWidth ?? 32;
	const cap = budgets[budgets.length - 1] ?? 0;

	// a symbol is a sequence of base operations; ids index `symbols`
	const symbols: string[][] = [];
	const ids = new Map<string, number>();
	const intern = (ops: string[]) => {
		const key = ops.join('\n');
		let id = ids.get(key);
		if (id === undefined) {
			id = symbols.length;
			symbols.push(ops);
			ids.set(key, id);
		}
		return id;
	};

	let total = 0;
	const seqs: { sym: number[]; w: number[] }[] = [];
	for (const r of runs) {
		r.weights.forEach((w) => (total += w));
		const w = r.weights.slice();
		if (w.some((x) => x > 0)) seqs.push({ sym: r.ops.map((op) => intern([op])), w });
	}

	const snapshot = (budget: number): Catalog => {
		const by = new Map<number, CatalogEntry>();
		let covered = 0;
		let removed = 0;
		for (const s of seqs) {
			s.sym.forEach((id, i) => {
				const ops = symbols[id] as string[];
				if (ops.length < 2) return;
				const w = s.w[i] as number;
				const e = by.get(id) ?? { ops, fires: 0, removed: 0 };
				e.fires += w;
				e.removed += w * (ops.length - 1);
				by.set(id, e);
				covered += w * ops.length;
				removed += w * (ops.length - 1);
			});
		}
		const entries = [...by.values()].sort(
			(a, b) => b.removed - a.removed || a.ops.join().localeCompare(b.ops.join())
		);
		return {
			budget,
			entries,
			coverage: total ? covered / total : 0,
			removed: total ? removed / total : 0
		};
	};

	const inUse = () => {
		const seen = new Set<number>();
		for (const s of seqs)
			for (const id of s.sym) if ((symbols[id] as string[]).length > 1) seen.add(id);
		return seen.size;
	};

	const best: (Catalog | undefined)[] = budgets.map(() => undefined);
	const record = () => {
		const n = inUse();
		budgets.forEach((b, i) => {
			if (n <= b) best[i] = snapshot(b);
		});
		return n;
	};

	// what merging the symbols at i and i + 1 removes: the pair now fires as often as the first, and
	// the second's own dispatches after its first operation are no longer its to remove
	const gain = (s: { sym: number[]; w: number[] }, i: number) => {
		const tail = (symbols[s.sym[i + 1] as number] as string[]).length;
		return (s.w[i] as number) * tail - (s.w[i + 1] as number) * (tail - 1);
	};

	record();
	const K = 2 ** 26;
	for (;;) {
		const score = new Map<number, number>();
		for (const s of seqs) {
			let last = -1;
			for (let i = 0; i + 1 < s.sym.length; i++) {
				const a = s.sym[i] as number;
				const b = s.sym[i + 1] as number;
				if ((symbols[a] as string[]).length + (symbols[b] as string[]).length > maxWidth)
					continue;
				// a run of one repeated symbol pairs without overlap, as the merge will
				if (a === b && last === i - 1) continue;
				const g = gain(s, i);
				if (g <= 0) continue;
				last = i;
				const key = a * K + b;
				score.set(key, (score.get(key) ?? 0) + g);
			}
		}
		let top = -1;
		let topScore = 0;
		for (const [key, v] of score) {
			if (v > topScore || (v === topScore && top >= 0 && key < top)) {
				top = key;
				topScore = v;
			}
		}
		if (top < 0 || topScore <= 0) break;

		const a = Math.floor(top / K);
		const b = top % K;
		const merged = intern([...(symbols[a] as string[]), ...(symbols[b] as string[])]);
		for (const s of seqs) {
			for (let i = 0; i + 1 < s.sym.length; i++) {
				if (s.sym[i] !== a || s.sym[i + 1] !== b || gain(s, i) <= 0) continue;
				s.sym.splice(i, 2, merged);
				s.w.splice(i + 1, 1);
			}
		}
		if (record() > cap) break;
	}

	return { total, catalogs: best.map((c, i) => c ?? snapshot(budgets[i] as number)) };
}

/** a catalog in the shape gen-fuse reads, keeping only the widths its operations need */
export function toFuseCatalog(
	catalog: Catalog,
	widths: Record<string, number> = {}
): { handlers: string[][]; widths: Record<string, number> } {
	const handlers = catalog.entries.map((e) => e.ops);
	const used: Record<string, number> = {};
	for (const op of [...new Set(handlers.flat())].sort()) {
		const w = widths[op];
		if (w !== undefined) used[op] = w;
	}
	return { handlers, widths: used };
}

/** @internal the command line; answers an exit code */
export function main(argv: string[], log: (line: string) => void = console.log): number {
	const all = (name: string, value = true) => {
		const found: string[] = [];
		for (let i = argv.indexOf(name); i >= 0; i = argv.indexOf(name)) {
			found.push(value ? (argv[i + 1] ?? '') : '');
			argv.splice(i, value ? 2 : 1);
		}
		return found;
	};
	const budget = Number(all('--budget')[0] ?? 64);
	const maxWidth = Number(all('--max-width')[0] ?? 32);
	const widthPaths = all('--widths');
	const out = all('--out')[0];
	const balance = all('--balance', false).length > 0;
	const paths = argv;
	if (
		!paths.length ||
		!Number.isInteger(budget) ||
		budget < 1 ||
		!Number.isInteger(maxWidth) ||
		maxWidth < 2
	) {
		log(
			'usage: seq-mine <trace>... [--budget N] [--max-width W] [--balance] [--widths widths.json]... [--out catalog.json]'
		);
		return 2;
	}
	// --balance weighs every trace equally, so one long-running guest does not choose the catalog
	const runs = paths.flatMap((p) => {
		const rs = parseTrace(readFileSync(p, 'utf8'));
		const total = rs.reduce((a, r) => a + r.weights.reduce((x, y) => x + y, 0), 0);
		if (!balance || !total) return rs;
		return rs.map((r) => ({ ops: r.ops, weights: r.weights.map((w) => w / total) }));
	});
	const budgets = [...new Set([64, 256, 1024, budget])];
	const mined = mine(runs, { budgets, maxWidth });
	for (const c of mined.catalogs) {
		log(
			`${String(c.budget).padStart(5)} entries: ${c.entries.length} used, ` +
				`${(100 * c.coverage).toFixed(2)}% of dynamic weight covered, ${(100 * c.removed).toFixed(2)}% removed`
		);
	}
	if (out) {
		const chosen = mined.catalogs.find((c) => c.budget === budget) as Catalog;
		const widths: Record<string, number> = {};
		for (const p of widthPaths) Object.assign(widths, JSON.parse(readFileSync(p, 'utf8')));
		writeFileSync(out, `${JSON.stringify(toFuseCatalog(chosen, widths), null, '\t')}\n`);
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
