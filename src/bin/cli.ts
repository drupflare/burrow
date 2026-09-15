import { Command, CommanderError } from 'commander';
import { inspectSource, inspectWasm, type DoctorReport, type Finding } from '../doctor.js';

/**
 * The CLI, as a function of its arguments and a context.
 *
 * `bin/burrow.ts` is then four lines, and every path through here is reachable from a spec,
 * including the failures and the help output, because nothing below touches a global.
 *
 * @internal
 */

export const EXIT = { OK: 0, FOUND: 1, USAGE: 2 } as const;

/**
 * Everything the CLI is allowed to touch.
 *
 * Commands take a context and nothing else, so the gate substitutes every seam at once and no spec
 * reaches a filesystem, a network or a terminal.
 *
 * @internal
 */
export interface Context {
	readFile(path: string): Promise<Uint8Array>;
	out(text: string): void;
	err(text: string): void;
	env: Record<string, string | undefined>;
	probe(options: ProbeRequest): Promise<ProbeOutcome>;
	version(): Promise<string>;
}

/** @internal what {@link Context.probe} is asked for; mirrors `ProbeOptions` without importing it */
export interface ProbeRequest {
	accountId: string;
	apiToken: string;
	modules: Record<string, string | Uint8Array>;
	samples: number;
	keep: boolean;
}

/** @internal what {@link Context.probe} answers */
export interface ProbeOutcome {
	scriptName: string;
	url: string;
	coldMs: number;
	warmMs: number;
	samples: number[];
	tornDown: boolean;
}

const DESCRIPTION =
	'Execute arbitrary WebAssembly on Cloudflare Workers. doctor reads files and writes nothing; ' +
	'probe deploys a throwaway Worker to your own account, measures it, and deletes it again.';

/** One finding as a single line, in the shape editors and `grep` both read. */
export function formatFinding(report: DoctorReport, finding: Finding): string {
	const where = [report.path ?? '<stdin>', finding.line].filter(Boolean).join(':');
	return `${where}: ${finding.severity}: ${finding.rule}: ${finding.reason}`;
}

/** The whole report as text, or as JSON when `--json` was given. */
export function formatReport(
	report: DoctorReport,
	options: { json?: boolean; quiet?: boolean } = {}
): string {
	if (options.json) return JSON.stringify(report, null, 2);

	const lines = report.findings.map((f) => formatFinding(report, f));
	if (options.quiet) return lines.join('\n');

	const name = report.path ?? '<stdin>';
	if (!report.findings.length) {
		return `${name}: nothing known-fatal found in the ${report.kind} scan`;
	}
	const fatal = report.findings.filter((f) => f.severity === 'fatal').length;
	const warn = report.findings.length - fatal;
	lines.push(`${name}: ${fatal} fatal, ${warn} warning`);
	return lines.join('\n');
}

/** A probe result as text, or as JSON when `--json` was given. */
export function formatProbe(result: ProbeOutcome, options: { json?: boolean } = {}): string {
	if (options.json) return JSON.stringify(result, null, 2);
	return [
		`${result.scriptName}: ${result.url}`,
		`  cold  ${result.coldMs} ms`,
		`  warm  ${result.warmMs} ms (median of ${result.samples.length})`,
		`  ${result.tornDown ? 'torn down' : 'STILL DEPLOYED'}`
	].join('\n');
}

/** 1 when anything fatal was found, so a shell can gate on it. */
export function exitCodeFor(reports: readonly DoctorReport[]): number {
	return reports.some((r) => r.fatal) ? EXIT.FOUND : EXIT.OK;
}

/** @internal a wasm file is scanned as bytes, anything else as source */
async function scanFile(path: string, ctx: Context): Promise<DoctorReport> {
	const bytes = await ctx.readFile(path);
	if (path.endsWith('.wasm')) return inspectWasm(bytes, path);
	return inspectSource(new TextDecoder().decode(bytes), path);
}

/** @internal an exit code a command wants, carried out through commander's own unwinding */
class Exit extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

/**
 * Builds the command tree.
 *
 * @internal
 */
