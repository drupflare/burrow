import { PublishError } from './errors.js';
import { API_BASE, buildForm } from './publish.js';

/**
 * Deploying a throwaway Worker, measuring it on the edge, and tearing it down.
 *
 * An in-worker clock reads 0 on the deployed edge, and local-to-edge factors run 2.2x to 6.1x, so a
 * performance claim about a runtime has to come from a deploy.
 *
 * It reports end-to-end latency from the client. CPU time is not readable from here; that needs
 * `wrangler tail` against {@link ProbeResult.scriptName} while the script is up.
 *
 * Teardown runs in a `finally`, so a probe that throws still deletes what it deployed.
 *
 * @since 1.0.0
 */

export interface ProbeOptions {
	/** the Cloudflare account to deploy into; never read from the environment */
	accountId: string;
	/** an API token with Workers Scripts edit permission; never read from the environment */
	apiToken: string;
	/** the module set to deploy, in the same shape {@link publishVersion} takes */
	modules: Record<string, string | Uint8Array>;
	/** which key in `modules` is the entry point */
	mainModule?: string;
	/** the throwaway script name; defaults to a generated one that is obvious in a dashboard */
	scriptName?: string;
	/** how many warm requests to send after the cold one */
	samples?: number;
	/** what to send to the deployed Worker; a bare GET by default */
	request?: { method?: string; body?: string | Uint8Array; headers?: Record<string, string> };
	compatibilityDate?: string;
	compatibilityFlags?: string[];
	/** leave the Worker deployed; off by default, so a failed probe does not accumulate scripts */
	keep?: boolean;
	/** @internal the transport, so the gate can drive this without deploying anything */
	fetch?: typeof globalThis.fetch;
	/** @internal clock, so a spec can assert on timings without waiting for them */
	now?: () => number;
}

export interface ProbeResult {
	/** the script that was deployed, which is what `wrangler tail` needs */
	scriptName: string;
	/** where it was reachable */
	url: string;
	/** the first request, which pays isolate startup */
	coldMs: number;
	/** the median of the warm requests */
	warmMs: number;
	/** every warm sample, in order */
	samples: number[];
	/** the first response body, so a caller can assert the Worker actually ran */
	body: string;
	/** whether the script was deleted again */
	tornDown: boolean;
}

/** prefixed so it is recognisable as disposable in a dashboard */
export function throwawayName(): string {
	return `burrow-probe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** @internal */
export function scriptUrl(accountId: string, scriptName: string): string {
	return `${API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`;
}

/** @internal */
export function subdomainUrl(accountId: string, scriptName: string): string {
	return `${scriptUrl(accountId, scriptName)}/subdomain`;
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] as number;
}

/** @internal reads Cloudflare's envelope and throws with its error list rather than a bare status */
async function expectOk(response: Response, what: string): Promise<Record<string, unknown>> {
	let envelope: {
		success?: boolean;
		errors?: { message?: string }[];
		result?: Record<string, unknown>;
	} = {};
	try {
		envelope = await response.json();
	} catch {
		// a non-JSON body is the diagnosis
	}
	const errors = (envelope.errors ?? []).map((e) => e.message ?? 'unknown error');
	if (!response.ok || envelope.success === false) {
		throw new PublishError(
			`${what} failed with ${response.status}` +
				(errors.length ? `: ${errors.join('; ')}` : ''),
			'burrow.publish.rejected',
			{ status: response.status, errors }
		);
	}
	return envelope.result ?? {};
}

/**
 * Deploys, measures and deletes.
 *
 * @throws {PublishError} when the upload, the subdomain enable or the delete is refused
 * @example
 * ```ts
 * const result = await probe({
 * 	accountId,
 * 	apiToken,
 * 	modules: { 'index.js': worker, 'runtime.wasm': bytes }
 * });
 * console.log(result.coldMs, result.warmMs, result.tornDown);
 * ```
 * @since 1.0.0
 */
export async function probe(options: ProbeOptions): Promise<ProbeResult> {
	const send = options.fetch ?? globalThis.fetch;
	const clock = options.now ?? (() => Date.now());
	const scriptName = options.scriptName ?? throwawayName();
	const samples = options.samples ?? 5;

	try {
		await expectOk(
			await send(scriptUrl(options.accountId, scriptName), {
				method: 'PUT',
				headers: { authorization: `Bearer ${options.apiToken}` },
				body: buildForm({
					accountId: options.accountId,
					apiToken: options.apiToken,
					scriptName,
					modules: options.modules,
					...(options.mainModule ? { mainModule: options.mainModule } : {}),
					...(options.compatibilityDate
						? { compatibilityDate: options.compatibilityDate }
						: {}),
					...(options.compatibilityFlags
						? { compatibilityFlags: options.compatibilityFlags }
						: {})
				})
			}),
			`deploying ${scriptName}`
		);

		const subdomain = await expectOk(
			await send(subdomainUrl(options.accountId, scriptName), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${options.apiToken}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ enabled: true })
			}),
			`exposing ${scriptName}`
		);

		const host =
			typeof subdomain.subdomain === 'string'
				? `${scriptName}.${subdomain.subdomain}.workers.dev`
				: `${scriptName}.workers.dev`;
		const url = `https://${host}/`;

		const hit = async (): Promise<[number, string]> => {
			const started = clock();
			const response = await send(url, {
				method: options.request?.method ?? 'GET',
				...(options.request?.headers ? { headers: options.request.headers } : {}),
				...(options.request?.body ? { body: options.request.body } : {})
			});
			const text = await response.text();
			return [clock() - started, text];
		};

		// the first request pays isolate startup, so it is reported apart rather than averaged in
		const [coldMs, body] = await hit();
		const warm: number[] = [];
		for (let i = 0; i < samples; i++) warm.push((await hit())[0]);

		return {
			scriptName,
			url,
			coldMs,
			warmMs: median(warm),
			samples: warm,
			body,
			tornDown: false
		};
	} finally {
		if (!options.keep) {
			// runs even on a throw, so a failed probe does not leave the script deployed
			await send(`${scriptUrl(options.accountId, scriptName)}?force=true`, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${options.apiToken}` }
			});
		}
	}
}

/**
 * Deploys, measures, tears down, then checks the script is gone and reports it in `tornDown`.
 *
 * {@link probe} always answers `false` there, because its delete runs in a `finally` after the
 * result is built.
 *
 * @since 1.0.0
 */
export async function probeAndVerify(options: ProbeOptions): Promise<ProbeResult> {
	const send = options.fetch ?? globalThis.fetch;
	const scriptName = options.scriptName ?? throwawayName();
	const result = await probe({ ...options, scriptName });

	if (options.keep) return result;
	const check = await send(scriptUrl(options.accountId, scriptName), {
		headers: { authorization: `Bearer ${options.apiToken}` }
	});
	return { ...result, tornDown: check.status === 404 };
}
