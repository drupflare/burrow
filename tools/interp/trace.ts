/**
 * Traces a guest under a profiling interpreter, in the format `tools/seq-mine.ts` reads.
 *
 * A profiling interpreter is `BURROW_PROFILE=1 bash tools/build-interp.sh`. It counts every
 * dispatch by the pc it lands on, and the shim already records every operation the compiler emits,
 * so a site's count and its handler name are both known after one run.
 *
 * ```sh
 * bun tools/interp/trace.ts profile.wasm guest.wasm run 6 --out trace.txt --widths widths.json
 * ```
 *
 * Imports are answered by stubs: 0, or ENOSYS for WASI, and a guest that calls `proc_exit` or
 * `fd_write` stops the trace. A guest that needs real imports is traced by calling {@link profile}
 * from a driver that loads it itself.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterpreter, type ImportMap, type WasmInterpreter } from '../../src/interpret.js';
import { formatTrace, type Run } from '../seq-mine.js';
import { readImports, readTableNames } from '../wasm-ops.js';

/** one emitted operation: where it sits, which handler it is, how often it ran */
export interface Site {
	pc: number;
	op: string;
	count: number;
}

/** a code word is a pointer, 4 bytes in wasm32 */
const WORD = 4;

/**
 * Cuts sites, in emission order, into the runs a tile can cover.
 *
 * A run continues while both neighbours are operations a tile may hold and the second sits exactly
 * one operation after the first, which is what the fusion matcher checks. Every other executed
 * operation is a run of its own, so it still counts toward the trace's total. Widths are the most
 * common distance from each operation to the next one emitted, in code words.
 */
export function runsOf(
	sites: Site[],
	fusible: Set<string>
): { runs: Run[]; widths: Record<string, number> } {
	const seen = new Map<string, Map<number, number>>();
	for (let i = 0; i + 1 < sites.length; i++) {
		const a = sites[i] as Site;
		const d = (sites[i + 1] as Site).pc - a.pc;
		if (d <= 0 || d % WORD || d > 16 * WORD) continue;
		const m = seen.get(a.op) ?? new Map<number, number>();
		m.set(d / WORD, (m.get(d / WORD) ?? 0) + 1);
		seen.set(a.op, m);
	}
	const widths: Record<string, number> = {};
	for (const [op, m] of seen)
		widths[op] = ([...m].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0] as [number, number])[0];

	const runs: Run[] = [];
	let run: Run | null = null;
	for (let i = 0; i < sites.length; i++) {
		const s = sites[i] as Site;
		if (!s.count) {
			run = null;
			continue;
		}
		const prev = sites[i - 1];
		const joins =
			run !== null &&
			prev !== undefined &&
			fusible.has(s.op) &&
			fusible.has(prev.op) &&
			s.pc - prev.pc === WORD * (widths[prev.op] ?? 0);
		if (!joins) {
			run = { ops: [], weights: [] };
			runs.push(run);
		}
		(run as Run).ops.push(s.op);
		(run as Run).weights.push(s.count);
		if (!fusible.has(s.op)) run = null;
	}
	return { runs, widths };
}

interface ProfileShim {
	burrow_prof_reset(): void;
	burrow_prof_nofuse(on: number): void;
	burrow_prof_sites(): number;
	burrow_prof_site_pc(i: number): number;
	burrow_prof_site_op(i: number): number;
	burrow_prof_count(pc: number): number;
}

/**
 * Runs `work` under a profiling interpreter and answers every executed site.
 *
 * @param names the interpreter's table, from {@link readTableNames}, which turns handler pointers
 *   back into names
 * @param fused whether fusion applies during the run; a catalog is mined from the unfused stream
 */
export function profile(
	vm: WasmInterpreter,
	names: Map<number, string>,
	work: () => void,
	fused = false
): Site[] {
	const shim = (vm as unknown as { shim: ProfileShim }).shim;
	if (typeof shim.burrow_prof_count !== 'function') {
		throw new Error('this interpreter was not built with BURROW_PROFILE=1');
	}
	shim.burrow_prof_nofuse(fused ? 0 : 1);
	shim.burrow_prof_reset();
	work();
	const byPc = new Map<number, Site>();
	for (let i = 0; i < shim.burrow_prof_sites(); i++) {
		const pc = shim.burrow_prof_site_pc(i);
		const slot = shim.burrow_prof_site_op(i);
		// wasm3 can re-emit at a pc; the later record is the one in the code
		byPc.delete(pc);
		byPc.set(pc, {
			pc,
			op: names.get(slot) ?? `slot_${slot}`,
			count: shim.burrow_prof_count(pc)
		});
	}
	return [...byPc.values()];
}

/** stub imports for every function the guest imports */
export function stubImports(guest: Uint8Array): ImportMap {
	const map: ImportMap = {};
	for (const { module, field, signature } of readImports(guest)) {
		if (!signature) throw new Error(`${module}.${field} has a value type wasm3 cannot link`);
		const wasi = module.startsWith('wasi');
		(map[module] ??= {})[field] = {
			signature,
			fn: () => {
				if (field === 'proc_exit' || field === 'fd_write')
					throw new Error(`guest called ${field}`);
				return wasi ? 52 : 0;
			}
		};
	}
	return map;
}

/** @internal the command line; answers an exit code */
export async function main(
	argv: string[],
	log: (line: string) => void = console.log
): Promise<number> {
	const flag = (name: string, value = true) => {
		const i = argv.indexOf(name);
		if (i < 0) return undefined;
		const v = value ? argv[i + 1] : '';
		argv.splice(i, value ? 2 : 1);
		return v;
	};
	const out = flag('--out');
	const widthsPath = flag('--widths');
	const fused = flag('--fused', false) !== undefined;
	const fusibleFlag = flag('--fusible');
	const [interpPath, guestPath, fn, ...args] = argv;
	const fusiblePath = fusibleFlag ?? `${interpPath?.replace(/\.wasm$/, '')}.fusible.json`;
	if (!interpPath || !guestPath || !fn || !out) {
		log(
			'usage: trace <profile.wasm> <guest.wasm> <export> [i32 args] --out <trace.txt> [--widths <widths.json>] [--fused]'
		);
		return 2;
	}
	const interp = new Uint8Array(readFileSync(interpPath));
	const guestBytes = new Uint8Array(readFileSync(guestPath));
	const fusible = new Set<string>(JSON.parse(readFileSync(fusiblePath, 'utf8')) as string[]);

	const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
	const vm = await createInterpreter({ module: new Module(interp) });
	const guest = vm.load(guestBytes, { imports: stubImports(guestBytes) });
	if (guest.has('_initialize')) guest.call('_initialize');

	let result = 0;
	const sites = profile(
		vm,
		readTableNames(interp),
		() => (result = guest.call(fn, ...args.map(Number))),
		fused
	);
	const { runs, widths } = runsOf(sites, fusible);
	writeFileSync(out, formatTrace(runs));
	if (widthsPath) writeFileSync(widthsPath, `${JSON.stringify(widths, null, '\t')}\n`);
	const total = sites.reduce((a, s) => a + s.count, 0);
	log(
		`${fn} answered ${result}; ${total} dispatches over ${sites.length} sites, ${runs.length} runs`
	);
	return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
