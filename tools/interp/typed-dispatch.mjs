/**
 * Retypes the interpreter's dispatch table from `funcref` to a non-nullable typed function
 * reference, so V8 can prove every entry's signature and stop emitting the runtime check.
 *
 * LLVM gives every C function pointer one shared `funcref` table and has no `function-references`
 * target feature, so this cannot come out of emcc; it is a post-link rewrite over the wat.
 *
 * Three properties make it safe, and each is asserted rather than assumed: wasm3's dispatch is
 * homogeneous, the table must be non-nullable or V8 keeps the load as a null check, and the typed
 * table must stay at index 0 or V8 loses the inline instance-data slot.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error('usage: typed-dispatch.mjs <in.wat> <out.wat>');
	process.exit(2);
}

const wat = readFileSync(input, 'utf8');
const fail = (why) => {
	console.error(`typed-dispatch: ${why}`);
	process.exit(1);
};

const OPSIG = '(func (param i32 i32 i32 i64 f64) (result i32))';
const sig0 = wat.match(/^ {2}\(type \(;0;\) (\(func[^\n]*)\)$/m);
if (!sig0 || sig0[1] !== OPSIG) fail(`type 0 is not wasm3's handler signature, found ${sig0?.[1]}`);

const fnType = new Map();
for (const m of wat.matchAll(/^ {2}\(func \(;(\d+);\) \(type (\d+)\)/gm)) fnType.set(+m[1], +m[2]);
for (const m of wat.matchAll(
	/^ {2}\(import "[^"]*" "[^"]*" \(func \(;(\d+);\) \(type (\d+)\)\)\)/gm
))
	fnType.set(+m[1], +m[2]);
if (!fnType.size) fail('no functions found; the wat dialect changed');

// appended rather than reusing an existing function, so no index shifts and no elem entry moves
const stub = Math.max(...fnType.keys()) + 1;

const table = wat.match(/^ {2}\(table \(;0;\) (\d+) (\d+) funcref\)$/m);
if (!table) fail('table 0 is not a fixed-size funcref table');
const [decl, min, max] = table;

const elem = wat.match(/^ {2}\(elem \(;0;\) \(i32\.const (\d+)\) func ([\d\s]+)\)$/m);
if (!elem) fail('elem segment 0 is not a flat active func list');
const base = elem[1];
const entries = elem[2].trim().split(/\s+/).map(Number);

// a slot holding a foreign signature was already unreachable through a dispatch site, since the
// signature check would have trapped; it traps as unreachable instead
const mirrored = entries.map((f) => (fnType.get(f) === 0 ? f : stub));

let out = wat;
const rep = (from, to) => {
	if (!out.includes(from)) fail(`could not find ${from.trim()}`);
	out = out.replace(from, to);
};

rep(
	`${decl}\n`,
	`  (table (;0;) ${min} ${max} (ref 0) (ref.func ${stub}))\n` +
		`  (table (;1;) ${min} ${max} funcref)\n`
);
rep(
	'(export "__indirect_function_table" (table 0))',
	'(export "__indirect_function_table" (table 1))'
);
rep(
	`${elem[0]}\n`,
	`  (elem (;0;) (table 0) (i32.const ${base}) (ref 0) ${mirrored.map((f) => `(ref.func ${f})`).join(' ')})\n` +
		`  (elem (;1;) (table 1) (i32.const ${base}) func ${entries.join(' ')})\n`
);

// the handler sites stay on table 0; everything else is a normal indirect call and moves to table 1
let moved = 0;
out = out.replace(/(?<!return_)call_indirect \(type ([1-9]\d*)\)/g, (_, t) => {
	moved++;
	return `call_indirect 1 (type ${t})`;
});

const close = out.lastIndexOf(')');
out =
	`${out.slice(0, close)}  (func (;${stub};) (type 0) (param i32 i32 i32 i64 f64) (result i32)\n` +
	`    unreachable\n  )\n${out.slice(close)}`;

writeFileSync(output, out);

const dispatch = (wat.match(/return_call_indirect \(type 0\)/g) ?? []).length;
if (!dispatch) fail('no type-0 tail dispatches found; this is not the wasm3 interpreter');
console.log(
	`typed-dispatch: ${dispatch} dispatch sites kept, ${mirrored.length - mirrored.filter((f) => f === stub).length} typed slots, ` +
		`${mirrored.filter((f) => f === stub).length} stubbed, ${moved} cold sites moved to table 1`
);
