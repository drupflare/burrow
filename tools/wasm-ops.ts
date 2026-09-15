/**
 * A wasm code-section reader: function bodies as flat opcode sequences.
 *
 * Two things need it. Measurement needs an exact dynamic instruction count, because a hand-counted
 * one silently corrupts every derived figure - a per-row D_cy that should be constant and is not is
 * usually the count, not the interpreter. And the superinstruction miner needs the opcode stream to
 * tile.
 *
 * It decodes far enough to walk instructions and no further: immediates are measured, not
 * interpreted, apart from the block types that decide nesting.
 */

/** one decoded instruction */
export interface Op {
	/** the opcode byte, or 0xfc00 | sub for the saturating-conversion prefix */
	code: number;
	/** its mnemonic, when one is known */
	name: string;
	/** byte offset of the opcode within the function body */
	at: number;
	/** how deep in blocks this instruction sits; a proxy for loop weight */
	depth: number;
}

/** the opcodes worth naming: everything a compiler emits in volume */
const NAMES: Record<number, string> = {
	0x00: 'unreachable',
	0x01: 'nop',
	0x02: 'block',
	0x03: 'loop',
	0x04: 'if',
	0x05: 'else',
	0x0b: 'end',
	0x0c: 'br',
	0x0d: 'br_if',
	0x0e: 'br_table',
	0x0f: 'return',
	0x10: 'call',
	0x11: 'call_indirect',
	0x1a: 'drop',
	0x1b: 'select',
	0x20: 'local.get',
	0x21: 'local.set',
	0x22: 'local.tee',
	0x23: 'global.get',
	0x24: 'global.set',
	0x28: 'i32.load',
	0x29: 'i64.load',
	0x2a: 'f32.load',
	0x2b: 'f64.load',
	0x2c: 'i32.load8_s',
	0x2d: 'i32.load8_u',
	0x2e: 'i32.load16_s',
	0x2f: 'i32.load16_u',
	0x36: 'i32.store',
	0x37: 'i64.store',
	0x38: 'f32.store',
	0x39: 'f64.store',
	0x3a: 'i32.store8',
	0x3b: 'i32.store16',
	0x3f: 'memory.size',
	0x40: 'memory.grow',
	0x41: 'i32.const',
	0x42: 'i64.const',
	0x43: 'f32.const',
	0x44: 'f64.const',
	0x45: 'i32.eqz',
	0x46: 'i32.eq',
	0x47: 'i32.ne',
	0x48: 'i32.lt_s',
	0x49: 'i32.lt_u',
	0x4a: 'i32.gt_s',
	0x4b: 'i32.gt_u',
	0x4c: 'i32.le_s',
	0x4d: 'i32.le_u',
	0x4e: 'i32.ge_s',
	0x4f: 'i32.ge_u',
	0x6a: 'i32.add',
	0x6b: 'i32.sub',
	0x6c: 'i32.mul',
	0x6d: 'i32.div_s',
	0x6e: 'i32.div_u',
	0x6f: 'i32.rem_s',
	0x70: 'i32.rem_u',
	0x71: 'i32.and',
	0x72: 'i32.or',
	0x73: 'i32.xor',
	0x74: 'i32.shl',
	0x75: 'i32.shr_s',
	0x76: 'i32.shr_u',
	0x77: 'i32.rotl',
	0x78: 'i32.rotr',
	0x7c: 'i64.add',
	0x7d: 'i64.sub',
	0x7e: 'i64.mul',
	0xa7: 'i32.wrap_i64',
	0xac: 'i64.extend_i32_s',
	0xad: 'i64.extend_i32_u'
};

/** how many immediate bytes follow each opcode, beyond the LEB reader's own work */
const enum Imm {
	None,
	Leb,
	TwoLeb,
	MemArg,
	BlockType,
	BrTable,
	F32,
	F64
}

function immediateOf(code: number): Imm {
	if (code === 0x02 || code === 0x03 || code === 0x04) return Imm.BlockType;
	if (code === 0x0e) return Imm.BrTable;
	if (code === 0x11) return Imm.TwoLeb;
	if (code === 0x43) return Imm.F32;
	if (code === 0x44) return Imm.F64;
	if (code >= 0x28 && code <= 0x3e) return Imm.MemArg;
	if (code === 0x3f || code === 0x40) return Imm.Leb;
	if (code >= 0x0c && code <= 0x0d) return Imm.Leb;
	if (code === 0x10) return Imm.Leb;
	if (code >= 0x20 && code <= 0x24) return Imm.Leb;
	if (code >= 0x41 && code <= 0x42) return Imm.Leb;
	return Imm.None;
}

