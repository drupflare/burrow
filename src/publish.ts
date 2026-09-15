import { PublishError } from './errors.js';

/**
 * Uploading generated WebAssembly as a Worker version, so it runs at native speed.
 *
 * This is the one part of burrow that changes infrastructure, and the surface is shaped to make that
 * obvious. It takes an explicit `accountId` and `apiToken` rather than reading ambient credentials,
 * it never looks at the environment on its own, and it creates a **version** rather than a
 * deployment, so production traffic is untouched by construction.
 *
 * Promoting a version to production is not exposed at all. That is `wrangler versions deploy`, and
 * it stays outside this package.
 *
 * Each call accumulates a version on the account, so `versionId` comes back for callers that prune.
 * It also takes several hundred milliseconds, which is why it belongs on `waitUntil` and never on
 * the response path.
 *
 * @since 1.0.0
 */

/** The API base every request here is built against. */
export const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface PublishOptions {
	/** the Cloudflare account that owns the script; never read from the environment */
	accountId: string;
	/** an API token with Workers Scripts edit permission; never read from the environment */
	apiToken: string;
	/** the Worker script the new version belongs to; it must already exist */
	scriptName: string;
	/**
	 * The module set, keyed by the name the entry imports.
	 *
	 * A `string` is JavaScript, a `Uint8Array` is wasm. Nothing is compiled locally; Cloudflare
	 * compiles at upload, so the uploaded version runs at native speed.
	 */
	modules: Record<string, string | Uint8Array>;
	/** which key in `modules` is the entry point */
	mainModule?: string;
	/** a note recorded against the version, so one is identifiable in the dashboard */
	message?: string;
	/** compatibility date for the new version */
	compatibilityDate?: string;
	/** compatibility flags for the new version */
	compatibilityFlags?: string[];
	/**
	 * The transport. Defaults to the global `fetch`.
	 *
	 * @internal exists so the gate can drive this over a stub rather than opening a connection
	 */
	fetch?: typeof globalThis.fetch;
}

export interface PublishResult {
	/** the new version, which is what a caller prunes with */
	versionId: string;
	/** a URL that executes this version without deploying it, when the account exposes one */
	previewUrl: string | null;
	/** the number the API assigned, when it gave one */
	number: number | null;
}

/** @internal the shape Cloudflare answers with, narrowed to what is read */
interface ApiEnvelope {
	success?: boolean;
	errors?: { message?: string; code?: number }[];
	result?: { id?: string; number?: number; preview_url?: string; metadata?: unknown };
}

/** JavaScript unless the value is bytes; nothing else is uploaded today */
function contentTypeFor(name: string, value: string | Uint8Array): string {
	if (value instanceof Uint8Array) return 'application/wasm';
	return name.endsWith('.json') ? 'application/json' : 'application/javascript+module';
}

/**
 * Builds the multipart body the versions API expects.
 *
 * @internal exported so the gate can assert the body shape without a network call
 */
export function buildForm(options: PublishOptions): FormData {
	const names = Object.keys(options.modules);
	if (!names.length) {
		throw new PublishError('a version needs at least one module', 'burrow.publish.rejected');
	}
	const main = options.mainModule ?? names[0];
	if (main === undefined || !(main in options.modules)) {
		throw new PublishError(
			`mainModule ${JSON.stringify(main)} is not one of ${names.join(', ')}`,
			'burrow.publish.rejected'
		);
	}

	const form = new FormData();
	for (const [name, value] of Object.entries(options.modules)) {
		const body = typeof value === 'string' ? value : new Uint8Array(value).slice();
		form.append(name, new Blob([body], { type: contentTypeFor(name, value) }), name);
	}

	const metadata: Record<string, unknown> = { main_module: main };
	if (options.compatibilityDate) metadata.compatibility_date = options.compatibilityDate;
	if (options.compatibilityFlags) metadata.compatibility_flags = options.compatibilityFlags;
	if (options.message) metadata.annotations = { 'workers/message': options.message };

	form.append(
		'metadata',
		new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
		'metadata.json'
	);
	return form;
}

/** @internal the endpoint a version upload goes to */
export function versionsUrl(accountId: string, scriptName: string): string {
	return `${API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/versions`;
}

/**
 * Uploads a new version of an existing Worker script.
 *
 * Production keeps serving whatever it was serving. The returned `previewUrl`, where the account
 * exposes one, executes the new version at native speed.
 *
 * @throws {PublishError} `burrow.publish.unreachable` when the request never completed,
 *   `burrow.publish.rejected` when the API refused it, carrying `status` and Cloudflare's `errors`
 * @example
 * ```ts
 * ctx.waitUntil(
 * 	publishVersion({
 * 		accountId,
 * 		apiToken,
 * 		scriptName: 'executor',
 * 		modules: { 'index.js': entry, 'program.wasm': generated }
 * 	})
 * );
 * ```
 * @since 1.0.0
 */
export async function publishVersion(options: PublishOptions): Promise<PublishResult> {
	const form = buildForm(options);
	const send = options.fetch ?? globalThis.fetch;

	let response: Response;
	try {
		response = await send(versionsUrl(options.accountId, options.scriptName), {
			method: 'POST',
			// no content-type: the boundary has to come from FormData itself
			headers: { authorization: `Bearer ${options.apiToken}` },
			body: form
		});
	} catch (cause) {
		throw new PublishError(
			`could not reach the Cloudflare API: ${String(cause)}`,
			'burrow.publish.unreachable',
			{ cause }
		);
	}

	let envelope: ApiEnvelope = {};
	try {
		envelope = (await response.json()) as ApiEnvelope;
	} catch {
		// a non-JSON body is itself the diagnosis, so the status carries the error
	}

	const errors = (envelope.errors ?? []).map((e) => e.message ?? 'unknown error');
	if (!response.ok || envelope.success === false) {
		throw new PublishError(
			`uploading a version of ${options.scriptName} failed with ${response.status}` +
				(errors.length ? `: ${errors.join('; ')}` : ''),
			'burrow.publish.rejected',
			{ status: response.status, errors }
		);
	}

	const id = envelope.result?.id;
	if (!id) {
		throw new PublishError(
			'the API accepted the upload but answered no version id',
			'burrow.publish.rejected',
			{ status: response.status, errors }
		);
	}

	return {
		versionId: id,
		previewUrl: envelope.result?.preview_url ?? null,
		number: envelope.result?.number ?? null
	};
}
