import { describe, expect, it } from 'vitest';
import {
	EXIT,
	exitCodeFor,
	formatFinding,
	formatProbe,
	formatReport,
	run,
	type Context,
	type ProbeOutcome,
	type ProbeRequest
} from '../../src/bin/cli.js';
import type { DoctorReport } from '../../src/doctor.js';

/**
 * The CLI, driven over an in-memory context.
 *
 * Every branch is reachable here because `run` takes its filesystem, its environment, its output
 * and its probe as arguments. Nothing in this file touches a real one.
 */

/** an in-memory context, plus the transcript of what the CLI did with it */
function harness(
	files: Record<string, string | Uint8Array> = {},
	env: Record<string, string | undefined> = {},
	outcome: Partial<ProbeOutcome> = {}
) {
	const out: string[] = [];
	const err: string[] = [];
	const probes: ProbeRequest[] = [];
	const ctx: Context = {
		readFile: async (path) => {
			const found = files[path];
			if (found === undefined) throw new Error(`no such file: ${path}`);
			return typeof found === 'string' ? new TextEncoder().encode(found) : found;
		},
		out: (text) => void out.push(text),
		err: (text) => void err.push(text),
		env,
		probe: async (options) => {
			probes.push(options);
			return {
				scriptName: 'burrow-probe-t',
				url: 'https://burrow-probe-t.acme.workers.dev/',
				coldMs: 100,
				warmMs: 8,
				samples: [8, 9],
				tornDown: true,
				...outcome
			};
		},
		version: async () => '9.9.9'
	};
	return { ctx, probes, text: () => out.join(''), errors: () => err.join('') };
}

const CREDS = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' };

describe('formatFinding', () => {
	it('puts the path, the line and the rule on one grep-able line', () => {
		const report: DoctorReport = {
			kind: 'javascript',
			path: 'r.js',
			fatal: true,
			findings: [{ rule: 'eval', severity: 'fatal', line: 4, reason: 'blocked on Workers' }]
		};
		expect(formatFinding(report, report.findings[0]!)).toBe(
			'r.js:4: fatal: eval: blocked on Workers'
		);
	});

	it('says <stdin> when there is no path', () => {
		const report: DoctorReport = {
			kind: 'javascript',
			fatal: false,
			findings: [{ rule: 'dom', severity: 'warning', line: 1, reason: 'browser-only' }]
		};
		expect(formatFinding(report, report.findings[0]!)).toContain('<stdin>:1:');
	});
});

describe('formatReport', () => {
	const clean: DoctorReport = { kind: 'wasm', path: 'a.wasm', fatal: false, findings: [] };
	const dirty: DoctorReport = {
		kind: 'javascript',
		path: 'a.js',
		fatal: true,
		findings: [
			{ rule: 'eval', severity: 'fatal', line: 1, reason: 'blocked' },
			{ rule: 'dom', severity: 'warning', line: 2, reason: 'browser-only' }
		]
	};

	it('never calls a clean scan safe', () => {
		expect(formatReport(clean)).toBe('a.wasm: nothing known-fatal found in the wasm scan');
	});

	it('counts the fatals apart from the warnings', () => {
		expect(formatReport(dirty)).toContain('a.js: 1 fatal, 1 warning');
	});

	it('drops the summary under --quiet', () => {
		expect(formatReport(dirty, { quiet: true })).not.toContain('1 fatal');
	});

	it('answers JSON under --json', () => {
		expect(JSON.parse(formatReport(dirty, { json: true })).findings).toHaveLength(2);
	});
});

describe('formatProbe', () => {
	const result: ProbeOutcome = {
		scriptName: 'burrow-probe-x',
		url: 'https://burrow-probe-x.acme.workers.dev/',
		coldMs: 120,
		warmMs: 9,
		samples: [9, 10, 9],
		tornDown: true
	};

	it('reports the cold and warm figures and the teardown', () => {
		const text = formatProbe(result);
		expect(text).toContain('cold  120 ms');
		expect(text).toContain('warm  9 ms (median of 3)');
		expect(text).toContain('torn down');
	});

	it('shouts when the Worker is still deployed', () => {
		expect(formatProbe({ ...result, tornDown: false })).toContain('STILL DEPLOYED');
	});

	it('answers JSON when asked', () => {
		expect(JSON.parse(formatProbe(result, { json: true })).scriptName).toBe('burrow-probe-x');
	});
});

describe('exitCodeFor', () => {
	it('is 1 when any report is fatal and 0 otherwise', () => {
		const ok: DoctorReport = { kind: 'wasm', fatal: false, findings: [] };
		const bad: DoctorReport = { kind: 'wasm', fatal: true, findings: [] };
		expect(exitCodeFor([ok, ok])).toBe(EXIT.OK);
		expect(exitCodeFor([ok, bad])).toBe(EXIT.FOUND);
		expect(exitCodeFor([])).toBe(EXIT.OK);
	});
});

