# Advanced Usage

Reference material for the parts of burrow that need more than a signature to use correctly.

## Contents

- [Runtime Status](#runtime-status)
- [The Runtime Contract](#the-runtime-contract)
- [Dynamic Linking](#dynamic-linking)
- [The Performance Law](#the-performance-law)
- [Memory Budgeting](#memory-budgeting)
- [Parallel Lanes](#parallel-lanes)
- [Security](#security)
- [Things That Will Bite You](#things-that-will-bite-you)

## Runtime Status

Two labels, and no third. **Verified** means a test in the `runtimes` lane installs a real build and
drives it. **Not verified** means everything else, including builds that look like they should work.

| Runtime | Version | Source               | Status   |
| ------- | ------- | -------------------- | -------- |
| PHP     | 8.5     | `php-wasm`           | Verified |
| Lua     | 5.4     | `wasmoon`            | Verified |
| Python  | 3.x     | `pyodide`            | Verified |
| QuickJS | latest  | `quickjs-emscripten` | Verified |
| Java    | TeaVM   | `@gmitch215/bytebox` | Verified |
| Ruby    | 3.4     | `@ruby/wasm-wasi`    | Verified |

QuickJS cannot carry session state: its entry point is a context per evaluation, and a context is
its unit of isolation.

Ruby is the only WASI build here. It has no `FS` object, because its filesystem is a preopen the
host supplies, and its `_start` runs the interpreter to completion and cannot be re-entered, so the
adapter enters through `vm.eval` instead. The WASI shim is `@bjorn3/browser_wasi_shim` rather than
node's built-in, which workerd does not have.

Java runs, but a class the build never compiled cannot be loaded. TeaVM is a whole-program
closed-world AOT compiler, so an arriving class has no metadata to attach to and there is no
`defineClass` to call. The barrier is the compilation model rather than the platform, so no amount
of work here changes it.

## The Runtime Contract

A `RuntimeSpec` says how to load a runtime, how to turn it into `{ FS, callMain }`, and what it
costs.

```ts
import { defineRuntime } from '@drupflare/burrow';

export const php = defineRuntime({
  name: 'php',
  load: () => import('./runtimes/php.js'),
  async instantiate({ loaded, io, lines }) {
    const mod = await loaded.PHPFactory({
      noInitialRun: true,
      stdout: lines(io.print),
      stderr: lines(io.printErr)
    });
    return { FS: mod.FS, callMain: (argv) => mod.callMain(argv) };
  },
  memory: { initial: 96 * 1024 * 1024, peak: 116 * 1024 * 1024 }
});
```

`load` must be a thunk around a literal specifier. `wrangler deploy` bundles with esbuild, which
cannot follow `import(someVariable)`, so a registry that built a specifier at runtime would deploy
and then find nothing.

`analyzePath` is optional on `RuntimeFS` because wasmoon's filesystem does not have it.

## Dynamic Linking

burrow loads `-s SIDE_MODULE` builds, PHP `.so` extensions and TeaVM C-backend artifacts at request
time, without generating a single instruction.

### Why this needs an interpreter

A position-independent module reaches its symbols through imported globals. Where a symbol's address
is a function pointer, a loader has to produce a `funcref` for it, and emscripten does that by
assembling module bytes and calling `new WebAssembly.Module`. That call is what Cloudflare Workers
forbids at request time, which is why `.so` extensions have never loaded there.

An interpreter has no such step. A function pointer is an index into a table the interpreter owns,
`__memory_base` and `__table_base` are numbers it chooses, and a relocation is an addition. The ABI
is data.

### Loading a library

```ts
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
import { createInterpreter } from '@drupflare/burrow/interpret';
import { createLinker } from '@drupflare/burrow/dylink';

const vm = await createInterpreter({ module: wasm3 });
const linker = createLinker(vm);

const lib = linker.load(new Uint8Array(await request.arrayBuffer()), { name: 'ext' });
lib.call('ext_run', 20, 22);
```

`Library` addresses the memory the library was placed in:

| Member                 | Answers                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `call(name, ...args)`  | an exported function, up to four i32 arguments                      |
| `address(name)`        | the address of an exported data symbol, offset by `memoryBase`      |
| `pointer(name)`        | the table slot a function occupies, allocating one if it has none   |
| `read` / `readText`    | bytes and NUL-terminated strings                                    |
| `write`                | bytes or a string, UTF-8 encoded for you                            |
| `readU32` / `writeU32` | a little-endian 32-bit value, which is what a C out-parameter holds |
| `info`                 | what `dylink.0` declared                                            |

`pointer` is one-to-one, so two GOT entries for the same symbol compare equal, which is what C code
comparing function pointers expects.

### Admission control

Gate on `memorySize`, never on the byte length:

```ts
const info = linker.inspect(bytes);
if (info.memorySize > budget) throw new Error('too large');
```

A library's `.bss` occupies no bytes in the file. An 8 MiB demand arrives in a 211-byte artifact, so
a size check against the bytes lets it straight through. Every field of `dylink.0` sits within the
first few dozen bytes of the file, so this costs one header read.

### Answering a library's imports

A self-contained library leaves libc undefined. Supply what it names:

```ts
const linker = createLinker(vm, {
  imports: {
    malloc: (n) => allocate(n),
    free: () => undefined,
    strlen: (p) => lib.readText(p).length
  }
});
```

Signatures come from the library's own type section, so a bare function is enough. Pass
`{ signature, fn }` only to override one.

When nothing answers a symbol, the load fails with every missing name at once rather than the first:

```ts
try {
  linker.load(bytes);
} catch (e) {
  if (e.code === 'burrow.dylink.unresolved') console.log(e.unresolved);
  // ['env.strlen', 'env.malloc', 'env.snprintf', ...]
}
```

### Linking against a host runtime

This is the shape a language runtime and its extensions have: one address space, the runtime's
allocator, and pointers that mean the same thing on both sides.

```ts
const host = vm.load(mainModuleBytes); // a -s MAIN_MODULE build
const linker = createLinker(vm, { host });
const ext = linker.load(extensionBytes, { name: 'ext' });

ext.call('ext_install'); // allocates from the host heap, calls host functions
host.readText(ext.call('ext_name')); // the host dereferences the extension pointer
```

The host must export `memory`, `__indirect_function_table` and an allocator. burrow registers it
under the name `env`, which is what a side module imports from, so the host's symbols answer the
library's imports directly. Name the allocator with `allocator` if it is not `malloc`.

Without a host, each library is placed in an address space of its own and no symbols resolve across
libraries. With one, every library shares the host's memory, table and symbols.

### What it costs

A module carried by the interpreter costs **4.20x its file size for code-dense modules and 2.06x for
data-dense ones**, plus **2.52x on first execution**, because the interpreter compiles a function to
its own bytecode the first time it is called. A module loaded and never called is cheaper than one
that is used. All of it is linear memory.

Extensions duplicate their static dependencies. Two extensions that each statically link zlib carry
two copies. Building the dependency as its own side module and letting the extension import from it
shares one copy, and the dependent shrinks dramatically: measured at 523 bytes against 222,449 for
the statically linked form. The saving is negative for the first consumer and grows from the second.
`dylink.0`'s `NEEDED` subsection records which libraries a module expects, and `info.needed` exposes
it.

Nothing is ever unloaded. `Linker` accumulates, so an isolate holds the union of every library any
request asked for. A repeat request for a library already loaded is free, and the union saturates
once every library in your catalogue has been asked for once. **Budget the union of everything any
caller may ever ask for, not the per-request set.** A per-request check that passes each library
individually will pass all of them and still exhaust the isolate. To reclaim, drop the whole
interpreter and create another.

### When to use it

Request-time linking buys reach, not speed. Everything it loads runs interpreted, so anything on a
hot path belongs in the bundle, imported and run at native speed.

The work shape decides whether a library is worth loading, and it inverts the obvious ordering:

| Work shape                | Tax            | Verdict                                             |
| ------------------------- | -------------- | --------------------------------------------------- |
| capability, paid at setup | one-off        | cheapest class; amortised over every later request  |
| small-key lookup          | 1.0x to ~15x   | cheap when it misses cache, dearer when it fits L1  |
| per-row query             | multiplicative | fine for small reads, not a query layer             |
| per-byte transform        | 29.7x to 43.5x | hostile; the tax scales with what users make bigger |

So the libraries worth loading are the ones whose absence costs a capability, not the ones whose
presence saves work. Image and text codecs are the worst fit and the first thing most people reach
for.

Four things a pre-linked bundle cannot do, which is the case for loading at request time:

1. A tail that is per-tenant rather than per-deployment. N tenants each wanting one different library
   is N bundles at build time and one loader at request time.
2. A library the operator does not control, including anything user-supplied.
3. A set too large to bundle.
4. Iteration speed, which turns a redeploy into a fetch.

### Limits

- Four i32 arguments per call. Wider values and more arguments go through memory.
- The dynamic linking ABI is provisional. `tool-conventions/DynamicLinking.md` states there is no
  stable ABI yet, so a future toolchain may emit something this loader does not read.
- A standalone library's stack is sized from `memorySize` plus 256 KiB. Raise `standalonePages` for
  anything that recurses deeply.

## The Performance Law

There is no single interpreter ratio, and quoting one is how this gets predicted wrong.

> **ratio = 1 + D_cy x G**

`G` is guest wasm instructions retired per native CPU cycle, a property of the guest program. `D_cy`
is the interpreter's cost in cycles per guest instruction.

What makes the law useful is that **the interpreter's cost is additive and nearly constant**, so the
ratio is decided by how much the guest already stalls rather than by anything burrow does. A
dependent pointer chase, measured across working-set sizes on an M2 Pro:

| Working set | Native ns/load | Interpreted ns/load | Ratio |
| ----------- | -------------- | ------------------- | ----- |
| 16 KiB      | 1.461          | 6.442               | 4.41x |
| 256 KiB     | 3.551          | 6.209               | 1.75x |
| 1 MiB       | 5.143          | 7.349               | 1.43x |
| 16 MiB      | 15.792         | 18.425              | 1.17x |
| 64 MiB      | 86.640         | 87.343              | 1.01x |

The interpreted column rises by 81 ns while the native column rises by 85. The overhead is the same
2.2 to 2.7 ns per load throughout; only the denominator changes. **A guest that misses cache runs at
native speed, and a guest that fits in L1 pays the most.**

### By workload shape, measured

The shapes below are what decide whether interpreting something is worth it. Ratios are against V8
on the same module, median of interleaved rounds.

| Shape                                  | Ratio    |
| -------------------------------------- | -------- |
| pointer chase, working set over 16 MiB | 1.0-1.2x |
| pointer chase, 256 KiB to 4 MiB        | 1.4-1.8x |
| word-at-a-time checksum                | 3.6x     |
| pointer chase, L1-resident             | 4.3x     |
| per-byte transform                     | 20.3x    |
| call-dense recursion                   | 22.6x    |
| branchy if/else                        | 27.4x    |

Geomean over those five program shapes is 12.1x.

**Match the work to the path.** Memory-bound and latency-bound work interprets essentially for free.
Compute-dense work with a small working set does not, and belongs in the bundle on the `import` path
or on the native path via `publish`.

### Where the cost comes from

The same guest, run by V8, by wasm3 built natively, and by wasm3 compiled to wasm, which is what
burrow ships:

| Workload        | V8       | wasm3 native | wasm3 in wasm | Interpretation | Hosting |
| --------------- | -------- | ------------ | ------------- | -------------- | ------- |
| per-byte xor    | 0.085 ms | 1.332 ms     | 1.648 ms      | 15.6x          | 1.24x   |
| branchy if/else | 0.115 ms | 1.675 ms     | 3.052 ms      | 14.6x          | 1.82x   |

About 15x is what interpreting costs, and 1.2 to 1.8x is what hosting the interpreter as wasm adds.
The hosting term concentrates in control flow, which is where V8's `call_indirect` bounds and
signature checks land on every dispatch.

Two things follow. Compute-dense guests cannot be brought near native by tuning an interpreter,
because the interpretation term dominates and closing it means compiling. And the obvious
superinstruction work is already in the baseline: the vendored wasm3 folds operand plumbing into its
operands, and fuses compare-with-branch, compare-with-if and producer-with-`local.set`.

### What the vendored interpreter carries

`src/vendor/wasm3.wasm` is not stock wasm3. `tools/build-interp.sh` pins the upstream revision by
SHA, applies three changes, and commits the result:

- a fold of a loop's affine induction update into its back edge, which upstream has no equivalent of
- a retype of the dispatch table from `funcref` to a non-nullable typed function reference, so V8
  stops emitting a signature check on every dispatch
- a catalog of fused handlers, one per operation sequence in `tools/interp/fuse-catalog.json`, each
  running its operations with no dispatch between them

The catalog is data. Handlers are generated at build time from wasm3's own operation macros, so a
fused handler has wasm3's semantics rather than a hand-written copy of them, and a guest is matched
against the catalog after it compiles. Nothing is generated at request time.

`Interpreter.fusedSequences` reports how many sequences the pass has replaced. Guests compile lazily,
so it is 0 before anything runs and grows as functions are first called.

Rebuilding needs `emcc`, `wasm-tools` and `node`. The typed table cannot come out of emcc, because
LLVM has no `function-references` target feature and gives every C function pointer one shared
`funcref` table, so that step is a post-link rewrite.

Measured and rejected, so nobody re-buys them: skipping the memory bounds check is a net loss
(geomean 1.038 and it gives up memory safety), and building the interpreter with LTO changes nothing
(geomean 1.005) for 28 KB.

### Benchmark Rules

Three instrument bugs were caught while producing those numbers, each by disbelieving a flat line.
The `bench` lane asserts all three as correctness checks:

1. **A native arm that does not scale with the work is not doing the work.** `acc = acc + 3` repeated
   N times folds to `acc + 3N`, and native read a constant time whether the loop body was 10 or 262
   instructions.
2. **A pointer chase must be a real cycle.** `buf[i] = (i * stride) % n` makes `buf[0] = 0`, which
   self-loops on one L1-resident element.
3. **State whether iterations are dependent.** That single property moved one benchmark between
   20.29x and 9.54x with nothing else changed.

## Memory Budgeting

The isolate cap is the binding constraint, which is why the registry has a policy rather than a
`Map`. `Budget` tracks declared and observed linear memory per resident runtime, refuses a boot that
would not fit, and evicts least-recently-used residents first.

Observed memory is read after boot and after each run, so a runtime whose declared `peak` was
optimistic is corrected from measurement rather than trusted.

Eviction never touches a leased runtime, so the lease is the interlock. A `Session` holds its lease
for its lifetime, which is what makes a REPL keep its state.

```ts
await using lease = await burrow.acquire('php');
// evictable again when the scope ends
```

A boot that cannot fit because everything resident is leased throws `BudgetError` rather than
evicting something in use. The failure to avoid is an isolate OOM, which takes down the whole
Durable Object rather than one request.

## Parallel Lanes

A Worker isolate has one execution context: `Worker` is undefined, `navigator.hardwareConcurrency`
is 1 and `Atomics.wait` throws, all tested on a deployed Worker. Distinct Durable Objects of the
same
class run concurrently, so a job split across objects gets parallel CPU and aggregate memory. Lanes
share no memory; slices exchange bytes.

### Setup

`defineLane` returns the Durable Object class. One class serves every role the pool needs: lanes,
spares, coordinators, sync objects and channel brokers are instances of it under separate ids, so a
consumer adds one export, one binding and one migration. The class must be SQLite-backed, because
sync objects keep their state in SQL.

```ts
import { defineLane } from '@drupflare/burrow/parallel';
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';

export const BurrowLane = defineLane({
  interpreter: wasm3,
  tasks: {
    // named tasks run at native speed; the body is ordinary code from this bundle
    checksum: (input) => input.reduce((a, b) => (a + b) >>> 0, 0)
  },
  prepare: async (ctx, have, want) => {
    // seed ctx.storage until this lane holds `want`, then answer the tags it now holds
    return { ...have, ...want };
  }
});
```

An existing Durable Object class, such as a replica that already holds the data a slice needs, can
serve slices without becoming a second class by forwarding its `fetch` to
`handleLaneRequest(this.ctx, this.env, request, config)`.

### Work Kinds

| Work                            | The lane                                                                             | Result                                   |
| ------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `{ guest, fn, args?, input? }`  | loads the guest, writes `input` at its `alloc` export, calls `fn(ptr, len, ...args)` | the i32, or bytes with `result: 'bytes'` |
| `{ task, input?, channels? }`   | calls the named task with `(input, ctx)`                                             | the return value, encoded by type        |
| `{ runtime, source?, files? }`  | instantiates the runtime for this slice, evaluates, discards                         | `RunResult` on `result.run`              |
| `{ runtime, source, affinity }` | keeps a session on the lane chosen by `affinity` between slices                      | `RunResult`; state carries               |

A guest that imports host functions is refused with `burrow.parallel.impure` unless the work says
`idempotent: true`, because hedging and retries can run a slice twice. A `bytes` result is a pointer
to a little-endian `u32` length followed by that many bytes.

### Scheduling

- **Pull by default.** Idle lanes take the next slice. On a deployed prototype of this scheduler, a
  1 s job at 16 lanes spanned 121 ms against 160 ms for static assignment, with the slowest rep at
  181 against 500.
- **Locality first.** Each pending slice goes to the idle lane that satisfies its `requires`, with
  the most `prefers` matches, avoiding an isolate that is already running a slice, then in rotation
  order. The pool learns each lane's tags and isolate from every answer, `health()` and `prepare()`,
  and lanes it has not heard from count as eligible. Static assignment ignores placement.
- **Over-partitioning.** A single `input` is split into twice as many chunks as there are lanes;
  pass `split` or pre-chunked `inputs` for records.
- **Deadline hedge.** Once a quarter of the slices are in, a slice running past three times the
  median, or `hedgeFloorMs` (250 ms) if that is longer, is duplicated onto a spare and the first
  good answer wins. Before a quarter are in, the deadline is eight times the floor.
- **Retries** go to a spare. `impure`, `unknown_task` and `frame_malformed` are never retried. A
  failure that implicates the lane itself, such as an allocation failure, retires that lane id for
  every later job from the same isolate.
- **Sticky slices** (`affinity`) are never hedged or moved; their failure is `sticky_failed`.
- **A stall timer** (`stallMs`, 30 s) bounds every lane call.
- **Coordinator.** By default a job is handed to a coordinator object that runs the scheduler and
  streams results back. On the free plan a Worker was measured refused at 10 ms of CPU once its
  burst was spent, while an object was not. `coordinator: false` schedules in the caller.
- Every call records `pool.lastStats`: requests, hedges, retries, span and slice times, background
  catch-ups, the number of commits, the time spent inside `commit` and a build's `publish`, and the
  rows `commit` reported writing. Commit time is where a primary becoming the bottleneck shows
  first.

### Exactly Once

The pool accepts one result per slice. A task run with `effects: 'capture'` records `ctx.effect(op)`
calls instead of applying them, and the pool's `commit` receives them once per accepted slice; the
write-set of a losing hedge or a failed attempt is discarded. On a deployed Worker, with every
primary held past the deadline so that primary and hedge both finished, 16 hedged slices per job
produced exactly 16 commits in 3 of 3 jobs.

A slice is marked accepted before `commit` runs, so a `commit` that throws is never retried into a
second apply. Instead the job stops and rejects with `commit_failed`: `slices` names the slice whose
commit threw and `committed` lists, in order, every slice applied before it. Nothing after the
failure is committed, so recovery resumes from exactly that list. `commit` can answer the number of
rows it wrote, and the pool sums them into `lastStats.rowsWritten`; burrow cannot count rows written
by the caller's own code any other way.

`build` separates computing from publishing: each accepted result is staged, and `publish` runs
once, only if every slice staged and passed `validate`. Otherwise it throws `build_incomplete`
naming the slices and the previous output keeps serving whole. On a deployed prototype with 34
synthetic pages at measured render costs, staged publication was visible 10-16x sooner than a
serial fill and no reader saw a mixed set.

Retiring the previous generation costs rows. Cloudflare's Durable Objects pricing counts deletes as
rows written, and deleting the old generation added one row per page: 104 rows per 34-page build
against 70 for two slots per path, where the next build overwrites the older slot. See
[Workloads](#workloads).

### Stateful Lanes

A slice with `requires: { generation: 42 }` is placed only on a lane known to hold those tags, and
a lane that turns out not to answers `stale_state` at once rather than catching up on the serving
path. When no lane holds the state, the slice fails fast. Either way the scheduler starts the
lane's `prepare` in the background (`catchUp`, on by default), so a later slice finds it ready.
`pool.prepare(want)` prepares every lane and spare up front. Spares matter: a hedge or retry of a
stateful slice lands on one.

`prefers` is the soft form: `{ 'warm:php': true }` sends a slice to a lane that already holds a
sticky PHP session when one is idle, and anywhere otherwise. Lanes report `warm:<runtime>` for their
sticky sessions.

`prepare` runs in the lane's slot, so no slice sees the state change mid-run, and a change of tags
disposes the lane's sticky runtime sessions, which were built against the old state. A lane reads
its tags from storage on every request rather than keeping a copy: an object can move between
isolates, and a copy left in the old isolate would hand `prepare` a stale `have` and replay a range
the lane already holds.

Replicate state into lanes rather than reading through to a primary. A lane-to-primary query was
measured at 7 ms p50 on a deployed prototype, so a request with hundreds of queries costs more than
it saves.

Warm state belongs in module scope keyed by object id, which `defineLane` does for sticky runtime
sessions. On a deployed probe, instance memory was gone after every idle of 15 s or more, while
module-scope state survived 8 of 8 idles of 120 s and was lost exactly when the isolate recycled.
Across an 8-hour run with jobs 5 minutes apart, 90% of lanes answered from a different isolate than
the job before, so treat warm state as surviving short gaps, not idle periods of minutes.

### Sync

`pool.atomic(key)` and `ctx.atomic(key)` reach one shared number with `load`, `store`, `add` and
`compareExchange`, answering as `Atomics` does. Every op from a slice carries that slice's
`(job, slice)` identity, so a hedged or retried slice repeating an op gets the first answer instead
of applying it again. From the caller, ops apply as sent.

`pool.mutex(key).acquire()` answers a lease with an increasing fencing token and an expiry
(`ttlMs`, 10 s). A holder that never releases loses the lock at expiry and the next waiter is
granted;
its later `release`, `read` and `write` fail with `lock_lost`. Waiters are served first come, first
served, and `timeoutMs` bounds the wait with `lock_timeout`.

**State the lock protects belongs in the lease.** `lease.read` and `lease.write` run inside the lock
object and check its current token. In a deployed prototype, a separate resource that only compares
tokens it has already seen was measured accepting a dead holder's write in 5 of 5 trials, before the
new holder had
written anything.

| Op                       | Measured on a deployed prototype                         |
| ------------------------ | -------------------------------------------------------- |
| atomic op                | 16-18 ms p50                                             |
| lock acquire and release | 39-42 ms p50                                             |
| contended lock           | 17-21 critical sections per second at 4, 16 and 32 lanes |

A lock is a serial point, so keep it for correctness boundaries and count with atomics.

Sync state lives in SQLite, so every op is billed as rows written. Measured through the packed
package from the per-object analytics, 100 ops each:

| Op                                       | Rows written |
| ---------------------------------------- | ------------ |
| atomic op from the caller                | about 2      |
| atomic op from a slice, with its op id   | about 5      |
| lock acquire, one fenced write, release  | about 8      |
| channel, any number of sends, then close | 1            |

At the free plan's 100,000 rows a day that is roughly 20,000 slice-side atomic ops or 12,000 lock
cycles.

### Channels

`pool.channel(name, { capacity })` is a bounded queue held by a broker object. A sender waits while
it is full, a receiver while it is empty, and several of each may attach; each message reaches one
receiver. `close()` ends iteration for every receiver once the buffer drains, and a closed name
stays
closed. `scope.channel(name)` picks a fresh name and closes it when the scope ends.

```ts
await using scope = pool.scope();
const pipe = scope.channel('frames', { capacity: 64 });
const consumer = scope.spawn({ task: 'consume', channels: { in: pipe } });
await scope.spawn({ task: 'produce', channels: { out: pipe } });
```

Sends from a slice are numbered by `(job, slice)`, and the broker drops a number it has seen, so a
retried or hedged producer delivers each message once. A consumer that fails after receiving has
consumed those messages; a retry sees only what is left.

Each endpoint is one long request carrying a stream of records. The broker measured 4.3-5.1k
messages per second from one producer to one consumer on a deployed Worker. In a prototype,
WebSocket and long-poll channels held idle for 60 s billed both ends for the whole minute. burrow's
endpoints are open requests in the same way and have not been measured separately, which is why
channels are scoped.

### Nesting

A task can run children with `ctx.spawn(work)` and `ctx.map(work, inputs)`. While a lane waits on
children, a channel or a lock, it gives up its slot, so a child can always be scheduled, even on a
one-lane pool. The control case, a raw pool created inside a task calling back into its own lane,
stalls. On a deployed prototype, 4 parents with 4 children each ran in 721 ms against 710 ms flat,
and without the yield 13-16 of 16 children timed out.

### Transport

Slices, results and channel records travel as `stub.fetch` bodies. The threshold matrix below was
run
on a deployed Worker, 3 repetitions per cell, each call to a distinct object.

| Concurrent calls x size | RPC `Uint8Array` argument | RPC `ReadableStream` argument | `fetch` body |
| ----------------------- | ------------------------- | ----------------------------- | ------------ |
| 4 x 1 MiB               | 12/12                     | 12/12                         | 12/12        |
| 8 x 512 KiB             | 18/24                     | 24/24                         | 24/24        |
| 16 x 512 KiB            | 31/48                     | 39/48                         | 48/48        |
| 32 x 256 KiB            | 69/96                     | 67/96                         | 96/96        |
| 32 x 1 MiB              | 34/96                     | 24/96                         | 96/96        |

Failed RPC calls rejected with `Network connection lost`; an earlier round saw them never answer
instead. Streams passed as RPC arguments also failed sporadically at 8 x 64 KiB.

### Measured Speedup

A 64-slice interpreted guest job, exact against a native reference on every run, through the packed
package on deployed Workers. The lane counts were interleaved in rotating order within each round,
because separate series drifted: the same one-lane job read 780 ms in one series and 1,240 ms in the
next. Warm pools with stable names, first round discarded; spans are the coordinator's, and clocks
on the edge advance in 20 ms steps.

| Job at one lane | Plan | 8 lanes | 16 lanes |
| --------------- | ---- | ------- | -------- |
| 0.84 s          | paid | 5.6x    | 5.3x     |
| 0.85 s          | free | 5.3x    | 8.5x     |
| 3.8 s           | paid | 7.2x    | 7.8x     |
| 3.2 s           | free | 5.8x    | 8.5x     |

Per-round ratios for the small paid job ran from 2.5x to 6.3x. Every slice pays a fixed dispatch
cost, about 23 ms plus 1.6 ms per lane on the prototype, so a short job stops scaling sooner. A pool
whose ids are new on every job pays object creation instead: slices took about 140 ms p50 against
40 ms warm, and single slices reached 3.5 s. Keep pool names stable.

### Workloads

Measured through the packed package on the paid plan, every result checked against a native
reference.

- **Memory isolation.** 8 slices each filling 96 MiB ran on 8 distinct isolates, 768 MiB at once,
  exact in 4 of 4 runs. One isolate refused a 192 MiB `Uint8Array` with `RangeError: Invalid typed
array length`, so work that needs more than one isolate's heap has to be split across lanes.
- **Image transform in a guest.** A 4 MiB RGBA image split into 32 slices and converted to grayscale
  by a 177-byte guest gave exact bytes in 6 of 6 runs, at 750 ms on one lane and 260 ms on 16.
  Moving 4 MiB in and 1 MiB out through the coordinator is most of the remaining time.
- **Convergence build.** 34 pages rendered and staged into one site object, then published. Live
  writes left readers seeing a mixed site in 11-12 of every 17-18 polls; staged builds showed no
  mixed or partial read in any poll. Visible time was about 580 ms at 16 lanes against 2,063 ms at
  one, with each of the 34 stages a serial round trip to the site object.

| Publishing                          | Rows written per 34-page build |
| ----------------------------------- | ------------------------------ |
| live writes                         | 70                             |
| new generation, `DELETE` the old    | 104                            |
| two slots per path, overwrite older | 70                             |

### Health

`pool.health()` probes every lane and spare and reports those that share an isolate. Co-resident
lanes share one thread and one 128 MiB heap, so two heavy runtimes cannot fit together.
`pool.repair()` moves all but one member of each group to fresh ids for every later job from the
same isolate.

`autoRepair`, on by default, does the same after each job from what the answers already showed,
without a probe. A probe would cost a subrequest per lane from the caller, and a free-plan Worker
has 50. Each lane slot is repaired at most once per isolate, so a pool that cannot separate does not
churn through fresh, cold ids. In a deployed comparison at 16 lanes no co-residency occurred, and
the medians were 100 ms with it and 120 ms without.

## Security

burrow exists to run code the deployment never saw, which is arbitrary code execution by design.
That is a legitimate thing to build: a Drupal host loading its own extensions, a CI service running
user builds, a plugin surface where the operator publishes the plugins. It stops being legitimate
the moment bytes arrive from somewhere you do not control and go straight into an interpreter
holding your bindings.

### What the platform already takes off the table

Most of what "arbitrary code execution" usually means does not apply here, and the reasons are
specific.

A Worker isolate is ephemeral and minimal. There is no filesystem, no `exec`, no
subprocess, no syscall surface and no persistence between isolates. A guest cannot install anything,
cannot survive its request, cannot open a port, and cannot reach the machine. The classic outcomes,
a miner that keeps running, a trojan that persists, a foothold that gets pivoted from, have nowhere
to live.

The interpreter adds memory isolation on top. Every guest access is bounds-checked against the
memory the interpreter gave it, so a guest cannot read the interpreter's own state, another guest's
memory, or anything else in the isolate it was not handed.

### What is actually exposed

Four things, and all four are the consumer's to control.

**The imports you supply.** A guest reaches exactly as far as its host functions and no further.
This is the whole attack surface for a self-contained guest. An import that fetches is outbound
network; an import that reads a binding is your data; an import taking a pointer and a length will
be handed arbitrary pointers and lengths. Validate inside the import, clamp lengths, and do not pass
the guest's numbers through to a binding unchecked.

**Data already resident in the isolate.** Isolates are reused across requests. Anything a previous
request left in an interpreter's linear memory is readable by the next guest loaded into it, because
they share one address space by construction. Where that matters, create an interpreter per tenant
or per request rather than caching one.

**Memory.** Without a ceiling a guest can grow until the isolate dies, and an isolate OOM fails every
request on that isolate rather than the one that caused it.

```ts
const vm = await createInterpreter({ module: wasm3, maxMemoryBytes: 64 * 1024 * 1024 });
```

wasm3 clamps rather than refuses, so the behaviour is specific and worth knowing: `memory.grow`
answers success and `memory.size` reports the larger size, but only memory up to the ceiling is
backed, and the first access past it traps. Memory safety holds. What the guest is told about its
own size does not, so a guest that checks `memory.grow` believes it and traps later. The trade is
deliberate: a trapped guest fails one request, an isolate OOM fails all of them.

**CPU.** Nothing here meters instructions. A guest can spin, and the Worker CPU limit is what ends
it. Do not run untrusted guests inside a Durable Object that needs to stay responsive for anything
else.

### Dynamic libraries are the sharp edge

Everything above assumes a self-contained guest. A library linked into a **host** is a different
posture entirely, and it is the one thing in this package that must be opted into:

```ts
createLinker(vm, { host, allowHostAccess: true });
```

Without the flag the linker throws `burrow.dylink.host_access_denied`.

The reason is that a library placed in a host's address space is not sandboxed from that host. They
share one linear memory, so the library can read and write every byte the host holds, including
whatever a previous request left there. They share one table, so the library can call anything the
host can. Its relocations are addresses the linker hands it. **This is not a weakness in the
implementation; it is what a dynamic linking ABI is.** A PHP extension is supposed to be able to
reach into the PHP runtime, and nothing distinguishes that from a hostile library doing the same.

So the rule is the same one you would apply to a native `.so`: load it into your runtime only if you
would run it in-process anyway. For anything user-supplied, omit `host`. Each library then gets an
address space of its own, resolves no symbols across libraries, and cannot reach the host's heap.

### Etiquette

- Treat a guest as untrusted unless you built it, and keep the trusted and untrusted paths separate
  in your own code rather than deciding per request.
- Grant the narrowest imports that do the job. The absence of an import is the only unbypassable
  control in this package.
- Set `maxMemoryBytes` on anything you did not build.
- Do not pass `allowHostAccess` for user-supplied libraries, and say in your own docs which of your
  libraries are trusted.
- Use a fresh interpreter per trust boundary. Sharing one is sharing an address space.
- `burrow doctor` reports findings and never a clean bill of health. It is a lint on runtimes you are
  choosing, not a gate on guests you are running, and it cannot prove the absence of anything.
- Log what a guest is and where it came from. An ephemeral isolate leaves no trace on its own.

## Things That Will Bite You

**In-worker clocks read 0 on the deployed edge.** Any CPU figure has to come from `cpuTime` on a
deploy, and local-to-edge factors run 2.2x to 6.1x. `burrow probe` exists so this is one command.

**`navigator.userAgent === 'Cloudflare-Workers'` is the only reliable discriminator.** With
`nodejs_compat`, workerd reports `process.versions.node`, so a Node check answers true in both
places. Getting this wrong makes the `location` shim fire under real Node, where wasmoon reads
`location.href` and hands it to `fs` as a filename.

**A runtime that generates code at runtime is dead regardless of the language it emits.** PHP's JIT
dies on the wasm ban; CheerpJ dies because it compiles bytecode to JavaScript and `new Function` is
equally blocked. `burrow doctor` checks for this, and it reports findings rather than a clean bill of
health: a source scan cannot prove the absence of a JIT.

**Lazy `import()` of a wasm module inside a fetch handler is undocumented behaviour.** It is observed
on deployed Workers and read in workerd's source, not a contract. The `runtimes` lane asserts it on
every run so a regression surfaces as a test failure.

**wasm3's raw-function ABI puts arguments at `sp[0]` for a void import and `sp[1]` when there is a
result.** Getting it wrong shifts every argument silently, and the guest sees plausible wrong values
rather than an error.
