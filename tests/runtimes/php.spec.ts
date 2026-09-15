import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/budget.js';
import { Burrow } from '../../src/registry.js';
import { defineRuntime, type Interpreter } from '../../src/runtime.js';

/**
 * A real PHP build, installed from npm, driven end to end through burrow.
 *
 * This lane is what makes a runtime **Verified**. It proves that a build nobody here compiled
 * satisfies {@link Interpreter} - a script written into the interpreter's own filesystem, output
 * collected off the line sinks - and that a {@link Session} keeps state across evaluations.
 *
 * It does NOT prove the build fits a Worker. php-wasm's `PhpNode` statically imports `node:fs` to
 * locate a 12.6 MB binary inside its own package, none of which is reachable from workerd. What
 * belongs in a Worker is a build shipped as a module-scope `CompiledWasm` import, which is a
 * property of the build rather than of this contract. ADVANCED_USAGE.md states that split.
 *
 * The specifier is a VARIABLE on purpose: a literal would make `tsc` resolve php-wasm's types into
 * this project, and the shape below is a narrow hand-written sliver so the file states
 * what it actually relies on.
 */

const PHP_PACKAGE = 'php-wasm/PhpNode';

interface PhpNodeLike {
	binary: Promise<{
		FS: {
			writeFile(path: string, data: Uint8Array | string, opts?: { encoding?: string }): void;
			readFile(path: string, opts?: { encoding?: string }): Uint8Array | string;
			mkdir(path: string): unknown;
			analyzePath(path: string): { exists: boolean };
		};
		ccall(
			name: string,
			returns: string,
			types: string[],
			args: unknown[]
		): number | string | null;
	}>;
	onoutput: (event: { detail: string[] }) => void;
	onerror: (event: { detail: string[] }) => void;
	flush(): void;
}

type PhpNodeCtor = new (args: { version?: string; ini?: string }) => PhpNodeLike;

const php = await (async () => {
	try {
		return (await import(/* @vite-ignore */ PHP_PACKAGE)) as unknown as {
			PhpNode: PhpNodeCtor;
		};
	} catch {
		return null;
	}
})();

/** php-wasm ships 8.0 through 8.5; 8.5 is what drupflare runs, so it is what gets Verified here */
const PHP_VERSION = '8.5';

/** fatals do not reach stderr on the `embed` SAPI without this; they land on stdout and corrupt json() */
const PHP_INI = [
	'display_errors = 0',
	'log_errors = 1',
	'error_log = /dev/stderr',
	'error_reporting = E_ALL',
	'html_errors = 0'
].join('\n');

/** php-wasm fires one event per newline WITH the newline still attached; the sinks take lines */
const stripEol = (chunk: string) => (chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk);

const phpRuntime = defineRuntime({
	name: 'php',
	load: async () => php,
	instantiate: async ({ loaded, io }): Promise<Interpreter> => {
		const { PhpNode } = loaded as { PhpNode: PhpNodeCtor };
		const instance = new PhpNode({ version: PHP_VERSION, ini: PHP_INI });
		instance.onoutput = (event) => io.print(stripEol(event.detail[0] ?? ''));
		instance.onerror = (event) => io.printErr(stripEol(event.detail[0] ?? ''));
		const mod = await instance.binary;
		return {
			FS: mod.FS,
			callMain: (argv) => {
				const path = argv[argv.length - 1] ?? '';
				try {
					// pib_run compiles its argument as PHP, so `?>` opens output mode first; skipping
					// the flush leaves a newline-less last line to reappear glued to the next run
					return Number(
						mod.ccall(
							'pib_run',
							'number',
							['string'],
							[`?><?php require ${JSON.stringify(path)};`]
						)
					);
				} finally {
					instance.flush();
				}
			}
		};
	},
	memory: { peak: 64 * 1024 * 1024 }
});

function registry() {
	return new Burrow({
		runtimes: [phpRuntime],
		budget: new Budget({ limit: 256 * 1024 * 1024, reserve: 0 })
	});
}

