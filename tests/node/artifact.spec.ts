import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { load, moduleKey, provenance, save } from '../../tools/interp/artifact.js';

/**
 * A mined catalog kept by module hash: it comes back for the same module under the same tree, and
 * is refused for another module or after anything that makes handlers or catalogs changes.
 */

const root = new URL('../../', import.meta.url).pathname;
const guest = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const other = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0]);
const catalog = { handlers: [['op_a', 'op_b']], widths: { op_a: 1, op_b: 2 } };

describe('fusion catalog artifacts', () => {
	it('round-trips a catalog for the same module and tree', () => {
		const dir = mkdtempSync(join(tmpdir(), 'burrow-artifact-'));
		const prov = provenance(root);
		expect(save(dir, guest, catalog, prov)).toBe(join(dir, `${moduleKey(guest)}.json`));
		expect(load(dir, guest, prov)).toEqual({ catalog });
	});

	it('names the tree it was mined under', () => {
		const prov = provenance(root);
		expect(prov.format).toBe(1);
		expect(prov.wasm3).toMatch(/^[0-9a-f]{40}$/);
		expect(prov.tools).toMatch(/^[0-9a-f]{64}$/);
		expect(prov.burrow).toMatch(/^\d+\.\d+\.\d+/);
	});

	it('refuses another module and a missing artifact', () => {
		const dir = mkdtempSync(join(tmpdir(), 'burrow-artifact-'));
		const prov = provenance(root);
		save(dir, guest, catalog, prov);
		expect(load(dir, other, prov)).toEqual({ refused: 'none for this module' });
		expect(moduleKey(other)).not.toBe(moduleKey(guest));
	});

	it.each(['format', 'burrow', 'wasm3', 'tools'] as const)(
		'refuses one mined under another %s',
		(k) => {
			const dir = mkdtempSync(join(tmpdir(), 'burrow-artifact-'));
			const prov = provenance(root);
			save(dir, guest, catalog, { ...prov, [k]: k === 'format' ? 0 : 'else' });
			expect(load(dir, guest, prov)).toEqual({ refused: k });
		}
	);
});
