import { describe, expect, it } from 'vitest';
import { PublishError } from '../../src/errors.js';
import { probe, probeAndVerify, scriptUrl, subdomainUrl, throwawayName } from '../../src/probe.js';

/**
 * The probe harness, driven over a stub transport.
 *
 * Nothing here deploys. The behaviour under test is the sequence and the teardown, and both are
 * observable from what the transport was asked to do.
 */

const BASE = {
	accountId: 'acct',
	apiToken: 'token',
	scriptName: 'probe-fixed',
	modules: { 'index.js': 'export default {};' },
	samples: 2
};

/** records every call and answers per-URL canned responses */
function rig(
	overrides: {
		deploy?: Response;
		subdomain?: Response;
		hit?: () => Response;
		del?: Response;
	} = {}
) {
	const calls: { url: string; method: string }[] = [];
	let ticks = 0;
	const fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
		const target = String(url);
		const method = options.method ?? 'GET';
		calls.push({ url: target, method });

		const ok = (body: unknown) =>
			new Response(JSON.stringify(body), {
				headers: { 'content-type': 'application/json' }
			});

		if (method === 'PUT') return overrides.deploy ?? ok({ success: true, result: { id: 's' } });
		if (method === 'POST') {
			return overrides.subdomain ?? ok({ success: true, result: { subdomain: 'acme' } });
		}
		if (method === 'DELETE') return overrides.del ?? new Response('', { status: 200 });
		if (target.startsWith('https://probe-fixed')) {
			return overrides.hit ? overrides.hit() : new Response('ran');
		}
		// the existence check probeAndVerify makes after teardown
		return new Response('', { status: 404 });
	}) as unknown as typeof globalThis.fetch;

	// a clock that advances 10 ms per read, so timings are deterministic
	const now = () => (ticks += 10);
	return { fetch, calls, now };
}

describe('throwawayName', () => {
	it('is prefixed so it reads as disposable, and does not repeat', () => {
		expect(throwawayName()).toMatch(/^burrow-probe-/);
		expect(throwawayName()).not.toBe(throwawayName());
	});
});

describe('the endpoints', () => {
	it('escapes both names', () => {
		expect(scriptUrl('a/b', 'c d')).toBe(
			'https://api.cloudflare.com/client/v4/accounts/a%2Fb/workers/scripts/c%20d'
		);
		expect(subdomainUrl('a', 'b')).toBe(`${scriptUrl('a', 'b')}/subdomain`);
	});
});

describe('probe', () => {
	it('deploys, exposes, measures, then deletes', async () => {
		const { fetch, calls, now } = rig();
		await probe({ ...BASE, fetch, now });

		const shape = calls.map((c) => c.method);
		expect(shape[0]).toBe('PUT');
		expect(shape[1]).toBe('POST');
		// cold, then two warm
		expect(shape.filter((m) => m === 'GET')).toHaveLength(3);
		expect(shape.at(-1)).toBe('DELETE');
	});

	it('builds the workers.dev host from the account subdomain', async () => {
		const { fetch, calls, now } = rig();
		const result = await probe({ ...BASE, fetch, now });
		expect(result.url).toBe('https://probe-fixed.acme.workers.dev/');
		expect(calls.some((c) => c.url.startsWith('https://probe-fixed.acme.workers.dev'))).toBe(
			true
		);
	});

	it('reports the cold request apart from the warm median', async () => {
		const { fetch, now } = rig();
		const result = await probe({ ...BASE, fetch, now });
		expect(result.coldMs).toBeGreaterThan(0);
		expect(result.samples).toHaveLength(2);
		expect(result.body).toBe('ran');
	});

	it('answers tornDown false, because its own delete runs after the result is built', async () => {
		const { fetch, now } = rig();
		expect((await probe({ ...BASE, fetch, now })).tornDown).toBe(false);
	});

	it('deletes even when a request throws', async () => {
		const calls: string[] = [];
		const fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
			const method = options.method ?? 'GET';
			calls.push(method);
			if (method === 'PUT') {
				return new Response(JSON.stringify({ success: true, result: {} }), {
					headers: { 'content-type': 'application/json' }
				});
			}
			if (method === 'POST') {
				return new Response(
					JSON.stringify({ success: false, errors: [{ message: 'nope' }] }),
					{
						status: 403,
						headers: { 'content-type': 'application/json' }
					}
				);
			}
			return new Response('', { status: 200 });
		}) as unknown as typeof globalThis.fetch;

		await expect(probe({ ...BASE, fetch })).rejects.toThrow(PublishError);
		// the failure must not leave the script behind
		expect(calls).toContain('DELETE');
	});

	it('leaves the Worker deployed when asked to', async () => {
		const { fetch, calls, now } = rig();
		await probe({ ...BASE, fetch, now, keep: true });
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
	});

	it('carries the API error list when the deploy is refused', async () => {
		const { fetch, now } = rig({
			deploy: new Response(
				JSON.stringify({ success: false, errors: [{ message: 'no quota' }] }),
				{
					status: 403,
					headers: { 'content-type': 'application/json' }
				}
			)
		});
		try {
			await probe({ ...BASE, fetch, now });
			expect.unreachable('a refused deploy must throw');
		} catch (e) {
			expect((e as PublishError).status).toBe(403);
			expect((e as PublishError).errors).toEqual(['no quota']);
		}
	});

	it('falls back to a bare host when the account exposes no subdomain', async () => {
		const { fetch, now } = rig({
			subdomain: new Response(JSON.stringify({ success: true, result: {} }), {
				headers: { 'content-type': 'application/json' }
			})
		});
		expect((await probe({ ...BASE, fetch, now })).url).toBe('https://probe-fixed.workers.dev/');
	});

	it('sends the method and body the caller asked for', async () => {
		const seen: RequestInit[] = [];
		const { fetch, now } = rig();
		const recording = (async (url: string | URL | Request, options: RequestInit = {}) => {
			if (
				(options.method ?? 'GET') === 'POST' &&
				String(url).startsWith('https://probe-fixed')
			) {
				seen.push(options);
			}
			return fetch(url, options);
		}) as unknown as typeof globalThis.fetch;

		await probe({
			...BASE,
			fetch: recording,
			now,
			request: { method: 'POST', body: '<?php echo 1;', headers: { 'x-burrow': '1' } }
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.body).toBe('<?php echo 1;');
	});
});

describe('probeAndVerify', () => {
	it('checks the script is gone and reports it', async () => {
		const { fetch, now } = rig();
		expect((await probeAndVerify({ ...BASE, fetch, now })).tornDown).toBe(true);
	});

	it('reports a teardown that did not take', async () => {
		const fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
			const method = options.method ?? 'GET';
			const ok = (body: unknown) =>
				new Response(JSON.stringify(body), {
					headers: { 'content-type': 'application/json' }
				});
			if (method === 'PUT') return ok({ success: true, result: {} });
			if (method === 'POST') return ok({ success: true, result: { subdomain: 'acme' } });
			if (method === 'DELETE') return new Response('', { status: 500 });
			if (String(url).startsWith('https://probe-fixed.acme')) return new Response('ran');
			// the script is still there after a failed delete
			return ok({ success: true, result: {} });
		}) as unknown as typeof globalThis.fetch;

		const { now } = rig();
		expect((await probeAndVerify({ ...BASE, fetch, now })).tornDown).toBe(false);
	});

	it('skips the check when the Worker was meant to stay', async () => {
		const { fetch, now } = rig();
		expect((await probeAndVerify({ ...BASE, fetch, now, keep: true })).tornDown).toBe(false);
	});
});