describe.skipIf(php === null)(`PHP ${PHP_VERSION} via php-wasm`, () => {
	it('satisfies the interpreter contract', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		await sh.eval('<?php echo 1;');
		const interpreter = sh.interpreter;
		expect(interpreter).not.toBeNull();
		expect(typeof interpreter?.FS.writeFile).toBe('function');
		expect(typeof interpreter?.callMain).toBe('function');
	});

	it('runs arbitrary PHP supplied at call time', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		expect(await sh.evalText('<?php echo 6 * 7;')).toBe('42\n');
		expect(await sh.evalText('<?php echo strrev("drupflare");')).toBe('eralfpurd\n');
	});

	it('reports the version it actually loaded', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		expect(await sh.evalText('<?php echo phpversion();')).toMatch(
			new RegExp(`^${PHP_VERSION.replace('.', '\\.')}\\.`)
		);
	});

	it('answers structured output through evalJson', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		const value = await sh.evalJson<{ sum: number; name: string }>(
			'<?php echo json_encode(["sum" => array_sum([1,2,3]), "name" => "burrow"]);'
		);
		expect(value).toEqual({ sum: 6, name: 'burrow' });
	});

	it('keeps interpreter state between evaluations, which is the session contract', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		await sh.eval('<?php $GLOBALS["carried"] = "kept";');
		expect(await sh.evalText('<?php echo $GLOBALS["carried"];')).toBe('kept\n');
	});

	it('runs a program that is not a toy', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		const out = await sh.evalText(`<?php
			final class Matrix {
				public function __construct(private array \$rows) {}
				public function trace(): int {
					\$t = 0;
					foreach (\$this->rows as \$i => \$r) \$t += \$r[\$i];
					return \$t;
				}
			}
			\$words = preg_split('/\\W+/', 'the quick brown fox the fox the');
			\$freq = array_count_values(array_filter(\$words));
			arsort(\$freq);
			echo json_encode([
				'trace' => (new Matrix([[1,2],[3,4]]))->trace(),
				'top' => array_key_first(\$freq),
				'sha' => substr(hash('sha256', 'burrow'), 0, 8),
				'exts' => count(get_loaded_extensions()) > 0
			]);
		`);
		expect(JSON.parse(out)).toEqual({
			trace: 5,
			top: 'the',
			sha: expect.any(String),
			exts: true
		});
	});

	it('seeds files the guest can read through its own filesystem', async () => {
		await using sh = await registry().session('php', {
			scriptName: 'main.php',
			files: { '/data/config.json': '{"env":"test"}' }
		});
		expect(await sh.evalText('<?php echo file_get_contents("/data/config.json");')).toBe(
			'{"env":"test"}\n'
		);
	});

	it('separates a fatal onto stderr rather than corrupting stdout', async () => {
		await using sh = await registry().session('php', { scriptName: 'main.php' });
		const result = await sh.eval('<?php throw new RuntimeException("boom");');
		expect(result.stdoutText).not.toContain('boom');
		expect(result.stderrText).toContain('boom');
	});

	it('boots once for the whole session', async () => {
		const burrow = registry();
		await using sh = await burrow.session('php', { scriptName: 'main.php' });
		await sh.eval('<?php echo 1;');
		const first = sh.interpreter;
		await sh.eval('<?php echo 2;');
		expect(sh.interpreter).toBe(first);
		expect(burrow.isResident('php')).toBe(true);
	});

	it('records observed memory against the budget once booted', async () => {
		const budget = new Budget({ limit: 256 * 1024 * 1024, reserve: 0 });
		const burrow = new Burrow({ runtimes: [phpRuntime], budget });
		await using sh = await burrow.session('php', { scriptName: 'main.php' });
		await sh.eval('<?php echo 1;');
		// the spec declared 64 MiB; whatever the build actually took is what should be accounted
		expect(budget.bytesOf('php')).toBeGreaterThan(0);
	});
});
