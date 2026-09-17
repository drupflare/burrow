import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import readme from '../README.md?raw';
import * as adaptModule from '../src/adapt.js';
import * as budgetModule from '../src/budget.js';
import * as doctorModule from '../src/doctor.js';
import * as dylinkModule from '../src/dylink.js';
import * as errorsModule from '../src/errors.js';
import * as indexModule from '../src/index.js';
import * as interpretModule from '../src/interpret.js';
import * as probeModule from '../src/probe.js';
import * as publishModule from '../src/publish.js';
import * as registryModule from '../src/registry.js';
import * as runtimeModule from '../src/runtime.js';
import * as sessionModule from '../src/session.js';
import configSource from '../vitest.config.ts?raw';

/** every source file as text, so a spec can assert on what imports what */
const sources = import.meta.glob('../src/**/*.ts', {
	query: '?raw',
	eager: true,
	import: 'default'
}) as Record<string, string>;

/**
 * The subpath map, checked against the modules it names.
 *
 * A test and not a review item, because an `exports` map is the one part of a package that nothing
 * else in the repo reads: `tsc` resolves relative specifiers, vitest resolves relative specifiers,
 * and the map is only exercised the first time a CONSUMER installs the package. A typo in it is
 * invisible until publication, which is the worst possible moment.
 *
 * This package builds to `dist/`, so the targets cannot be imported here the way cartridge imports
 * its own `src/*.ts`. The map is therefore checked STRUCTURALLY - every target is `./dist/<n>.js`,
 * every `<n>` has a `src/<n>.ts` imported below, and `types` and `import` agree on `<n>`.
 */

/** each public subpath, the module basename it must name, and a symbol reachable through it */
const SUBPATHS: Array<[string, string, Record<string, unknown>, string]> = [
	['.', 'index', indexModule, 'Burrow'],
	['./adapt', 'adapt', adaptModule, 'lines'],
	['./budget', 'budget', budgetModule, 'Budget'],
	['./doctor', 'doctor', doctorModule, 'inspectSource'],
	['./dylink', 'dylink', dylinkModule, 'createLinker'],
	['./errors', 'errors', errorsModule, 'BurrowError'],
	['./interpret', 'interpret', interpretModule, 'createInterpreter'],
	['./probe', 'probe', probeModule, 'probe'],
	['./publish', 'publish', publishModule, 'publishVersion'],
	['./registry', 'registry', registryModule, 'Burrow'],
	['./runtime', 'runtime', runtimeModule, 'defineRuntime'],
	['./session', 'session', sessionModule, 'Session']
];

type ExportEntry = { types: string; import: string };
const exportsMap = pkg.exports as unknown as Record<string, ExportEntry | string>;

/** the interpreter binary, which is an asset rather than a module and so has no types entry */
const VENDOR_SUBPATH = './vendor/wasm3.wasm';

describe('the package exports map', () => {
	it.each(SUBPATHS)(
		'%s resolves to dist/%s.js and exposes %s',
		(subpath, base, module, symbol) => {
			const entry = exportsMap[subpath];
			expect(entry, `${subpath} is missing from exports`).toBeDefined();
			expect(typeof entry, `${subpath} must be a conditions object`).toBe('object');
			const { types, import: esm } = entry as ExportEntry;
			expect(esm).toBe(`./dist/${base}.js`);
			expect(types).toBe(`./dist/${base}.d.ts`);
			expect(module).toHaveProperty(symbol);
		}
	);

	it('names every subpath the modules provide and nothing more', () => {
		const declared = Object.keys(exportsMap)
			.filter((k) => k !== './package.json' && k !== VENDOR_SUBPATH)
			.sort();
		const expected = SUBPATHS.map(([s]) => s).sort();
		expect(declared).toEqual(expected);
	});

	it('exports ./package.json, so a consumer can read the version', () => {
		expect(exportsMap['./package.json']).toBe('./package.json');
	});

	it('agrees with main and types on the root entry', () => {
		const root = exportsMap['.'] as ExportEntry;
		expect(pkg.main).toBe(root.import);
		expect(pkg.types).toBe(root.types);
	});

	it('is side-effect free', () => {
		// nothing in src patches globalThis at import time; the location shim runs inside
		// defineRuntime() rather than on module evaluation, which is what keeps this `false`
		expect(pkg.sideEffects).toBe(false);
	});

	it('ships dist and the docs, and nothing else', () => {
		expect(pkg.files).toEqual(['dist', 'LICENSE', 'README.md', 'ADVANCED_USAGE.md']);
	});

	it('depends on commander for the CLI and nothing else at runtime', () => {
		// a wasm interpreter host that needs a dependency inside a Worker has taken a wrong turn; the
		// consumer supplies the runtime and the platform supplies everything else
		const deps = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {};
		expect(Object.keys(deps)).toEqual(['commander']);
	});

	it('keeps that dependency inside src/bin, so a Worker bundle never pulls it', () => {
		// the library entry points are what a Worker imports, and commander is a terminal concern
		const library = Object.keys(sources).filter((path) => !path.includes('/bin/'));
		expect(library.length).toBeGreaterThan(5);
		for (const path of library) {
			expect(sources[path], `${path} imports commander`).not.toContain("from 'commander'");
		}
	});

	it('points bin at a file inside dist', () => {
		expect(pkg.bin).toEqual({ burrow: 'dist/bin/burrow.js' });
	});
});

describe('the vendored interpreter', () => {
	// every doc and TSDoc example tells a consumer to import this exact specifier, and it resolved to
	// nothing until 1.0.0: tsc copies no assets, so dist carried no wasm and the map named no subpath
	it('is reachable at the specifier the docs tell consumers to import', () => {
		expect(exportsMap[VENDOR_SUBPATH]).toBe('./dist/vendor/wasm3.wasm');
	});

	it('exists in src for the build to copy', () => {
		expect(Object.keys(import.meta.glob('../src/vendor/*.wasm'))).toEqual([
			'../src/vendor/wasm3.wasm'
		]);
	});

	it('is copied into dist by the build, because tsc emits only what it compiles', () => {
		expect(pkg.scripts.build).toContain('src/vendor/wasm3.wasm dist/vendor/wasm3.wasm');
	});
});

describe('the readme', () => {
	// the map drifted from the table once already: ./publish and ./probe shipped undocumented, so a
	// reader could not find two of the three execution paths the readme itself names
	const documented = Object.keys(exportsMap).filter((s) => s !== '.' && s !== './package.json');

	it.each(documented)('documents the %s subpath', (subpath) => {
		const specifier = `@drupflare/burrow${subpath.slice(1)}`;
		expect(
			readme.includes(subpath) || readme.includes(specifier),
			`${subpath} is exported but appears nowhere in README.md`
		).toBe(true);
	});
});

describe('the vitest projects', () => {
	const names = [...configSource.matchAll(/name:\s*'([a-z]+)'/g)].map((m) => m[1]);

	it('finds the four declared projects', () => {
		expect(names).toEqual(['unit', 'node', 'runtimes', 'bench']);
	});

	it.each(names)('project %s is selected by a test script', (name) => {
		// a lane no script runs reads exactly like a lane that passed
		const scripts = Object.values(pkg.scripts as Record<string, string>);
		expect(scripts.some((s) => s.includes(`--project=${name}`))).toBe(true);
	});
});
