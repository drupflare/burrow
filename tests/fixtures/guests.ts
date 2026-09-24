/** guests for the parallel spec, pinned as bytes; tests/node/interpret.spec.ts proves they match their sources */
export const RANGE_WAT =
	'(module\n  (func $burn (param $n i32) (param $x i32) (result i32)\n    (block $done\n      (loop $l\n        (br_if $done (i32.eqz (local.get $n)))\n        (local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 13))))\n        (local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 17))))\n        (local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 5))))\n        (local.set $n (i32.sub (local.get $n) (i32.const 1)))\n        (br $l)))\n    (local.get $x))\n  (memory (export "memory") 1)\n  (func $range (export "range") (param $start i32) (param $end i32) (param $m i32) (result i32)\n    (local $acc i32)\n    (block $done\n      (loop $l\n        (br_if $done (i32.ge_u (local.get $start) (local.get $end)))\n        (local.set $acc (i32.add (local.get $acc) (call $burn (local.get $m) (i32.add (local.get $start) (i32.const 1)))))\n        (local.set $start (i32.add (local.get $start) (i32.const 1)))\n        (br $l)))\n    (local.get $acc))\n  (func (export "part") (param $p i32) (param $n i32) (param $m i32) (result i32)\n    (call $range (i32.load (local.get $p)) (i32.load offset=4 (local.get $p)) (local.get $m))))';
export const RANGE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 14, 2, 96, 2, 127, 127, 1, 127, 96, 3, 127, 127, 127, 1, 127, 3,
	4, 3, 0, 1, 1, 5, 3, 1, 0, 1, 7, 25, 3, 6, 109, 101, 109, 111, 114, 121, 2, 0, 5, 114, 97, 110,
	103, 101, 0, 1, 4, 112, 97, 114, 116, 0, 2, 10, 116, 3, 54, 0, 2, 64, 3, 64, 32, 0, 69, 13, 1,
	32, 1, 32, 1, 65, 13, 116, 115, 33, 1, 32, 1, 32, 1, 65, 17, 118, 115, 33, 1, 32, 1, 32, 1, 65,
	5, 116, 115, 33, 1, 32, 0, 65, 1, 107, 33, 0, 12, 0, 11, 11, 32, 1, 11, 42, 1, 1, 127, 2, 64, 3,
	64, 32, 0, 32, 1, 79, 13, 1, 32, 3, 32, 2, 32, 0, 65, 1, 106, 16, 0, 106, 33, 3, 32, 0, 65, 1,
	106, 33, 0, 12, 0, 11, 11, 32, 3, 11, 16, 0, 32, 0, 40, 2, 0, 32, 0, 40, 2, 4, 32, 2, 16, 1, 11
]);
/** range(0, 4096, 200), computed natively; any split sums to it */
export const RANGE_TOTAL = 46488369;

export const DATA_WAT =
	'(module\n  (memory (export "memory") 2)\n  (func (export "alloc") (param $n i32) (result i32) (i32.const 1024))\n  (func (export "fnv") (param $p i32) (param $n i32) (result i32)\n    (local $h i32) (local $e i32)\n    (local.set $h (i32.const 0x811c9dc5))\n    (local.set $e (i32.add (local.get $p) (local.get $n)))\n    (block $d (loop $l\n      (br_if $d (i32.ge_u (local.get $p) (local.get $e)))\n      (local.set $h (i32.mul (i32.xor (local.get $h) (i32.load8_u (local.get $p))) (i32.const 0x01000193)))\n      (local.set $p (i32.add (local.get $p) (i32.const 1)))\n      (br $l)))\n    (local.get $h))\n  (func (export "echo") (param $p i32) (param $n i32) (result i32)\n    (local $i i32)\n    (i32.store (i32.const 65536) (local.get $n))\n    (block $d (loop $l\n      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))\n      (i32.store8 (i32.add (i32.const 65540) (local.get $i)) (i32.load8_u (i32.add (local.get $p) (local.get $i))))\n      (local.set $i (i32.add (local.get $i) (i32.const 1)))\n      (br $l)))\n    (i32.const 65536)))';
export const DATA = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 1, 127, 1, 127, 96, 2, 127, 127, 1, 127, 3, 4, 3, 0,
	1, 1, 5, 3, 1, 0, 2, 7, 31, 4, 6, 109, 101, 109, 111, 114, 121, 2, 0, 5, 97, 108, 108, 111, 99,
	0, 0, 3, 102, 110, 118, 0, 1, 4, 101, 99, 104, 111, 0, 2, 10, 125, 3, 5, 0, 65, 128, 8, 11, 59,
	1, 2, 127, 65, 197, 187, 242, 136, 120, 33, 2, 32, 0, 32, 1, 106, 33, 3, 2, 64, 3, 64, 32, 0,
	32, 3, 79, 13, 1, 32, 2, 32, 0, 45, 0, 0, 115, 65, 147, 131, 128, 8, 108, 33, 2, 32, 0, 65, 1,
	106, 33, 0, 12, 0, 11, 11, 32, 2, 11, 57, 1, 1, 127, 65, 128, 128, 4, 32, 1, 54, 2, 0, 2, 64, 3,
	64, 32, 2, 32, 1, 79, 13, 1, 65, 132, 128, 4, 32, 2, 106, 32, 0, 32, 2, 106, 45, 0, 0, 58, 0, 0,
	32, 2, 65, 1, 106, 33, 2, 12, 0, 11, 11, 65, 128, 128, 4, 11
]);

export const IMPURE_WAT =
	'(module\n  (import "host" "double" (func $double (param i32) (result i32)))\n  (func (export "twice") (param i32) (result i32) (call $double (local.get 0))))';
export const IMPURE = new Uint8Array([
	0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 2, 15, 1, 4, 104, 111, 115, 116, 6,
	100, 111, 117, 98, 108, 101, 0, 0, 3, 2, 1, 0, 7, 9, 1, 5, 116, 119, 105, 99, 101, 0, 1, 10, 8,
	1, 6, 0, 32, 0, 16, 0, 11
]);
