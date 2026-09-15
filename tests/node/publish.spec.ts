import { describe, expect, it } from 'vitest';
import { PublishError } from '../../src/errors.js';
import { buildForm, publishVersion, versionsUrl } from '../../src/publish.js';

/**
 * The versions client, driven over a stub transport.
 *
 * In the node lane and never against the real API: this is the one part of burrow that changes
 * infrastructure, and a test that uploads a version would leave one behind on someone's account.
 */

const BASE = {
	accountId: 'acct',
	apiToken: 'token',
	scriptName: 'executor',
	modules: { 'index.js': 'export default {};' }
};

/** a transport that records what it was handed and answers a canned envelope */
function stub(body: unknown, init: ResponseInit = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
		calls.push({ url: String(url), init: options });
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
			...init
		});
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

const accepted = {
	success: true,
	result: { id: 'v-123', number: 7, preview_url: 'https://v-123.executor.workers.dev' }
};

describe('versionsUrl', () => {
	it('targets the versions endpoint and escapes both names', () => {
		expect(versionsUrl('a/b', 'c d')).toBe(
			'https://api.cloudflare.com/client/v4/accounts/a%2Fb/workers/scripts/c%20d/versions'
		);
	});
});

describe('buildForm', () => {
	it('names the entry point and carries every module', () => {
		const form = buildForm({
			...BASE,
			modules: { 'index.js': 'export default {};', 'program.wasm': new Uint8Array([0, 97]) },
			mainModule: 'index.js'
		});
		expect(form.get('index.js')).toBeInstanceOf(Blob);
		expect(form.get('program.wasm')).toBeInstanceOf(Blob);
		expect(form.get('metadata')).toBeInstanceOf(Blob);
	});

	it('types a wasm module as wasm and a script as an ES module', () => {
		const form = buildForm({
			...BASE,
			modules: { 'a.js': 'x', 'b.wasm': new Uint8Array([0]), 'c.json': '{}' }
		});
		expect((form.get('a.js') as Blob).type).toBe('application/javascript+module');
		expect((form.get('b.wasm') as Blob).type).toBe('application/wasm');
		expect((form.get('c.json') as Blob).type).toBe('application/json');
	});

	it('records the entry, the compatibility date and the message in the metadata', async () => {
		const form = buildForm({
			...BASE,
			mainModule: 'index.js',
			compatibilityDate: '2026-08-22',
			compatibilityFlags: ['nodejs_compat'],
			message: 'generated at request time'
		});
		const metadata = JSON.parse(await (form.get('metadata') as Blob).text());
		expect(metadata.main_module).toBe('index.js');
		expect(metadata.compatibility_date).toBe('2026-08-22');
		expect(metadata.compatibility_flags).toEqual(['nodejs_compat']);
		expect(metadata.annotations['workers/message']).toBe('generated at request time');
	});

	it('defaults the entry to the first module', async () => {
		const form = buildForm({ ...BASE, modules: { 'first.js': 'x', 'second.js': 'y' } });
		const metadata = JSON.parse(await (form.get('metadata') as Blob).text());
		expect(metadata.main_module).toBe('first.js');
	});

	it('refuses an empty module set', () => {
		expect(() => buildForm({ ...BASE, modules: {} })).toThrow(PublishError);
	});

	it('refuses an entry point that is not one of the modules', () => {
		try {
			buildForm({ ...BASE, mainModule: 'absent.js' });
			expect.unreachable('an entry that is not in the set cannot be the entry');
		} catch (e) {
			expect((e as PublishError).code).toBe('burrow.publish.rejected');
			expect((e as PublishError).message).toContain('index.js');
		}
	});
});

describe('publishVersion', () => {
	it('posts to the versions endpoint with a bearer token', async () => {
		const { fetch, calls } = stub(accepted);
		await publishVersion({ ...BASE, fetch });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(versionsUrl('acct', 'executor'));
		expect(calls[0]?.init.method).toBe('POST');
		expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
			'Bearer token'
		);
	});

	it('leaves the content type to FormData, so the boundary is right', async () => {
		const { fetch, calls } = stub(accepted);
		await publishVersion({ ...BASE, fetch });
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
	});

	it('answers the version id and the preview url', async () => {
		const { fetch } = stub(accepted);
		expect(await publishVersion({ ...BASE, fetch })).toEqual({
			versionId: 'v-123',
			previewUrl: 'https://v-123.executor.workers.dev',
			number: 7
		});
	});

	it('answers a null preview url rather than inventing one', async () => {
		const { fetch } = stub({ success: true, result: { id: 'v-9' } });
		const result = await publishVersion({ ...BASE, fetch });
		expect(result.previewUrl).toBeNull();
		expect(result.number).toBeNull();
	});

	it('carries the API error list rather than just a status', async () => {
		const { fetch } = stub(
			{ success: false, errors: [{ message: 'script not found', code: 10007 }] },
			{ status: 404 }
		);
		try {
			await publishVersion({ ...BASE, fetch });
			expect.unreachable('a refused upload must throw');
		} catch (e) {
			const error = e as PublishError;
			expect(error.code).toBe('burrow.publish.rejected');
			expect(error.status).toBe(404);
			expect(error.errors).toEqual(['script not found']);
			expect(error.message).toContain('script not found');
		}
	});

	it('treats success:false as a failure even on a 200', async () => {
		const { fetch } = stub({ success: false, errors: [] });
		await expect(publishVersion({ ...BASE, fetch })).rejects.toThrow(PublishError);
	});

	it('fails rather than returning an empty id when the API answers without one', async () => {
		const { fetch } = stub({ success: true, result: {} });
		try {
			await publishVersion({ ...BASE, fetch });
			expect.unreachable('a version with no id is not a version');
		} catch (e) {
			expect((e as PublishError).code).toBe('burrow.publish.rejected');
		}
	});

	it('survives a body that is not JSON', async () => {
		const fetch = (async () =>
			new Response('<html>502</html>', {
				status: 502
			})) as unknown as typeof globalThis.fetch;
		try {
			await publishVersion({ ...BASE, fetch });
			expect.unreachable('a 502 must throw');
		} catch (e) {
			expect((e as PublishError).status).toBe(502);
		}
	});

	it('reports a transport failure apart from a refusal', async () => {
		const fetch = (async () => {
			throw new Error('econnreset');
		}) as unknown as typeof globalThis.fetch;
		try {
			await publishVersion({ ...BASE, fetch });
			expect.unreachable('an unreachable API must throw');
		} catch (e) {
			expect((e as PublishError).code).toBe('burrow.publish.unreachable');
			expect((e as PublishError).status).toBe(0);
		}
	});

	it('never reads credentials from the environment', async () => {
		// the explicit arguments exist for this: a token in the environment must not be picked up
		process.env.CLOUDFLARE_API_TOKEN = 'ambient-token-that-must-not-be-used';
		const { fetch, calls } = stub(accepted);
		await publishVersion({ ...BASE, apiToken: 'explicit', fetch });
		delete process.env.CLOUDFLARE_API_TOKEN;
		expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
			'Bearer explicit'
		);
	});
});
