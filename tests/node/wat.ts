import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Assembles wat source with `wat2wasm`, so a fixture is readable in the spec that uses it rather
 * than a committed binary nobody can diff.
 *
 * Annotations are enabled because a side-module fixture has to carry a `dylink.0` custom section,
 * and `( @custom "dylink.0" "..." )` is the only way to write one by hand.
 *
 * @internal
 */
export function wat(source: string): Uint8Array {
	const dir = mkdtempSync(join(tmpdir(), 'burrow-wat-'));
	const watPath = join(dir, 'm.wat');
	const wasmPath = join(dir, 'm.wasm');
	writeFileSync(watPath, source);
	execFileSync('wat2wasm', ['--enable-annotations', watPath, '-o', wasmPath]);
	return new Uint8Array(readFileSync(wasmPath));
}
