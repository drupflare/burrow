import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeError } from '../src/errors.js';
import { defineRuntime, installLocationShim, type Interpreter } from '../src/runtime.js';

const ok = {
	name: 'ok',
	load: async () => ({}),
	instantiate: (): Interpreter => ({
		FS: {
			writeFile: () => {},
			readFile: () => new Uint8Array(),
			mkdir: () => undefined,
			analyzePath: () => ({ exists: false })
		},
		callMain: () => 0
	})
};

describe('defineRuntime', () => {
	it('answers the spec it was given', () => {
		expect(defineRuntime(ok)).toBe(ok);
	});

	it.each([
		[{ ...ok, name: '' }, 'a runtime spec needs a non-empty string name'],
		[{ ...ok, name: 42 as unknown as string }, 'a runtime spec needs a non-empty string name'],
		[{ ...ok, load: undefined as unknown as () => Promise<unknown> }, 'needs a load() thunk'],
		[
			{ ...ok, instantiate: undefined as unknown as () => Interpreter },
			'needs an instantiate()'
		]
	])('refuses a malformed spec', (spec, fragment) => {
		expect(() => defineRuntime(spec)).toThrow(RuntimeError);
		try {
			defineRuntime(spec);
		} catch (e) {
			expect((e as RuntimeError).code).toBe('burrow.runtime.contract_violation');
			expect((e as RuntimeError).message).toContain(fragment);
		}
	});
});

describe('installLocationShim', () => {
	const g = globalThis as unknown as { location?: { href: string } };
	const original = Object.getOwnPropertyDescriptor(globalThis, 'location');

	afterEach(() => {
		if (original) Object.defineProperty(globalThis, 'location', original);
		else Reflect.deleteProperty(globalThis, 'location');
	});

	it('installs a location on workerd, which has none', () => {
		// this project runs in workerd, where the shim is exactly what emscripten worker glue needs
		Reflect.deleteProperty(globalThis, 'location');
		installLocationShim();
		expect(typeof g.location?.href).toBe('string');
	});

	it('never overwrites a real location', () => {
		Object.defineProperty(globalThis, 'location', {
			value: { href: 'https://real.example/' },
			configurable: true,
			writable: true
		});
		installLocationShim();
		expect(g.location?.href).toBe('https://real.example/');
	});
});
