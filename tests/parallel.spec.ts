import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ParallelError } from '../src/errors.js';
import { LanePool, type LanePoolOptions, type LaneResult } from '../src/parallel.js';
import { decodeFrame, encodeFrame, encodeRecord, readRecords } from '../src/parallel/frame.js';
import { makeLaneResult } from '../src/parallel/result.js';
import { laneTransport } from '../src/parallel/scheduler.js';
import { syncCall } from '../src/parallel/sync.js';
import { DATA, IMPURE, RANGE, RANGE_TOTAL } from './fixtures/guests.js';

let pools = 0;
function pool(options: LanePoolOptions = {}, ns = env.BURROW_LANES): LanePool {
	return new LanePool(ns, {
		name: `p${++pools}`,
		size: 2,
		spares: 2,
		coordinator: false,
		...options
	});
}

async function failure(
	p: PromiseLike<unknown>,
	code: ParallelError['code']
): Promise<ParallelError> {
	const e = await Promise.resolve(p).then(
		() => null,
		(e: unknown) => e
	);
	expect(e).toBeInstanceOf(ParallelError);
	expect((e as ParallelError).code).toBe(code);
	return e as ParallelError;
}

/** [start, end) pairs covering [0, 4096), as the `part` export reads them */
function ranges(n: number): Uint8Array[] {
	return Array.from({ length: n }, (_, i) => {
		const pair = new Int32Array([(i * 4096) / n, ((i + 1) * 4096) / n]);
		return new Uint8Array(pair.buffer);
	});
}

function fnv(bytes: Uint8Array): number {
	let h = 0x811c9dc5;
	for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
	return h >>> 0;
}

const sum = (acc: number, r: LaneResult) => (acc + r.number()) >>> 0;
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) & 0xff);

describe('frames', () => {
	it('round-trip a descriptor and a payload', () => {
		const frame = decodeFrame<{ a: number }>(encodeFrame({ a: 1 }, bytesOf(9)));
		expect(frame.desc).toEqual({ a: 1 });
		expect(frame.payload).toEqual(bytesOf(9));
		expect(decodeFrame(encodeFrame('x')).payload.length).toBe(0);
	});

	it('refuse bytes that are not a frame', async () => {
		await failure(
			Promise.reject(tryDecode(new Uint8Array(2))),
			'burrow.parallel.frame_malformed'
		);
		const overlong = encodeFrame({ a: 1 }).slice(0, 6);
		await failure(Promise.reject(tryDecode(overlong)), 'burrow.parallel.frame_malformed');
		const notJson = new Uint8Array([1, 0, 0, 0, 0x7b]);
		await failure(Promise.reject(tryDecode(notJson)), 'burrow.parallel.frame_malformed');
	});

	it('read back from a stream however it is chunked', async () => {
		const wire = new Uint8Array([
			...encodeRecord(encodeFrame({ i: 0 }, bytesOf(5))),
			...encodeRecord(encodeFrame({ i: 1 }))
		]);
		const got: number[] = [];
		for await (const r of readRecords<{ i: number }>(chunked(wire, 3))) got.push(r.desc.i);
		expect(got).toEqual([0, 1]);
	});

	it('refuse a stream that ends inside a record', async () => {
		const wire = encodeRecord(encodeFrame({ i: 0 })).slice(0, 7);
		const drain = async () => {
			for await (const _ of readRecords(chunked(wire, 4))) void _;
		};
		await failure(drain(), 'burrow.parallel.frame_malformed');
	});
});

function tryDecode(bytes: Uint8Array): unknown {
	try {
		decodeFrame(bytes);
		return null;
	} catch (e) {
		return e;
	}
}

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream({
		pull(c) {
			if (at >= bytes.length) return c.close();
			c.enqueue(bytes.slice(at, (at += size)));
		}
	});
}

