import { describe, expect, it } from 'vitest';
import {
	hasWasmMagic,
	inspectSource,
	inspectWasm,
	readVaruint,
	sectionBody,
	SOURCE_RULES
} from '../src/doctor.js';

const findingsFor = (source: string) => inspectSource(source).findings.map((f) => f.rule);

/** \0asm + version 1, then a section id, a length and its body */
function wasmWith(sectionId: number, body: number[]): Uint8Array {
	return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, sectionId, body.length, ...body]);
}

describe('inspectSource', () => {
	it('flags eval as fatal', () => {
		const report = inspectSource('const x = eval("1 + 1");');
		expect(report.fatal).toBe(true);
		expect(report.findings[0]?.rule).toBe('eval');
		expect(report.findings[0]?.line).toBe(1);
		expect(report.kind).toBe('javascript');
	});

	it('does not flag a method named eval on an object', () => {
		// `ctx.eval(...)` is a host API, not the global; flagging it would make the tool cry wolf on
		// every quickjs or lua binding
		expect(findingsFor('ctx.eval("1");')).not.toContain('eval');
		expect(findingsFor('const safeEval = 1;')).not.toContain('eval');
	});

	it('flags new Function as fatal', () => {
		expect(findingsFor('const f = new Function("return 1");')).toContain('new-function');
	});

	it('flags request-time wasm compilation', () => {
		expect(findingsFor('new WebAssembly.Module(bytes)')).toContain('wasm-codegen');
		expect(findingsFor('await WebAssembly.compile(bytes)')).toContain('wasm-codegen');
		expect(findingsFor('await WebAssembly.compileStreaming(res)')).toContain('wasm-codegen');
	});

	it('does not flag instantiating a module that is already compiled', () => {
		expect(findingsFor('new WebAssembly.Instance(mod, imports)')).toEqual([]);
	});

	it('flags XMLHttpRequest as a browser-only build', () => {
		expect(findingsFor('const x = new XMLHttpRequest();')).toContain('xhr');
	});

	it('warns on DOM access without calling it fatal', () => {
		const report = inspectSource('document.getElementById("x");');
		expect(report.findings[0]?.severity).toBe('warning');
		expect(report.fatal).toBe(false);
	});

	it('warns on an unguarded location read', () => {
		expect(findingsFor('scriptDirectory = self.location.href;')).toContain(
			'unguarded-location'
		);
		expect(findingsFor('const d = location.href;')).toContain('unguarded-location');
	});

	it('accepts a guarded location read', () => {
		for (const guarded of [
			'if (typeof location !== "undefined") d = location.href;',
			'const d = location?.href;',
			'const d = location && location.href;'
		]) {
			expect(findingsFor(guarded)).not.toContain('unguarded-location');
		}
	});

	it('ignores patterns that appear only inside comments', () => {
		// the doctor reads runtimes whose own source documents the APIs it looks for
		expect(findingsFor('// this build never calls eval(\nconst x = 1;')).toEqual([]);
		expect(findingsFor('/* new Function( is avoided here */\nconst x = 1;')).toEqual([]);
	});

	it('reports every line a rule matches, with its line number', () => {
		const report = inspectSource('eval("a");\nconst x = 1;\neval("b");');
		const lines = report.findings.filter((f) => f.rule === 'eval').map((f) => f.line);
		expect(lines).toEqual([1, 3]);
	});

	it('carries the path through when one is given, and omits it otherwise', () => {
		expect(inspectSource('const x = 1;', 'runtime.js').path).toBe('runtime.js');
		expect(inspectSource('const x = 1;')).not.toHaveProperty('path');
	});

	it('finds nothing in a clean runtime, without calling it safe', () => {
		const report = inspectSource('export const boot = async () => ({ FS, callMain });');
		expect(report.findings).toEqual([]);
		expect(report.fatal).toBe(false);
	});

	it('gives every rule a stable id and a reason', () => {
		for (const rule of SOURCE_RULES) {
			expect(rule.rule).toMatch(/^[a-z-]+$/);
			expect(rule.reason.length).toBeGreaterThan(10);
		}
	});
});

describe('inspectWasm', () => {
	it('rejects bytes that are not wasm', () => {
		const report = inspectWasm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(report.fatal).toBe(true);
		expect(report.findings[0]?.rule).toBe('not-wasm');
		expect(report.kind).toBe('wasm');
	});

	it('accepts a module with an ordinary function type', () => {
		// one type, form 0x60 (func), no params, no results
		const report = inspectWasm(wasmWith(1, [0x01, 0x60, 0x00, 0x00]));
		expect(report.findings).toEqual([]);
	});

	it.each([
		['struct', 0x5f],
		['array', 0x5e],
		['sub', 0x50]
	])('flags a %s type as WasmGC', (_name, form) => {
		const report = inspectWasm(wasmWith(1, [0x01, form, 0x00]));
		expect(report.fatal).toBe(true);
		expect(report.findings[0]?.rule).toBe('wasm-gc');
	});

	it('finds nothing in a module with no type section', () => {
		expect(inspectWasm(wasmWith(3, [0x00])).findings).toEqual([]);
	});
});

describe('the wasm reader', () => {
	it('recognises the magic', () => {
		expect(hasWasmMagic(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toBe(true);
		expect(hasWasmMagic(new Uint8Array([0, 0x61, 0x73]))).toBe(false);
		expect(hasWasmMagic(new Uint8Array(8))).toBe(false);
	});

	it('reads a single-byte varuint', () => {
		expect(readVaruint(new Uint8Array([0x05]), 0)).toEqual([5, 1]);
	});

	it('reads a multi-byte varuint', () => {
		// 0xE5 0x8E 0x26 is 624485, the canonical LEB128 example
		expect(readVaruint(new Uint8Array([0xe5, 0x8e, 0x26]), 0)).toEqual([624485, 3]);
	});

	it('answers -1 when the varuint runs off the end', () => {
		expect(readVaruint(new Uint8Array([0x80]), 0)[1]).toBe(-1);
		expect(readVaruint(new Uint8Array([]), 0)[1]).toBe(-1);
	});

	it('finds a section by id and skips the ones before it', () => {
		const bytes = new Uint8Array([
			0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 2, 0xaa, 0xbb, 3, 1, 0xcc
		]);
		expect([...(sectionBody(bytes, 1) ?? [])]).toEqual([0xaa, 0xbb]);
		expect([...(sectionBody(bytes, 3) ?? [])]).toEqual([0xcc]);
		expect(sectionBody(bytes, 9)).toBeNull();
	});

	it('answers null rather than looping on a truncated section header', () => {
		expect(
			sectionBody(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 0x80]), 1)
		).toBeNull();
	});
});
