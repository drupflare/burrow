/**
 * A guest's mined fusion catalog, kept so its next build starts on it instead of profiling again.
 *
 * An artifact is `<dir>/<sha256 of the module>.json`: the catalog plus the provenance it was mined
 * under. It is used only while that provenance is the current tree's: burrow's version, the pinned
 * wasm3, and a hash of everything that turns a catalog into handlers or a profile into a catalog
 * (the interpreter patches, the shim, the fusion runtime and generator, the profiler and the
 * miner). Any change there makes the build refuse the artifact and mine afresh.
 *
 * ```sh
 * bun tools/interp/artifact.ts save <dir> <guest.wasm> <catalog.json>
 * bun tools/interp/artifact.ts load <dir> <guest.wasm> <out catalog.json>   # exit 3 when refused
 * ```
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT = 1;

export interface Provenance {
	format: number;
	burrow: string;
	wasm3: string;
	tools: string;
}

export interface Artifact {
	module: string;
	provenance: Provenance;
	catalog: unknown;
}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** the module's content address */
export const moduleKey = (wasm: Uint8Array) => sha256(wasm);

/** the provenance of the tree at root */
export function provenance(root: string): Provenance {
	const interp = join(root, 'tools/interp');
	const build = readFileSync(join(root, 'tools/build-interp.sh'), 'utf8');
	const files = [
		...readdirSync(interp)
			.filter((f) => /\.(patch|c|inc|mjs|ts)$/.test(f) && f !== 'artifact.ts')
			.map((f) => join(interp, f)),
		join(root, 'tools/build-interp.sh'),
		join(root, 'tools/seq-mine.ts')
	].sort();
	const tools = createHash('sha256');
	for (const f of files) tools.update(f.slice(root.length)).update(readFileSync(f));
	return {
		format: FORMAT,
		burrow: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
		wasm3: build.match(/WASM3_REF="\$\{WASM3_REF:-([0-9a-f]+)\}"/)?.[1] ?? 'unknown',
		tools: tools.digest('hex')
	};
}

export function save(dir: string, wasm: Uint8Array, catalog: unknown, prov: Provenance): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${moduleKey(wasm)}.json`);
	const a: Artifact = { module: moduleKey(wasm), provenance: prov, catalog };
	writeFileSync(path, `${JSON.stringify(a)}\n`);
	return path;
}

/** the catalog when an artifact for this module was mined under prov, else why not */
export function load(
	dir: string,
	wasm: Uint8Array,
	prov: Provenance
): { catalog: unknown } | { refused: string } {
	const path = join(dir, `${moduleKey(wasm)}.json`);
	if (!existsSync(path)) return { refused: 'none for this module' };
	const a = JSON.parse(readFileSync(path, 'utf8')) as Artifact;
	if (a.module !== moduleKey(wasm)) return { refused: 'module hash' };
	for (const k of Object.keys(prov) as (keyof Provenance)[])
		if (a.provenance?.[k] !== prov[k]) return { refused: k };
	return { catalog: a.catalog };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [cmd, dir, guest, catalog] = process.argv.slice(2);
	const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
	if (!dir || !guest || !catalog || (cmd !== 'save' && cmd !== 'load')) {
		console.error('usage: artifact.ts save|load <dir> <guest.wasm> <catalog.json>');
		process.exit(2);
	}
	const wasm = readFileSync(guest);
	if (cmd === 'save')
		console.log(save(dir, wasm, JSON.parse(readFileSync(catalog, 'utf8')), provenance(root)));
	else {
		const got = load(dir, wasm, provenance(root));
		if ('refused' in got) {
			console.error(`artifact refused: ${got.refused}`);
			process.exit(3);
		}
		writeFileSync(catalog, `${JSON.stringify(got.catalog, null, '\t')}\n`);
		console.log(`catalog from the artifact for ${moduleKey(wasm).slice(0, 12)}`);
	}
}
