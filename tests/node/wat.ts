import wabt from 'wabt';

/**
 * Features the fixtures need: annotations to write a `dylink.0` custom section by hand, SIMD to
 * assemble the guest the interpreter is supposed to refuse. The rest are what `wat2wasm` enables by
 * default, kept so a later fixture does not fail to parse for a reason unrelated to what it tests.
 */
const FEATURES = {
	annotations: true,
	simd: true,
	bulk_memory: true,
	reference_types: true,
	sign_extension: true,
	mutable_globals: true,
	multi_value: true,
	sat_float_to_int: true,
	tail_call: true
};

// top-level await, so an importing spec gets a ready assembler and wat itself can stay synchronous
const assembler = await wabt();

/**
 * Assembles wat source, so a fixture is readable in the spec that uses it rather than a committed
 * binary nobody can diff.
 *
 * wabt runs as wasm here rather than as an installed `wat2wasm`, because the gate has to pass on a
 * machine that has never heard of wabt.
 *
 * @internal
 */
export function wat(source: string): Uint8Array {
	const module = assembler.parseWat('fixture.wat', source, FEATURES);
	try {
		return module.toBinary({}).buffer;
	} finally {
		module.destroy();
	}
}
