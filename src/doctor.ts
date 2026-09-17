/**
 * Static validation that a candidate runtime can survive a Cloudflare Worker.
 *
 * Deterministic and scriptable, because the rule it enforces is the one that silently kills a
 * runtime choice: **the runtime must be a pure interpreter.** Anything that generates code at
 * runtime is fatal regardless of which language it generates - PHP's JIT dies on the wasm codegen
 * ban, CheerpJ dies because it JITs bytecode to JavaScript and `new Function` is equally blocked.
 *
 * **Two limits, stated up front, because a checker that overclaims is worse than none.**
 *
 * 1. A source scan cannot prove the ABSENCE of a JIT - a runtime could assemble `"ev" + "al"`. So
 *    this reports findings and never a clean bill of health; no findings means "nothing known-fatal
 *    was seen", not "safe".
 * 2. A `.wasm` cannot be scanned for `eval` at all, because the JIT that disqualifies a candidate
 *    lives in the JavaScript glue. Source and wasm are therefore scanned differently and each report
 *    says which it was.
 *
 * @since 1.0.0
 */

export type Severity = 'fatal' | 'warning';

export interface Finding {
	/** stable identifier, safe to branch on or suppress by */
	rule: string;
	severity: Severity;
	/** one line on why this matters on Workers */
	reason: string;
	/** 1-based line number, for a source scan */
	line?: number;
	/** the text that matched */
	match?: string;
}

export interface DoctorReport {
	/** what was scanned, when the caller named it */
	path?: string;
	/** which scanner ran, because they check different things */
	kind: 'javascript' | 'wasm';
	findings: Finding[];
	/** whether anything fatal was found */
	fatal: boolean;
}

interface Rule {
	rule: string;
	severity: Severity;
	reason: string;
	pattern: RegExp;
	/** a line that also matches this is not reported, for patterns with a legitimate guarded form */
	unless?: RegExp;
}

