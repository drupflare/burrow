#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { probeAndVerify } from '../probe.js';
import { run, type Context } from './cli.js';

/**
 * The CLI entry point: real I/O, handed to {@link run}, which holds the behaviour.
 *
 * @internal
 */

const ctx: Context = {
	readFile: async (path) => new Uint8Array(await readFile(path)),
	out: (text) => void process.stdout.write(text),
	err: (text) => void process.stderr.write(text),
	env: process.env,
	probe: (options) => probeAndVerify(options),
	version: async () => {
		const pkg = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url).pathname, 'utf8')
		) as { version: string };
		return pkg.version;
	}
};

process.exitCode = await run(ctx, process.argv.slice(2));