/** @internal unsigned LEB128, answering the value and the offset after it */
function leb(bytes: Uint8Array, at: number): [number, number] {
	let result = 0;
	let shift = 0;
	for (;;) {
		const byte = bytes[at++];
		if (byte === undefined) return [0, -1];
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [result >>> 0, at];
		shift += 7;
		if (shift > 35) return [0, -1];
	}
}

/** @internal signed LEB128, which only needs skipping here */
function skipLeb(bytes: Uint8Array, at: number): number {
	for (;;) {
		const byte = bytes[at++];
		if (byte === undefined) return -1;
		if ((byte & 0x80) === 0) return at;
	}
}

/** Decodes one function body into its instruction sequence. */
export function readOps(body: Uint8Array): Op[] {
	const ops: Op[] = [];
	let at = 0;
	let depth = 0;

	// local declarations first: a count, then that many (count, type) pairs
	let count: number;
	[count, at] = leb(body, at);
	if (at < 0) return ops;
	for (let i = 0; i < count; i++) {
		at = skipLeb(body, at);
		if (at < 0) return ops;
		at++; // value type
	}

	while (at < body.length) {
		const start = at;
		const code = body[at++] as number;

		if (code === 0x0b || code === 0x05) {
			// end and else close a level; end at depth 0 terminates the body
			if (code === 0x0b) depth = Math.max(0, depth - 1);
			ops.push({ code, name: NAMES[code] ?? `0x${code.toString(16)}`, at: start, depth });
			continue;
		}

		ops.push({ code, name: NAMES[code] ?? `0x${code.toString(16)}`, at: start, depth });

		switch (immediateOf(code)) {
			case Imm.BlockType: {
				const type = body[at];
				// 0x40 is the empty type; a negative value type is one byte; anything else is an index
				at =
					type === 0x40 || (type !== undefined && type >= 0x7b)
						? at + 1
						: skipLeb(body, at);
				depth++;
				break;
			}
			case Imm.BrTable: {
				let targets: number;
				[targets, at] = leb(body, at);
				if (at < 0) return ops;
				for (let i = 0; i <= targets; i++) {
					at = skipLeb(body, at);
					if (at < 0) return ops;
				}
				break;
			}
			case Imm.MemArg:
				at = skipLeb(body, at);
				if (at >= 0) at = skipLeb(body, at);
				break;
			case Imm.TwoLeb:
				at = skipLeb(body, at);
				if (at >= 0) at = skipLeb(body, at);
				break;
			case Imm.Leb:
				at = skipLeb(body, at);
				break;
			case Imm.F32:
				at += 4;
				break;
			case Imm.F64:
				at += 8;
				break;
			case Imm.None:
				break;
		}
		if (at < 0) return ops;
	}
	return ops;
}

/** Every function body in a module, in index order, as opcode sequences. */
export function readFunctionBodies(wasm: Uint8Array): Op[][] {
	const bodies: Op[][] = [];
	if (
		wasm.length < 8 ||
		wasm[0] !== 0x00 ||
		wasm[1] !== 0x61 ||
		wasm[2] !== 0x73 ||
		wasm[3] !== 0x6d
	) {
		return bodies;
	}

	let at = 8;
	while (at < wasm.length) {
		const id = wasm[at++] as number;
		let size: number;
		[size, at] = leb(wasm, at);
		if (at < 0) return bodies;
		const end = at + size;
		if (id === 10) {
			let count: number;
			let cursor: number;
			[count, cursor] = leb(wasm, at);
			if (cursor < 0) return bodies;
			for (let i = 0; i < count; i++) {
				let bodySize: number;
				[bodySize, cursor] = leb(wasm, cursor);
				if (cursor < 0) return bodies;
				bodies.push(readOps(wasm.subarray(cursor, cursor + bodySize)));
				cursor += bodySize;
			}
			return bodies;
		}
		at = end;
	}
	return bodies;
}