export function buildProgram(ctx: Context): Command {
	const program = new Command()
		.name('burrow')
		.description(DESCRIPTION)
		.option('--json', 'machine-readable output')
		.exitOverride()
		.configureOutput({
			writeOut: (text) => ctx.out(text),
			writeErr: (text) => ctx.err(text)
		});

	program
		.command('version')
		.description('print the package version')
		.action(async () => {
			ctx.out(`${await ctx.version()}\n`);
		});

	program
		.command('doctor')
		.argument('<files...>', 'runtime sources or .wasm modules to scan')
		.option('-q, --quiet', 'findings only, no summary')
		.description('scan a runtime for patterns that are fatal on Cloudflare Workers')
		.addHelpText(
			'after',
			'\ndoctor reports findings and never a clean bill of health: a source scan cannot prove\n' +
				'the absence of a JIT. An exit code of 0 means nothing known-fatal was seen.'
		)
		.action(async (files: string[], options: { quiet?: boolean }, command: Command) => {
			const json = command.optsWithGlobals().json === true;
			const reports: DoctorReport[] = [];
			for (const file of files) {
				const report = await scanFile(file, ctx);
				reports.push(report);
				ctx.out(`${formatReport(report, { json, quiet: options.quiet === true })}\n`);
			}
			const code = exitCodeFor(reports);
			if (code !== EXIT.OK) throw new Exit(code);
		});

	program
		.command('probe')
		.argument('<files...>', 'modules to deploy; a .wasm stays bytes, anything else is source')
		.option('--samples <n>', 'warm requests to send after the cold one', '5')
		.option('--keep', 'leave the Worker deployed')
		.description('deploy a throwaway Worker, measure it on the edge, tear it down')
		.addHelpText(
			'after',
			'\nprobe needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment. It\n' +
				'reports end-to-end latency from the client; cpuTime needs `wrangler tail` against\n' +
				'the script it names.'
		)
		.action(
			async (
				files: string[],
				options: { samples?: string; keep?: boolean },
				command: Command
			) => {
				const accountId = ctx.env.CLOUDFLARE_ACCOUNT_ID;
				const apiToken = ctx.env.CLOUDFLARE_API_TOKEN;
				if (!accountId || !apiToken) {
					ctx.err('probe needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN\n');
					throw new Exit(EXIT.USAGE);
				}

				const modules: Record<string, string | Uint8Array> = {};
				for (const file of files) {
					const name = file.slice(file.lastIndexOf('/') + 1);
					const bytes = await ctx.readFile(file);
					modules[name] = name.endsWith('.wasm')
						? bytes
						: new TextDecoder().decode(bytes);
				}

				const samples = Number(options.samples);
				const keep = options.keep === true;
				const result = await ctx.probe({
					accountId,
					apiToken,
					modules,
					samples: Number.isFinite(samples) && samples >= 0 ? samples : 5,
					keep
				});
				ctx.out(
					`${formatProbe(result, { json: command.optsWithGlobals().json === true })}\n`
				);
				if (!result.tornDown && !keep) throw new Exit(EXIT.FOUND);
			}
		);

	return program;
}

/**
 * Parses and runs one invocation, answering the exit code rather than taking the process down.
 *
 * With no arguments it prints the help, because somebody who typed `burrow` has not decided
 * anything yet. A stack trace never reaches a user: an exception that is not one of burrow's own is
 * a bug, and its message is the useful half.
 *
 * @internal
 */
export async function run(ctx: Context, argv: readonly string[]): Promise<number> {
	try {
		if (argv.length === 0) {
			ctx.out(buildProgram(ctx).helpInformation());
			return EXIT.OK;
		}
		await buildProgram(ctx).parseAsync([...argv], { from: 'user' });
		return EXIT.OK;
	} catch (e) {
		if (e instanceof Exit) return e.code;
		if (e instanceof CommanderError) {
			// --help and --version unwind through the same path as a parse failure
			return e.code === 'commander.helpDisplayed' ||
				e.code === 'commander.version' ||
				e.code === 'commander.help'
				? EXIT.OK
				: EXIT.USAGE;
		}
		ctx.err(`burrow: ${e instanceof Error ? e.message : String(e)}\n`);
		return EXIT.USAGE;
	}
}
