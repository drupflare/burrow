import { memoryFS } from '../../src/adapt.js';
import { defineLane, LanePool } from '../../src/parallel.js';
import { defineRuntime } from '../../src/runtime.js';
import { fromBytes } from '../../src/session.js';
import wasm3 from '../../src/vendor/wasm3.wasm';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const primary = (lane: string) => /\/l\d+/.test(lane);

/** prints how many times this instance has run, so a test can tell fresh from sticky */
const counter = defineRuntime({
	name: 'counter',
	load: async () => ({}),
	instantiate: ({ io }) => {
		let runs = 0;
		const FS = memoryFS();
		return {
			FS,
			callMain: (argv) => {
				const source = fromBytes(FS.readFile(argv[argv.length - 1]!) as Uint8Array);
				if (source === 'fail') return 1;
				io.print(`${++runs}:${source}`);
				return 0;
			}
		};
	},
	memory: { peak: 1024 * 1024 }
});

export const TestLane = defineLane({
	interpreter: wasm3,
	guestImports: { host: { double: { signature: 'i(i)', fn: (x) => x * 2 } } },
	runtimes: [counter],
	tasks: {
		echo: (input) => input,
		upper: (input) => fromBytes(input).toUpperCase(),
		sum: (input) => input.reduce((a, b) => a + b, 0),
		describe: (input, ctx) => ({ length: input.length, lane: ctx.lane }),
		nothing: () => undefined,
		slowOnPrimary: async (input, ctx) => {
			if (primary(ctx.lane)) await sleep(Number(fromBytes(input)) || 400);
			return ctx.lane;
		},
		failOnPrimary: (input, ctx) => {
			if (primary(ctx.lane)) throw new Error(`refused on ${ctx.lane}`);
			return fromBytes(input);
		},
		effect: async (input, ctx) => {
			ctx.effect({ wrote: fromBytes(input), by: ctx.lane });
			if (primary(ctx.lane)) await sleep(150);
			return fromBytes(input);
		},
		sleep: async (input) => {
			await sleep(Number(fromBytes(input)));
			return 'slept';
		},
		// writes the lane's tags the way a prepare() in another isolate would
		setTags: async (input, ctx) => {
			await ctx.storage.put('burrow:tags', JSON.parse(fromBytes(input)));
			return 'set';
		},
		store: async (input, ctx) => {
			await ctx.storage.put('seen', fromBytes(input));
			return (await ctx.storage.get<string>('seen')) ?? '';
		},
		boom: () => {
			throw new Error('boom');
		},
		oom: () => {
			throw new RangeError('could not allocate');
		},
		throwsString: () => {
			throw 'a bare string';
		},
		produce: async (input, ctx) => {
			const out = ctx.channel('out');
			for (let i = 1; i <= Number(fromBytes(input)); i++) await out.send(String(i));
			return 'sent';
		},
		produceAndClose: async (input, ctx) => {
			const out = ctx.channel('out');
			for (let i = 1; i <= Number(fromBytes(input)); i++) await out.sendJson(i);
			await out.close();
			return 'closed';
		},
		produceThenFail: async (input, ctx) => {
			const out = ctx.channel('out');
			for (let i = 1; i <= Number(fromBytes(input)); i++) await out.send(String(i));
			if (primary(ctx.lane)) throw new Error('failed after sending');
			await out.close();
			return 'closed';
		},
		consume: async (_input, ctx) => {
			let total = 0;
			for await (const m of ctx.channel('in')) total += Number(m.text());
			return total;
		},
		missingChannel: (_input, ctx) => ctx.channel('nope'),
		hit: async (_input, ctx) => {
			const before = await ctx.atomic('hits').add(1);
			if (primary(ctx.lane)) await sleep(150);
			return before;
		},
		hitTwice: async (_input, ctx) => {
			await ctx.atomic('twice').add(1);
			await ctx.atomic('twice').add(1);
			return 'ok';
		},
		locked: async (_input, ctx) => {
			await using lease = await ctx.mutex('ledger').acquire({ ttlMs: 5000 });
			const n = (await lease.read<number>('n')) ?? 0;
			await lease.write('n', n + 1);
			return n;
		},
		fanout: async (_input, ctx) =>
			(await ctx.map({ task: 'upper' }, ['a', 'b', 'c'])).map((r) => r.text()).join(''),
		spawnChild: async (_input, ctx) => {
			const child = await ctx.spawn({ task: 'describe', input: 'x' });
			return child.json<{ lane: string }>().lane;
		},
		// the control for slot yield: a raw pool from inside a task queues behind its own parent
		selfCall: async (_input, ctx) => {
			const own = new LanePool(
				(ctx.env as { BURROW_LANES: DurableObjectNamespace }).BURROW_LANES,
				{
					name: ctx.lane.replace(/\/l0$/, ''),
					size: 1,
					spares: 0,
					coordinator: false,
					hedge: false,
					maxAttempts: 1,
					stallMs: 300
				}
			);
			return own.map({ task: 'upper' }, ['x']).then(
				() => 'finished',
				(e: { causes: string[] }) => e.causes[0]
			);
		}
	},
	prepare: async (_ctx, have, want) => {
		if (want.generation === 13) throw new Error('generation 13 is unreachable');
		return { ...have, ...want };
	},
	// lanes named cohab/l<n> report one isolate, so health() sees co-residency under miniflare
	isolateToken: (objectId, lane) => (/^cohab\/l\d+$/.test(lane) ? 'cohab' : objectId)
});

/** a lane with nothing configured, for the refusals */
export const BareLane = defineLane({});

export default {
	async fetch(): Promise<Response> {
		return new Response('burrow test harness');
	}
};