/** @internal exported so the gate can assert the catalogue rather than a sample of it */
export const SOURCE_RULES: readonly Rule[] = [
	{
		rule: 'eval',
		severity: 'fatal',
		reason: 'eval() is blocked on Workers; a runtime that needs it cannot boot',
		pattern: /(?<![.\w$])eval\s*\(/
	},
	{
		rule: 'new-function',
		severity: 'fatal',
		reason: 'new Function() is code generation from strings, which Workers blocks',
		pattern: /new\s+Function\s*\(/
	},
	{
		rule: 'wasm-codegen',
		severity: 'fatal',
		reason: 'request-time wasm compilation is blocked; ship the module as a CompiledWasm import',
		pattern: /new\s+WebAssembly\.Module\s*\(|WebAssembly\.compile(?:Streaming)?\s*\(/
	},
	{
		rule: 'xhr',
		severity: 'fatal',
		reason: 'XMLHttpRequest does not exist on Workers; this build targets a browser',
		pattern: /\bXMLHttpRequest\b/
	},
	{
		rule: 'dom',
		severity: 'warning',
		reason: 'no DOM on Workers; reachable only if the code path actually runs',
		pattern: /\b(?:document|window)\s*\./
	},
	{
		rule: 'unguarded-location',
		severity: 'warning',
		reason:
			'workerd has no location; emscripten ENVIRONMENT=worker glue reads self.location.href ' +
			'and throws before its own code runs. burrow installs a shim, so this is survivable',
		pattern: /\b(?:self\s*\.\s*)?location\s*\.\s*href\b/,
		unless: /typeof\s+location|location\s*(?:\?\.|&&|\|\||===|!==|==|!=)|\?\.\s*href/
	}
];

/** strips line and block comments so a rule does not fire on prose describing it */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, '');
}

/**
 * Scans JavaScript or TypeScript source for patterns that are fatal on Workers.
 *
 * @example
 * ```ts
 * const report = inspectSource(await readFile('runtime.js', 'utf8'), 'runtime.js');
 * if (report.fatal) for (const f of report.findings) console.error(f.rule, f.reason);
 * ```
 *
 * @since 1.0.0
 */
export function inspectSource(source: string, path?: string): DoctorReport {
	const findings: Finding[] = [];
	const scannable = stripComments(source);
	const lines = scannable.split('\n');

	for (const rule of SOURCE_RULES) {
		for (let i = 0; i < lines.length; i++) {
			const text = lines[i] ?? '';
			const hit = rule.pattern.exec(text);
			if (!hit) continue;
			if (rule.unless?.test(text)) continue;
			findings.push({
				rule: rule.rule,
				severity: rule.severity,
				reason: rule.reason,
				line: i + 1,
				match: hit[0]
			});
		}
	}

	return report(findings, 'javascript', path);
}

/** the GC proposal's type forms, which no in-wasm interpreter implements */
const GC_TYPE_FORMS = new Set([0x50, 0x5e, 0x5f]);

/**
 * Scans a `.wasm` binary for features an interpreted guest cannot use.
 *
 * The only thing that can be said statically about a wasm module here is whether it uses the GC
 * proposal - structs, arrays and their subtyping. A WasmGC guest's objects belong in the host
 * engine's garbage-collected heap, which a module running inside wasm cannot reach, so no in-wasm
 * interpreter can execute one. TeaVM's default output is WasmGC; its C backend is not.
 *
 * @since 1.0.0
 */
export function inspectWasm(bytes: Uint8Array, path?: string): DoctorReport {
	const findings: Finding[] = [];

	if (!hasWasmMagic(bytes)) {
		findings.push({
			rule: 'not-wasm',
			severity: 'fatal',
			reason: 'no \\0asm magic; this is not a WebAssembly binary'
		});
		return report(findings, 'wasm', path);
	}

	const types = sectionBody(bytes, 1);
	if (types && usesGcTypes(types)) {
		findings.push({
			rule: 'wasm-gc',
			severity: 'fatal',
			reason:
				'uses the GC proposal; its objects belong in the host engine heap, which a module ' +
				'running inside wasm cannot reach, so no in-wasm interpreter can execute it'
		});
	}

	if (usesVector(bytes)) {
		findings.push({
			rule: 'wasm-simd',
			severity: 'fatal',
			reason:
				'declares a v128 value; the interpreter implements none of the SIMD proposal, so ' +
				'the guest fails while its first vector function is compiled. Rebuild without ' +
				'-msimd128, or run it through the import or publish path'
		});
	}

	return report(findings, 'wasm', path);
}

/**
 * Whether the module declares a `v128` anywhere the binary format states it exactly.
 *
 * Read from the two places a value type is written as structured data: function signatures in the
 * type section, and the local declarations that open each function body. An opcode scan would also
 * catch a module that only moves vectors through the operand stack, but distinguishing a `0xfd`
 * prefix byte from the same byte inside an immediate needs a full instruction decoder, and a check
 * that guesses is worse than one with a stated edge. Real toolchain output declares vector locals.
 *
 * @internal
 */
export function usesVector(bytes: Uint8Array): boolean {
	const types = sectionBody(bytes, 1);
	if (types?.includes(0x7b)) return true;

	const code = sectionBody(bytes, 10);
	if (!code) return false;

	let [count, at] = readVaruint(code, 0);
	if (at < 0) return false;
	for (let i = 0; i < count; i++) {
		let size: number;
		[size, at] = readVaruint(code, at);
		if (at < 0) return false;
		const end = at + size;
		let groups: number;
		[groups, at] = readVaruint(code, at);
		if (at < 0) return false;
		for (let g = 0; g < groups; g++) {
			[, at] = readVaruint(code, at);
			if (at < 0 || at >= end) return false;
			if (code[at] === 0x7b) return true;
			at++;
		}
		at = end;
	}
	return false;
}

function report(findings: Finding[], kind: DoctorReport['kind'], path?: string): DoctorReport {
	return {
		...(path === undefined ? {} : { path }),
		kind,
		findings,
		fatal: findings.some((f) => f.severity === 'fatal')
	};
}

/** @internal */
export function hasWasmMagic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 8 &&
		bytes[0] === 0x00 &&
		bytes[1] === 0x61 &&
		bytes[2] === 0x73 &&
		bytes[3] === 0x6d
	);
}

/** @internal walks the section list and answers one section's body, or null */
export function sectionBody(bytes: Uint8Array, wanted: number): Uint8Array | null {
	let at = 8;
	while (at < bytes.length) {
		const id = bytes[at];
		if (id === undefined) return null;
		at++;
		const [size, next] = readVaruint(bytes, at);
		if (next === -1) return null;
		at = next;
		if (id === wanted) return bytes.subarray(at, at + size);
		at += size;
	}
	return null;
}

/** @internal LEB128, answering the value and the offset after it, or -1 when it runs off the end */
export function readVaruint(bytes: Uint8Array, at: number): [number, number] {
	let result = 0;
	let shift = 0;
	let i = at;
	for (;;) {
		const byte = bytes[i];
		if (byte === undefined || shift > 28) return [0, -1];
		result |= (byte & 0x7f) << shift;
		i++;
		if ((byte & 0x80) === 0) return [result >>> 0, i];
		shift += 7;
	}
}

/**
 * Whether a type section declares GC forms.
 *
 * A scan for the form bytes rather than a full decode: the question is only whether
 * the module needs the GC proposal, and a scan answers that without this package carrying a wasm
 * parser it would then have to keep current with the spec.
 */
function usesGcTypes(typeSection: Uint8Array): boolean {
	for (const byte of typeSection) {
		if (GC_TYPE_FORMS.has(byte)) return true;
	}
	return false;
}
