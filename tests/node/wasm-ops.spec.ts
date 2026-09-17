import { describe, expect, it } from 'vitest';
import { countImportedFunctions, readFunctionBodies, readOps } from '../../tools/wasm-ops.js';
import { wat } from './wat.js';

/**
 * The code-section reader.
 *
 * It exists so instruction counts come from the bytes rather than from counting by hand, and a
 * decoder that drifts by one immediate silently corrupts every figure derived from it. So the
 * checks below are about staying in step with the stream, not about recognising opcodes.
 */

const bodiesOf = (source: string) => readFunctionBodies(wat(source));
const namesOf = (source: string) => bodiesOf(source)[0]?.map((op) => op.name) ?? [];

describe('readFunctionBodies', () => {
	it('answers one body per function, in index order', () => {
		const bodies = bodiesOf(`(module
		  (func (result i32) (i32.const 1))
		  (func (result i32) (i32.const 2) (drop) (i32.const 3))
		)`);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.map((o) => o.name)).toEqual(['i32.const', 'end']);
		expect(bodies[1]?.map((o) => o.name)).toContain('drop');
	});

	it('answers nothing for bytes that are not wasm', () => {
		expect(readFunctionBodies(new Uint8Array([1, 2, 3]))).toEqual([]);
		expect(readFunctionBodies(new Uint8Array())).toEqual([]);
	});

	it('answers nothing for a module with no code section', () => {
		expect(readFunctionBodies(wat('(module (memory 1))'))).toEqual([]);
	});

	it('skips local declarations rather than reading them as opcodes', () => {
		// three local groups then a single const; a reader that mistook them for opcodes would
		// produce far more than two instructions
		expect(
			namesOf('(module (func (local i32) (local i64) (local f32) (i32.const 1) (drop)))')
		).toEqual(['i32.const', 'drop', 'end']);
	});
});

describe('staying in step with immediates', () => {
	it('walks past a memarg', () => {
		expect(
			namesOf('(module (memory 1) (func (i32.load offset=64 (i32.const 0)) (drop)))')
		).toEqual(['i32.const', 'i32.load', 'drop', 'end']);
	});

	it('walks past a 64-bit constant', () => {
		expect(namesOf('(module (func (i64.const 9223372036854775807) (drop)))')).toEqual([
			'i64.const',
			'drop',
			'end'
		]);
	});

	it('walks past float constants, whose immediates are not LEB encoded', () => {
		expect(namesOf('(module (func (f32.const 1.5) (drop) (f64.const 2.5) (drop)))')).toEqual([
			'f32.const',
			'drop',
			'f64.const',
			'drop',
			'end'
		]);
	});

	it('walks past a br_table target list', () => {
		const names = namesOf(`(module (func (param i32)
		  (block (block (block (br_table 0 1 2 (local.get 0)))))))`);
		expect(names).toContain('br_table');
		expect(names.filter((n) => n === 'end')).toHaveLength(4);
	});

	it('walks past a call_indirect type and table index', () => {
		const names = namesOf(`(module
		  (type $t (func (result i32)))
		  (table 1 funcref)
		  (func (result i32) (call_indirect (type $t) (i32.const 0))))`);
		expect(names).toEqual(['i32.const', 'call_indirect', 'end']);
	});

	it('reads a block type that names a result', () => {
		expect(namesOf('(module (func (result i32) (block (result i32) (i32.const 1))))')).toEqual([
			'block',
			'i32.const',
			'end',
			'end'
		]);
	});
});

describe('depth', () => {
	it('rises inside a block and falls at its end', () => {
		const ops = bodiesOf('(module (func (block (block (nop)))))')[0] ?? [];
		const nop = ops.find((o) => o.name === 'nop');
		expect(nop?.depth).toBe(2);
		expect(ops[ops.length - 1]?.depth).toBe(0);
	});

	it('marks a loop body deeper than the code around it', () => {
		const ops =
			bodiesOf(`(module (func (param $n i32)
		  (loop $l
		    (local.set $n (i32.sub (local.get $n) (i32.const 1)))
		    (br_if $l (local.get $n)))))`)[0] ?? [];
		const inLoop = ops.find((o) => o.name === 'i32.sub');
		expect(inLoop?.depth).toBe(1);
	});
});

describe('readOps', () => {
	it('answers nothing for an empty body', () => {
		expect(readOps(new Uint8Array())).toEqual([]);
	});

	it('names an unknown opcode by its byte rather than dropping it', () => {
		// a body with no locals, then a byte nothing maps to
		const ops = readOps(new Uint8Array([0x00, 0xd0, 0x0b]));
		expect(ops[0]?.name).toBe('0xd0');
	});

	it('records the byte offset of each instruction', () => {
		const ops = bodiesOf('(module (func (i32.const 1) (drop)))')[0] ?? [];
		expect(ops[0]?.at).toBeLessThan(ops[1]?.at as number);
	});
});

describe('call targets', () => {
	it('answers the callee index on a direct call', () => {
		const bodies = bodiesOf(`(module
		  (func $a (result i32) (i32.const 1))
		  (func $b (result i32) (i32.const 2))
		  (func (result i32) (i32.add (call $a) (call $b))))`);
		const calls = (bodies[2] ?? []).filter((op) => op.name === 'call');
		expect(calls.map((op) => op.index)).toEqual([0, 1]);
	});

	it('leaves the index unset on an indirect call', () => {
		const bodies = bodiesOf(`(module
		  (type $t (func (result i32)))
		  (table 1 funcref)
		  (func (result i32) (call_indirect (type $t) (i32.const 0))))`);
		const indirect = (bodies[0] ?? []).find((op) => op.name === 'call_indirect');
		expect(indirect?.index).toBeUndefined();
	});

	it('stays in step with the stream after a call', () => {
		// the immediate is consumed by the reader, so a drifting decode shows up as a wrong successor
		const bodies = bodiesOf(`(module
		  (func $a (result i32) (i32.const 1))
		  (func (result i32) (i32.add (call $a) (i32.const 2))))`);
		expect((bodies[1] ?? []).map((op) => op.name)).toEqual([
			'call',
			'i32.const',
			'i32.add',
			'end'
		]);
	});
});

describe('countImportedFunctions', () => {
	it('counts only function imports, past a table, a memory and a global', () => {
		const bytes = wat(`(module
		  (import "e" "f" (func (result i32)))
		  (import "e" "t" (table 1 funcref))
		  (import "e" "m" (memory 1))
		  (import "e" "g" (global i32))
		  (import "e" "h" (func (param i32)))
		  (func (result i32) (i32.const 0)))`);
		expect(countImportedFunctions(bytes)).toBe(2);
	});

	it('answers zero when a module imports nothing', () => {
		expect(countImportedFunctions(wat('(module (func (result i32) (i32.const 0)))'))).toBe(0);
	});

	it('offsets a call index onto the defined bodies', () => {
		const source = `(module
		  (import "e" "log" (func $log (param i32)))
		  (func $helper (result i32) (i32.const 7))
		  (func (result i32) (call $helper)))`;
		const bytes = wat(source);
		const imported = countImportedFunctions(bytes);
		const bodies = readFunctionBodies(bytes);
		const call = (bodies[1] ?? []).find((op) => op.name === 'call');
		expect(bodies[(call?.index as number) - imported]?.[0]?.name).toBe('i32.const');
	});
});