describe('run', () => {
	it('prints the help for no arguments', async () => {
		const h = harness();
		expect(await run(h.ctx, [])).toBe(EXIT.OK);
		expect(h.text()).toContain('Usage: burrow');
		expect(h.text()).toContain('doctor');
		expect(h.text()).toContain('probe');
	});

	it('prints the help for --help without calling it a failure', async () => {
		const h = harness();
		expect(await run(h.ctx, ['--help'])).toBe(EXIT.OK);
	});

	it('exits 2 on an unknown command', async () => {
		const h = harness();
		expect(await run(h.ctx, ['nonsense'])).toBe(EXIT.USAGE);
	});

	it('exits 2 when a required argument is missing', async () => {
		const h = harness();
		expect(await run(h.ctx, ['doctor'])).toBe(EXIT.USAGE);
	});

	it('prints the package version', async () => {
		const h = harness();
		expect(await run(h.ctx, ['version'])).toBe(EXIT.OK);
		expect(h.text()).toBe('9.9.9\n');
	});
});

describe('run doctor', () => {
	it('scans a source file and exits 0 when nothing fatal is found', async () => {
		const h = harness({ 'a.js': 'export const boot = 1;' });
		expect(await run(h.ctx, ['doctor', 'a.js'])).toBe(EXIT.OK);
		expect(h.text()).toContain('nothing known-fatal');
	});

	it('exits 1 on a fatal finding', async () => {
		const h = harness({ 'bad.js': 'const x = eval("1");' });
		expect(await run(h.ctx, ['doctor', 'bad.js'])).toBe(EXIT.FOUND);
		expect(h.text()).toContain('eval');
	});

	it('scans a .wasm file as bytes rather than as source', async () => {
		const h = harness({ 'x.wasm': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
		expect(await run(h.ctx, ['doctor', 'x.wasm'])).toBe(EXIT.FOUND);
		expect(h.text()).toContain('not-wasm');
	});

	it('scans several files and takes the worst exit code', async () => {
		const h = harness({ 'ok.js': 'const x = 1;', 'bad.js': 'eval("1");' });
		expect(await run(h.ctx, ['doctor', 'ok.js', 'bad.js'])).toBe(EXIT.FOUND);
	});

	it('takes --json as a global flag before the command', async () => {
		const h = harness({ 'a.js': 'const x = 1;' });
		await run(h.ctx, ['--json', 'doctor', 'a.js']);
		expect(JSON.parse(h.text()).path).toBe('a.js');
	});

	it('takes --quiet on the command', async () => {
		const h = harness({ 'bad.js': 'eval("1");' });
		await run(h.ctx, ['doctor', '--quiet', 'bad.js']);
		expect(h.text()).not.toContain('1 fatal');
	});

	it('reports a missing file as a usage failure rather than a stack', async () => {
		const h = harness();
		expect(await run(h.ctx, ['doctor', 'absent.js'])).toBe(EXIT.USAGE);
		expect(h.errors()).toContain('no such file');
		expect(h.errors()).not.toContain('at Object');
	});
});

describe('run probe', () => {
	it('refuses without credentials', async () => {
		const h = harness({ 'a.js': 'x' });
		expect(await run(h.ctx, ['probe', 'a.js'])).toBe(EXIT.USAGE);
		expect(h.errors()).toContain('CLOUDFLARE_ACCOUNT_ID');
	});

	it('refuses with no module', async () => {
		const h = harness({}, CREDS);
		expect(await run(h.ctx, ['probe'])).toBe(EXIT.USAGE);
	});

	it('deploys the named modules, keying them by basename', async () => {
		const h = harness(
			{ 'build/index.js': 'export default {};', 'build/r.wasm': new Uint8Array([0, 97]) },
			CREDS
		);
		expect(await run(h.ctx, ['probe', 'build/index.js', 'build/r.wasm'])).toBe(EXIT.OK);

		const sent = h.probes[0];
		expect(Object.keys(sent?.modules ?? {})).toEqual(['index.js', 'r.wasm']);
		// a .wasm stays bytes; anything else is decoded to source
		expect(typeof sent?.modules['index.js']).toBe('string');
		expect(sent?.modules['r.wasm']).toBeInstanceOf(Uint8Array);
		expect(h.text()).toContain('cold  100 ms');
	});

	it('passes --samples and --keep through', async () => {
		const h = harness({ 'a.js': 'x' }, CREDS, { tornDown: false });
		// keep makes a still-deployed Worker the expected outcome rather than a failure
		expect(await run(h.ctx, ['probe', '--samples', '9', '--keep', 'a.js'])).toBe(EXIT.OK);
		expect(h.probes[0]?.samples).toBe(9);
		expect(h.probes[0]?.keep).toBe(true);
	});

	it('defaults the sample count and falls back when it is not a number', async () => {
		const plain = harness({ 'a.js': 'x' }, CREDS);
		await run(plain.ctx, ['probe', 'a.js']);
		expect(plain.probes[0]?.samples).toBe(5);

		const bogus = harness({ 'a.js': 'x' }, CREDS);
		await run(bogus.ctx, ['probe', '--samples', 'lots', 'a.js']);
		expect(bogus.probes[0]?.samples).toBe(5);
	});

	it('exits 1 when a probe leaves the Worker deployed', async () => {
		const h = harness({ 'a.js': 'x' }, CREDS, { tornDown: false });
		expect(await run(h.ctx, ['probe', 'a.js'])).toBe(EXIT.FOUND);
		expect(h.text()).toContain('STILL DEPLOYED');
	});

	it('answers JSON under the global flag', async () => {
		const h = harness({ 'a.js': 'x' }, CREDS);
		await run(h.ctx, ['--json', 'probe', 'a.js']);
		expect(JSON.parse(h.text()).scriptName).toBe('burrow-probe-t');
	});
});