describe('LanePool guest slices', () => {
	it('map answers in input order and sums to the native reference', async () => {
		const results = await pool({ size: 4 }).map(
			{ guest: RANGE, fn: 'part', args: [200] },
			ranges(8)
		);
		expect(results.map((r) => r.sliceId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(results.reduce(sum, 0)).toBe(RANGE_TOTAL);
	});

	it('agrees with and without a coordinator', async () => {
		const work = { guest: RANGE, fn: 'part', args: [200] };
		const local = await pool().reduce(work, ranges(6), sum, 0);
		const coordinated = await pool({ coordinator: true }).reduce(work, ranges(6), sum, 0);
		expect(coordinated).toBe(local);
		expect(coordinated).toBe(RANGE_TOTAL);
	});

	it('calls with arguments alone when there is no input', async () => {
		const r = await pool().spawn({ guest: RANGE, fn: 'range', args: [0, 4096, 200] });
		expect(r.number() >>> 0).toBe(RANGE_TOTAL);
	});

	it('splits a single input across twice the lanes and writes each chunk at alloc', async () => {
		const data = bytesOf(1000);
		const results = await pool({ size: 3 }).map({ guest: DATA, fn: 'fnv', input: data });
		expect(results).toHaveLength(6);
		const chunks = Array.from({ length: 6 }, (_, i) =>
			data.subarray(Math.floor((i * 1000) / 6), Math.floor(((i + 1) * 1000) / 6))
		);
		expect(results.map((r) => r.number())).toEqual(chunks.map(fnv));
	});

	it('uses a caller split as given, empty chunks included', async () => {
		const results = await pool().map({ guest: DATA, fn: 'fnv', input: 'abcdef' }, undefined, {
			split: (d) => [d.subarray(0, 2), d.subarray(2, 2), d.subarray(2)]
		});
		expect(results.map((r) => r.number())).toEqual([
			fnv(new TextEncoder().encode('ab')),
			fnv(new TextEncoder().encode('')),
			fnv(new TextEncoder().encode('cdef'))
		]);
	});

	it('reads a bytes result the guest points at', async () => {
		const [r] = await pool().map({ guest: DATA, fn: 'echo', result: 'bytes' }, ['hello lanes']);
		expect(r!.kind).toBe('bytes');
		expect(r!.text()).toBe('hello lanes');
	});

	it('refuses an input that does not fit the guest', async () => {
		const e = await failure(
			pool({ maxAttempts: 1 }).map({ guest: DATA, fn: 'fnv' }, [bytesOf(200_000)]),
			'burrow.parallel.job_failed'
		);
		expect(e.causes[0]).toContain('does not fit');
	});

	it('refuses a guest with host imports unless it is marked idempotent', async () => {
		const p = pool();
		const e = await failure(
			p.call('p/l0', { guest: IMPURE, fn: 'twice', args: [21] }),
			'burrow.parallel.impure'
		);
		expect(e.slices).toEqual([0]);
		const r = await p.call('p/l0', {
			guest: IMPURE,
			fn: 'twice',
			args: [21],
			idempotent: true
		});
		expect(r.number()).toBe(42);
	});

	it('never retries a permanent refusal', async () => {
		const p = pool({ maxAttempts: 3 });
		await failure(
			p.map({ guest: IMPURE, fn: 'twice', args: [1] }, ['x']),
			'burrow.parallel.job_failed'
		);
		expect(p.lastStats?.retries).toBe(0);
	});
});

describe('LanePool task slices', () => {
	it('decodes what a task returns by its type', async () => {
		const p = pool();
		expect((await p.spawn({ task: 'upper', input: 'abc' })).text()).toBe('ABC');
		expect((await p.spawn({ task: 'sum', input: new Uint8Array([1, 2, 3]) })).number()).toBe(6);
		const described = await p.spawn({ task: 'describe', input: 'abcd' });
		expect(described.json<{ length: number; lane: string }>()).toMatchObject({ length: 4 });
		expect(described.json<{ lane: string }>().lane).toBe(described.lane);
		expect((await p.spawn({ task: 'echo', input: bytesOf(4) })).bytes).toEqual(bytesOf(4));
		expect((await p.spawn({ task: 'nothing' })).json()).toBeNull();
		expect((await p.spawn({ task: 'upper', input: '42' })).number()).toBe(42);
	});

	it('gives a task its lane storage', async () => {
		expect((await pool().spawn({ task: 'store', input: 'kept' })).text()).toBe('kept');
	});

	it('refuses an unknown task without retrying it', async () => {
		const p = pool();
		const e = await failure(p.spawn({ task: 'nope' }), 'burrow.parallel.unknown_task');
		expect(e.message).toContain('nope');
		await failure(p.map({ task: 'nope' }, ['a']), 'burrow.parallel.job_failed');
		expect(p.lastStats?.retries).toBe(0);
	});

	it('retries a failed slice on a spare', async () => {
		const p = pool();
		const [r] = await p.map({ task: 'failOnPrimary' }, ['ok']);
		expect(r!.text()).toBe('ok');
		expect(r!.lane).toMatch(/\/s\d+$/);
		expect(r!.attempts).toBeGreaterThan(1);
		expect(p.lastStats?.retries).toBeGreaterThan(0);
	});

	it('names every slice that failed after its last attempt', async () => {
		const e = await failure(
			pool({ maxAttempts: 2 }).map({ task: 'boom' }, ['a', 'b']),
			'burrow.parallel.job_failed'
		);
		expect(e.slices).toEqual([0, 1]);
		expect(e.causes).toEqual(['boom', 'boom']);
	});

	it('reports a thrown non-error by its text', async () => {
		const e = await failure(
			pool({ maxAttempts: 1 }).spawn({ task: 'throwsString' }),
			'burrow.parallel.slice_failed'
		);
		expect(e.message).toBe('a bare string');
	});

	it('retires a lane whose failure implicates its environment', async () => {
		const p = pool({ maxAttempts: 3, size: 1, spares: 1 });
		const before = p.lanes();
		await failure(p.map({ task: 'oom' }, ['x']), 'burrow.parallel.job_failed');
		expect(p.lanes()).not.toEqual(before);
		expect(p.lanes()[0]).toMatch(/~1$/);
		// with the lane and its only spare both retired, the last attempt still has somewhere to go
		expect(p.lastStats?.requests).toBe(3);
	});

	it('hedges a late slice onto a spare and takes the first answer', async () => {
		const p = pool({ hedgeFloorMs: 20 });
		const results = await p.map({ task: 'slowOnPrimary' }, ['600', '600']);
		for (const r of results) {
			expect(r.text()).toMatch(/\/s\d+$/);
			expect(r.attempts).toBe(2);
		}
		expect(p.lastStats?.hedges).toBe(2);
	});

	it('does not hedge when hedging is off', async () => {
		const p = pool({ hedge: false });
		const [r] = await p.map({ task: 'slowOnPrimary' }, ['50']);
		expect(r!.text()).toMatch(/\/l\d+$/);
		expect(p.lastStats?.hedges).toBe(0);
	});

	it('commits captured effects exactly once per slice, hedged or not', async () => {
		const commits: Array<{ sliceId: number; by: string }> = [];
		const p = pool({
			size: 4,
			hedgeFloorMs: 10,
			commit: (effects, { sliceId }) => {
				for (const e of effects) commits.push({ sliceId, by: (e as { by: string }).by });
			}
		});
		const results = await p.map({ task: 'effect', effects: 'capture' }, ['a', 'b', 'c', 'd']);
		expect(commits.map((c) => c.sliceId).sort()).toEqual([0, 1, 2, 3]);
		for (const r of results) {
			expect(commits.find((c) => c.sliceId === r.sliceId)?.by).toBe(r.lane);
			expect(r.effects).toHaveLength(1);
		}
		await new Promise((r) => setTimeout(r, 200));
		expect(commits).toHaveLength(4);
	});

	it('reports commit time and the rows commit says it wrote', async () => {
		const p = pool({ commit: () => 3 });
		await p.map({ task: 'effect', effects: 'capture' }, ['a', 'b']);
		expect(p.lastStats).toMatchObject({ commits: 2, rowsWritten: 6, publishMs: 0 });
		expect(p.lastStats?.commitMs).toBeGreaterThanOrEqual(0);
	});

	it.each([false, true])(
		'stops at a failed commit and names what was committed (coordinator %s)',
		async (coordinator) => {
			const applied: number[] = [];
			const p = pool({
				coordinator,
				hedge: false,
				size: 1,
				commit: (_effects, { sliceId }) => {
					if (applied.length === 2) throw new Error('database down');
					applied.push(sliceId);
				}
			});
			const e = await failure(
				p.map({ task: 'effect', effects: 'capture' }, ['a', 'b', 'c', 'd', 'e']),
				'burrow.parallel.commit_failed'
			);
			expect(e.committed).toEqual(applied);
			expect(e.slices).toHaveLength(1);
			expect(e.causes).toEqual(['database down']);
			await pause(300);
			expect(applied).toHaveLength(2);
		}
	);

	it('refuses an effect from a slice that did not ask to capture', async () => {
		await failure(pool().spawn({ task: 'effect', input: 'x' }), 'burrow.parallel.impure');
	});

	it('runs a static schedule to the same answer', async () => {
		const results = await pool({ schedule: 'static', size: 3 }).map({ task: 'upper' }, [
			'a',
			'b',
			'c',
			'd',
			'e'
		]);
		expect(results.map((r) => r.text())).toEqual(['A', 'B', 'C', 'D', 'E']);
	});

	it('counts a lane that never answers as stalled', async () => {
		const e = await failure(
			pool({ stallMs: 50, maxAttempts: 1, hedge: false }).map({ task: 'sleep' }, ['400']),
			'burrow.parallel.job_failed'
		);
		expect(e.causes[0]).toContain('no answer');
	});

	it('stops a job when its signal aborts', async () => {
		const e = await failure(
			pool({ hedge: false }).map({ task: 'sleep' }, ['300', '300', '300'], {
				signal: AbortSignal.timeout(40)
			}),
			'burrow.parallel.job_failed'
		);
		expect(e.causes).toContain('the job was cancelled');
	});

	it('stops a coordinated job when its signal aborts', async () => {
		const e = await failure(
			pool({ coordinator: true, hedge: false }).map(
				{ task: 'sleep' },
				['300', '300', '300'],
				{
					signal: AbortSignal.timeout(40)
				}
			),
			'burrow.parallel.job_failed'
		);
		expect(e.causes).toContain('the job was cancelled');
	});

	it('yields results as they finish, then reports failures', async () => {
		const seen: string[] = [];
		const drain = async () => {
			for await (const r of pool({ maxAttempts: 1 }).mapUnordered({ task: 'upper' }, [
				'a',
				'b'
			]))
				seen.push(r.text());
		};
		await drain();
		expect(seen.sort()).toEqual(['A', 'B']);

		const partial: number[] = [];
		const failing = async () => {
			for await (const r of pool({ maxAttempts: 1 }).mapUnordered({ task: 'failOnPrimary' }, [
				'a'
			]))
				partial.push(r.sliceId);
		};
		await failure(failing(), 'burrow.parallel.job_failed');
	});

	it('surfaces a coordinator that cannot reach its lanes', async () => {
		const p = pool({ coordinator: true, binding: 'NOT_BOUND' });
		await failure(p.map({ task: 'upper' }, ['a']), 'burrow.parallel.job_failed');
		const drain = async () => {
			for await (const _ of p.mapUnordered({ task: 'upper' }, ['a'])) void _;
		};
		await failure(drain(), 'burrow.parallel.job_failed');
	});

	it('streams failures back from a coordinator', async () => {
		const e = await failure(
			pool({ coordinator: true, maxAttempts: 1 }).map({ task: 'boom' }, ['a']),
			'burrow.parallel.job_failed'
		);
		expect(e.causes).toEqual(['boom']);
	});

	it('streams retirements back from a coordinator', async () => {
		const p = pool({ coordinator: true, maxAttempts: 1, size: 1 });
		const before = p.lanes();
		await failure(p.map({ task: 'oom' }, ['x']), 'burrow.parallel.job_failed');
		expect(p.lanes()).not.toEqual(before);
	});
});

describe('LanePool runtime slices', () => {
	it('instantiates a fresh runtime for every slice', async () => {
		const results = await pool().map({ runtime: 'counter' }, ['a', 'b', 'c']);
		expect(results.map((r) => r.text())).toEqual(['1:a\n', '1:b\n', '1:c\n']);
		expect(results[0]!.run?.exitCode).toBe(0);
		expect(results[0]!.run?.stdoutText).toBe('1:a\n');
	});

	it('evaluates one source for every input when a source is given', async () => {
		const results = await pool().map({ runtime: 'counter', source: 's' }, ['x', 'y']);
		expect(results.map((r) => r.text())).toEqual(['1:s\n', '1:s\n']);
	});

	it('keeps a sticky session on one lane between slices', async () => {
		const p = pool({ size: 4 });
		const texts: string[] = [];
		const lanes = new Set<string>();
		for (let i = 0; i < 3; i++) {
			const r = await p.spawn({ runtime: 'counter', source: 'x', affinity: 'user-7' });
			texts.push(r.text());
			lanes.add(r.lane);
		}
		expect(texts).toEqual(['1:x\n', '2:x\n', '3:x\n']);
		expect(lanes.size).toBe(1);
		const health = await p.health();
		expect(health.lanes.find((l) => l.lane === [...lanes][0])?.tags['warm:counter']).toBe(true);
	});

	it('answers a non-zero exit as a result, not a failure', async () => {
		const r = await pool().spawn({ runtime: 'counter', source: 'fail' });
		expect(r.run?.exitCode).toBe(1);
	});

	it('refuses a runtime the lane does not declare', async () => {
		await failure(
			pool().spawn({ runtime: 'ruby', source: 'x' }),
			'burrow.parallel.unknown_task'
		);
	});

	it('fails a sticky slice in place rather than moving it', async () => {
		const p = pool({ maxAttempts: 3 });
		await failure(
			p.spawn({
				runtime: 'counter',
				source: 'x',
				affinity: 'k',
				requires: { generation: 99 }
			}),
			'burrow.parallel.sticky_failed'
		);
		expect(p.lastStats?.retries).toBe(0);
	});
});

describe('LanePool lane state', () => {
	it('fails fast on a lane that lacks the required state, then serves once prepared', async () => {
		const p = pool({ maxAttempts: 1 });
		const e = await failure(
			p.map({ task: 'upper', requires: { generation: 7 } }, ['a']),
			'burrow.parallel.job_failed'
		);
		expect(e.causes[0]).toContain('requires');
		await p.prepare({ generation: 7 });
		await p.prepare({ generation: 7 });
		const [r] = await p.map({ task: 'upper', requires: { generation: 7 } }, ['a']);
		expect(r!.text()).toBe('A');
		const health = await p.health();
		expect(health.lanes.every((l) => l.tags.generation === 7)).toBe(true);
	});

	it('prepares the spares too, so a stateful slice can still be hedged', async () => {
		const p = pool({ hedgeFloorMs: 20 });
		await p.prepare({ generation: 8 });
		const [r] = await p.map({ task: 'slowOnPrimary', requires: { generation: 8 } }, ['600']);
		expect(r!.text()).toMatch(/\/s\d+$/);
		expect(p.lastStats?.retries).toBe(0);
	});

	it('retires a sticky session when prepare changes the lane state', async () => {
		const p = pool({ size: 1 });
		await p.prepare({ generation: 7 });
		const sticky = (generation: number) =>
			p.spawn({ runtime: 'counter', source: 'x', affinity: 'k', requires: { generation } });
		expect((await sticky(7)).text()).toBe('1:x\n');
		expect((await sticky(7)).text()).toBe('2:x\n');
		await p.prepare({ generation: 8 });
		expect((await sticky(8)).text()).toBe('1:x\n');
	});

	it('reads the lane state from storage, not from a copy an isolate kept', async () => {
		const p = pool();
		await p.prepare({ generation: 5 });
		await p.call(p.lanes()[0]!, { task: 'setTags', input: '{"generation":6}' });
		const r = await p.call(p.lanes()[0]!, {
			task: 'upper',
			input: 'a',
			requires: { generation: 6 }
		});
		expect(r.text()).toBe('A');
	});

	it('reports lanes whose prepare hook failed', async () => {
		const e = await failure(pool().prepare({ generation: 13 }), 'burrow.parallel.stale_state');
		expect(e.causes).toHaveLength(4);
		expect(e.message).toContain('unreachable');
	});

	it('refuses to prepare a lane with no hook', async () => {
		await failure(
			pool({}, env.BARE_LANES).prepare({ generation: 1 }),
			'burrow.parallel.stale_state'
		);
	});
});

describe('LanePool build', () => {
	it('stages every slice and publishes once', async () => {
		const staged: number[] = [];
		let published = 0;
		const { results, stats } = await pool().build({ task: 'upper' }, ['a', 'b', 'c'], {
			stage: (r, { jobId, sliceId }) => {
				expect(jobId).not.toBe('');
				staged.push(sliceId);
				expect(r.sliceId).toBe(sliceId);
			},
			validate: (r) => r.text().length === 1,
			publish: () => void published++
		});
		expect(staged.sort()).toEqual([0, 1, 2]);
		expect(published).toBe(1);
		expect(results.map((r) => r.text())).toEqual(['A', 'B', 'C']);
		expect(stats.requests).toBeGreaterThanOrEqual(3);
		expect(stats.publishMs).toBeGreaterThanOrEqual(0);
	});

	it('withholds the publish when a slice fails validation', async () => {
		let published = 0;
		const e = await failure(
			pool().build({ task: 'upper' }, ['a', 'bb', 'c'], {
				stage: () => {},
				validate: (r) => r.text().length === 1,
				publish: () => void published++
			}),
			'burrow.parallel.build_incomplete'
		);
		expect(e.slices).toEqual([1]);
		expect(published).toBe(0);
	});

	it('withholds the publish when a slice fails outright', async () => {
		let published = 0;
		const e = await failure(
			pool({ maxAttempts: 1 }).build({ task: 'boom' }, ['a', 'b'], {
				stage: () => {},
				publish: () => void published++
			}),
			'burrow.parallel.build_incomplete'
		);
		expect(e.slices).toEqual([0, 1]);
		expect(published).toBe(0);
	});

	it('fails the job when a stage step throws', async () => {
		await expect(
			pool().build({ task: 'upper' }, ['a'], {
				stage: () => {
					throw new Error('stage broke');
				},
				publish: () => {}
			})
		).rejects.toThrow('stage broke');
	});
});

describe('LaneTask and LaneScope', () => {
	it('compose with the Promise combinators', async () => {
		const p = pool();
		const [a, b] = await Promise.all([
			p.spawn({ task: 'upper', input: 'a' }),
			p.spawn({ task: 'upper', input: 'b' })
		]);
		expect([a.text(), b.text()]).toEqual(['A', 'B']);
		const first = await Promise.any([
			p.spawn({ task: 'boom' }),
			p.spawn({ task: 'upper', input: 'c' })
		]);
		expect(first.text()).toBe('C');
		const task = p.spawn({ task: 'upper', input: 'd' });
		expect(task.sliceId).toBe(0);
		expect((await task.join()).text()).toBe('D');
		let settled = false;
		await task.finally(() => (settled = true));
		expect(settled).toBe(true);
		const caught = await p
			.spawn({ task: 'nope' })
			.catch((e: unknown) => (e as ParallelError).code);
		expect(caught).toBe('burrow.parallel.unknown_task');
	});

	it('cancels what is still running when the scope ends', async () => {
		const p = pool({ hedge: false });
		let slow: Promise<unknown> | undefined;
		{
			await using scope = p.scope();
			const quick = scope.spawn({ task: 'upper', input: 'q' });
			slow = scope.spawn({ task: 'sleep', input: '300' }).join();
			expect((await quick).text()).toBe('Q');
		}
		await failure(slow!, 'burrow.parallel.cancelled');
	});

	it('honours a caller signal inside a scope', async () => {
		await using scope = pool({ hedge: false }).scope();
		const controller = new AbortController();
		const task = scope.spawn({ task: 'sleep', input: '300' }, { signal: controller.signal });
		controller.abort();
		await failure(task, 'burrow.parallel.cancelled');
	});
});

describe('LanePool raw access and health', () => {
	it('calls one lane directly and surfaces its failure code', async () => {
		const p = pool();
		const r = await p.call('raw/l0', { task: 'upper', input: 'raw' });
		expect([r.text(), r.lane, r.attempts]).toEqual(['RAW', 'raw/l0', 1]);
		await failure(p.call('raw/l0', { task: 'boom' }), 'burrow.parallel.slice_failed');
	});

	it('reports a lane with no interpreter or runtimes as unable to run them', async () => {
		const bare = pool({}, env.BARE_LANES);
		await failure(
			bare.call('bare/l0', { guest: RANGE, fn: 'range', args: [0, 1, 1] }),
			'burrow.parallel.slice_failed'
		);
		await failure(bare.call('bare/l0', { task: 'upper' }), 'burrow.parallel.unknown_task');
		await failure(
			bare.call('bare/l0', { runtime: 'counter', source: 'x' }),
			'burrow.parallel.unknown_task'
		);
	});

	it('finds lanes that share an isolate and repairs them', async () => {
		const p = pool({ name: 'cohab', size: 3 });
		const before = await p.health();
		expect(before.isolates).toBe(1);
		expect(before.coResident).toEqual([['cohab/l0', 'cohab/l1', 'cohab/l2']]);
		const after = await p.repair();
		expect(after.isolates).toBe(3);
		expect(after.coResident).toEqual([]);
		expect(p.lanes()[0]).toBe('cohab/l0');
	});

	it('refuses a pool with no lanes', () => {
		expect(() => new LanePool(env.BURROW_LANES, { size: 0 })).toThrow(ParallelError);
	});

	it('answers 404 for an operation a lane does not know', async () => {
		const stub = env.BURROW_LANES.get(env.BURROW_LANES.idFromName('op'));
		const res = await stub.fetch('https://lane/nope', { method: 'POST' });
		expect(res.status).toBe(404);
		expect(await res.text()).toContain('nope');
	});

	it('streams a coordinator failure back as an error record', async () => {
		const stub = env.BURROW_LANES.get(env.BURROW_LANES.idFromName('coord'));
		const job = { jobId: 'j', binding: 'BURROW_LANES', lanes: [], spares: [], slices: [] };
		const res = await stub.fetch('https://lane/coordinate', {
			method: 'POST',
			body: encodeFrame(job)
		});
		const events: Array<{ event: string; message?: string }> = [];
		for await (const r of readRecords<{ event: string; message?: string }>(res.body!))
			events.push(r.desc);
		expect(events).toHaveLength(1);
		expect(events[0]!.event).toBe('error');
		expect(events[0]!.message).toContain('no lanes');
	});

	it('fills what a lane left out of its answer with neutral values', () => {
		const meta = { sliceId: 0, lane: 'l', attempts: 1 };
		const run = makeLaneResult(
			{ ok: true, kind: 'run', iso: '', tags: {} },
			new Uint8Array(0),
			meta
		);
		expect(run.run?.exitCode).toBe(0);
		expect(run.run?.stderr.length).toBe(0);
		expect(run.effects).toEqual([]);
		const bare = makeLaneResult(
			{ ok: true, kind: 'number', iso: '', tags: {} },
			new Uint8Array(0),
			meta
		);
		expect(bare.number()).toBe(0);
	});
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** whether `p` is still pending after `ms` */
async function pending(p: Promise<unknown>, ms = 60): Promise<boolean> {
	const timer = Symbol('timer');
	return (
		(await Promise.race([
			p.then(
				() => null,
				() => null
			),
			pause(ms).then(() => timer)
		])) === timer
	);
}

describe('LaneAtomic', () => {
	it('mirrors the Atomics operations', async () => {
		const a = pool().atomic('n');
		expect(await a.load()).toBe(0);
		expect(await a.store(5)).toBe(5);
		expect(await a.add(2)).toBe(5);
		expect(await a.load()).toBe(7);
		expect(await a.compareExchange(7, 10)).toBe(7);
		expect(await a.compareExchange(1, 99)).toBe(10);
		expect(await a.load()).toBe(10);
	});

	it('applies each op of a slice once, however often the slice runs', async () => {
		const p = pool({ size: 4, hedgeFloorMs: 10 });
		await p.map({ task: 'hit' }, ['a', 'b', 'c', 'd']);
		expect(p.lastStats?.hedges).toBeGreaterThan(0);
		expect(await p.atomic('hits').load()).toBe(4);
	});

	it('numbers ops across every handle a slice opens', async () => {
		const p = pool();
		await p.map({ task: 'hitTwice' }, ['a', 'b', 'c']);
		expect(await p.atomic('twice').load()).toBe(6);
	});

	it('refuses an action it does not know', async () => {
		const t = laneTransport(env.BURROW_LANES);
		await failure(
			syncCall(t, 'bad/atomic', { kind: 'atomic', action: 'swap' }),
			'burrow.parallel.frame_malformed'
		);
		await failure(
			syncCall(t, 'bad/lock', { kind: 'lock', action: 'steal' }),
			'burrow.parallel.frame_malformed'
		);
	});
});

describe('LaneMutex', () => {
	it('grants in turn, with a larger token each time', async () => {
		const m = pool().mutex('m');
		const first = await m.acquire();
		const second = m.acquire();
		expect(await pending(second)).toBe(true);
		await first.release();
		const lease = await second;
		expect(lease.token).toBeGreaterThan(first.token);
		expect(lease.expires).toBeGreaterThan(Date.now());
		await lease.release();
	});

	it('keeps protected state inside the lock', async () => {
		const m = pool().mutex('m');
		{
			await using lease = await m.acquire();
			expect(await lease.read('n')).toBeUndefined();
			await lease.write('n', { v: 1 });
		}
		await using again = await m.acquire();
		expect(await again.read('n')).toEqual({ v: 1 });
	});

	it('takes the lock from a holder whose lease lapsed and refuses its writes', async () => {
		const m = pool().mutex('m');
		const dead = await m.acquire({ ttlMs: 80 });
		const next = await m.acquire({ timeoutMs: 2000 });
		expect(next.token).toBeGreaterThan(dead.token);
		await failure(dead.write('n', 'stale'), 'burrow.parallel.lock_lost');
		await failure(dead.read('n'), 'burrow.parallel.lock_lost');
		await failure(dead.release(), 'burrow.parallel.lock_lost');
		await dead[Symbol.asyncDispose]();
		await next.release();
	});

	it('gives up after its timeout', async () => {
		const m = pool().mutex('m');
		const held = await m.acquire();
		await failure(m.acquire({ timeoutMs: 50 }), 'burrow.parallel.lock_timeout');
		const signal = new AbortController().signal;
		await failure(m.acquire({ timeoutMs: 50, signal }), 'burrow.parallel.lock_timeout');
		await held.release();
	});

	it('hands back a grant that lands after the caller gave up', async () => {
		const m = pool().mutex('m');
		const held = await m.acquire();
		const controller = new AbortController();
		const waiting = m.acquire({ signal: controller.signal });
		controller.abort();
		await failure(waiting, 'burrow.parallel.cancelled');
		await held.release();
		await pause(50);
		expect(await pending(m.acquire({ timeoutMs: 1000 }), 300)).toBe(false);
		await failure(m.acquire({ signal: AbortSignal.abort() }), 'burrow.parallel.cancelled');
	});

	it('resolves normally when a signal never fires', async () => {
		const lease = await pool().mutex('m').acquire({ signal: new AbortController().signal });
		await lease.release();
	});

	it('serialises critical sections run from lanes', async () => {
		const p = pool({ size: 3, hedge: false });
		const results = await p.map({ task: 'locked' }, ['a', 'b', 'c', 'd', 'e', 'f']);
		expect(results.map((r) => r.number()).sort()).toEqual([0, 1, 2, 3, 4, 5]);
		await using lease = await p.mutex('ledger').acquire();
		expect(await lease.read('n')).toBe(6);
	});
});

describe('LaneChannel', () => {
	it('carries text and JSON, then ends once closed', async () => {
		const ch = pool().channel('c');
		await ch.send('a');
		await ch.sendJson({ b: 1 });
		expect((await ch.receive())?.text()).toBe('a');
		expect((await ch.receive())?.json()).toEqual({ b: 1 });
		await ch.close();
		expect(await ch.receive()).toBeNull();
		expect(await ch.size()).toEqual({ buffered: 0, closed: true });
		await failure(ch.send('late'), 'burrow.parallel.channel_closed');
	});

	it('iterates in order', async () => {
		const ch = pool().channel('c');
		for (let i = 0; i < 5; i++) await ch.send(String(i));
		await ch.close();
		const got: string[] = [];
		for await (const m of ch) got.push(m.text());
		expect(got).toEqual(['0', '1', '2', '3', '4']);
	});

	it('holds no more than its capacity', async () => {
		const p = pool();
		const ch = p.channel('c', { capacity: 2 });
		const sending = (async () => {
			for (let i = 0; i < 6; i++) await ch.send(String(i));
		})();
		await pause(100);
		expect((await ch.size()).buffered).toBeLessThanOrEqual(2);
		const reader = p.channel('c', { capacity: 2 });
		const got: string[] = [];
		for (let i = 0; i < 6; i++) got.push((await reader.receive())!.text());
		await sending;
		expect(got).toEqual(['0', '1', '2', '3', '4', '5']);
	});

	it('refuses a sender that is still attached when another endpoint closes it', async () => {
		const p = pool();
		const sender = p.channel('c', { capacity: 1 });
		const sending = (async () => {
			for (let i = 0; i < 10_000; i++) await sender.send('x'.repeat(1024));
		})();
		const refused = failure(sending, 'burrow.parallel.channel_closed');
		await pause(100);
		await p.channel('c').close();
		await refused;
	});

	it('flushes a sender before its detach resolves', async () => {
		const ch = pool().channel('c');
		await ch.send('a');
		await ch.send('b');
		await ch.detach();
		expect((await ch.size()).buffered).toBe(2);
		expect((await ch.receive())?.text()).toBe('a');
		await ch.detach();
	});

	it('connects a producer and a consumer running on lanes', async () => {
		await using scope = pool({ size: 2, hedge: false }).scope();
		const pipe = scope.channel('pipe', { capacity: 4 });
		const produced = scope.spawn({
			task: 'produceAndClose',
			input: '10',
			channels: { out: pipe }
		});
		const consumed = scope.spawn({ task: 'consume', channels: { in: pipe } });
		expect((await produced).text()).toBe('closed');
		expect((await consumed).number()).toBe(55);
	});

	it('shares one lane between a consumer and its producer, because waiting yields the slot', async () => {
		await using scope = pool({ size: 1, hedge: false }).scope();
		const pipe = scope.channel('solo', { capacity: 2 });
		const consumed = scope.spawn({ task: 'consume', channels: { in: pipe } });
		const produced = scope.spawn({
			task: 'produceAndClose',
			input: '6',
			channels: { out: pipe }
		});
		await produced;
		expect((await consumed).number()).toBe(21);
		expect((await consumed).lane).toBe((await produced).lane);
	});

	it("delivers a retried producer's messages once", async () => {
		await using scope = pool({ size: 2, hedge: false }).scope();
		const pipe = scope.channel('retry');
		const consumed = scope.spawn({ task: 'consume', channels: { in: pipe } });
		const produced = await scope.spawn({
			task: 'produceThenFail',
			input: '10',
			channels: { out: pipe }
		});
		expect(produced.attempts).toBeGreaterThan(1);
		expect((await consumed).number()).toBe(55);
	});

	it('merges several producers into one consumer', async () => {
		const p = pool({ size: 3, hedge: false });
		const pipe = p.channel(`merge-${crypto.randomUUID()}`);
		const consumed = p.spawn({ task: 'consume', channels: { in: pipe } });
		await Promise.all([
			p.spawn({ task: 'produce', input: '10', channels: { out: pipe } }),
			p.spawn({ task: 'produce', input: '10', channels: { out: pipe } })
		]);
		await pipe.close();
		expect((await consumed).number()).toBe(110);
	});

	it('closes its channels when the scope ends', async () => {
		const p = pool({ hedge: false });
		let pipe: ReturnType<LanePool['channel']> | undefined;
		{
			await using scope = p.scope();
			pipe = scope.channel('idle');
			scope.spawn({ task: 'consume', channels: { in: pipe } });
			await pause(50);
		}
		expect((await pipe!.size()).closed).toBe(true);
	});

	it('refuses a channel the work did not pass', async () => {
		await failure(pool().spawn({ task: 'missingChannel' }), 'burrow.parallel.slice_failed');
	});
});

describe('nested slices', () => {
	it('run a child on the parent lane of a one-lane pool, because the parent yields its slot', async () => {
		const p = pool({ size: 1, hedge: false });
		const r = await p.spawn({ task: 'spawnChild' });
		expect(r.text()).toBe(p.lanes()[0]);
		expect((await p.spawn({ task: 'fanout' })).text()).toBe('ABC');
	});

	it('starve without the yield, which is the control', async () => {
		const p = pool({ size: 1, hedge: false });
		expect((await p.spawn({ task: 'selfCall' })).text()).toContain('no answer');
	});
});

/** a namespace whose every object answers with `respond`, for failures a real lane never produces */
function fakeNamespace(respond: () => Response): DurableObjectNamespace {
	return {
		idFromName: (name: string) => name,
		get: () => ({ fetch: async () => respond() })
	} as unknown as DurableObjectNamespace;
}

describe('LanePool against a broken transport', () => {
	const records = (...events: object[]) =>
		new Response(new Uint8Array(events.flatMap((e) => [...encodeRecord(encodeFrame(e))])));

	it('fails a slice whose lane answers an http error', async () => {
		const p = pool(
			{ maxAttempts: 1 },
			fakeNamespace(() => new Response('down', { status: 500 }))
		);
		const e = await failure(p.map({ task: 'upper' }, ['a']), 'burrow.parallel.job_failed');
		expect(e.causes[0]).toContain('http 500');
		await failure(p.call('x', { task: 'upper' }), 'burrow.parallel.slice_failed');
	});

	it('reports a sync or channel object that fails outright', async () => {
		const down = fakeNamespace(() => new Response('internal error', { status: 500 }));
		await failure(pool({}, down).atomic('a').add(1), 'burrow.parallel.object_failed');
		await failure(pool({}, down).channel('c').close(), 'burrow.parallel.object_failed');
		await failure(pool({}, down).channel('c').size(), 'burrow.parallel.object_failed');
		const refused = fakeNamespace(() =>
			Response.json(
				{ ok: false, code: 'burrow.parallel.object_failed', message: 'quota spent' },
				{ status: 500 }
			)
		);
		const e = await failure(
			pool({}, refused).mutex('m').acquire(),
			'burrow.parallel.object_failed'
		);
		expect(e.message).toBe('quota spent');
	});

	it('surfaces a coordinator that reports its own failure', async () => {
		const ns = fakeNamespace(() => records({ event: 'error', message: 'exploded' }));
		const e = await failure(
			pool({ coordinator: true }, ns).map({ task: 'upper' }, ['a']),
			'burrow.parallel.job_failed'
		);
		expect(e.message).toContain('exploded');
	});

	it('surfaces a coordinator stream that ends before the job does', async () => {
		const ns = fakeNamespace(() => records());
		const e = await failure(
			pool({ coordinator: true }, ns).map({ task: 'upper' }, ['a']),
			'burrow.parallel.job_failed'
		);
		expect(e.message).toContain('ended before');
	});
});
