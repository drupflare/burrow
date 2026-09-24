# CLAUDE.md

`@drupflare/burrow` — execute arbitrary WebAssembly on Cloudflare Workers.

## Status

1.0.0 is released; 1.1.0 adds `./parallel` and is unreleased. `release.yml` cuts the tag, the
GitHub release and both registry publishes in one `workflow_dispatch` run, and it is the only way this package reaches npm. Every push to master also
publishes a per-commit snapshot to GitHub Packages under the `snapshot` dist-tag.

## The things that are load-bearing and non-obvious

**Cloudflare Workers forbids wasm codegen at request time.** `new WebAssembly.Module`,
`WebAssembly.compile`, `compileStreaming`, `eval`, `new Function` and `node:vm` are all blocked, in
the fetch handler and inside a Durable Object constructor alike. `workerd:unsafe-eval` is not
registered in production. This was tested on deployed Workers, not inferred.

**What is open, and is what this package is built on:**

- `await import('./x.wasm')` inside a fetch handler returns a real compiled `WebAssembly.Module`.
  12.78 MiB materialises in **1 ms** on a cold isolate, because Cloudflare compiles bundle wasm at
  upload and caches the artifact. Execution is identical to a static import.
- `new WebAssembly.Instance(precompiledModule, imports)` at request time is unlimited.
- Shared `WebAssembly.Memory`, `Table.grow()`, cross-instance funcrefs, wasm tail calls and
  multi-memory all work.

**A plain JS function cannot be stored in a funcref table.** Only real wasm function objects can.
That single refusal is why Emscripten's dynamic linker needs codegen, and therefore why `.so`
extensions have never loaded on Workers — and why an interpreter, which resolves imports in
software, gets dynamic linking for free.

**The runtime a consumer supplies must be a pure interpreter.** Any runtime that generates code at
runtime is dead regardless of which language it emits: PHP's JIT dies on the wasm ban, CheerpJ dies
because it JITs to JavaScript and `new Function` is equally blocked.

**Emscripten's `ENVIRONMENT=worker` glue reads `self.location.href` and workerd has no `location`.**
A stub must evaluate before the glue. `src/runtime.ts` installs it.

## Parallel lanes (`./parallel`, 1.1.0)

**One isolate has one thread; distinct Durable Objects of one class run in parallel.** `Worker` is
undefined, `hardwareConcurrency` is 1 and `Atomics.wait` throws, tested deployed. `./parallel`
imports `cloudflare:workers`, so it is not re-exported from `.` and `tests/exports.spec.ts` pins that.

- **Bytes travel as `stub.fetch` bodies, never RPC arguments.** Deployed matrix: RPC `Uint8Array`
  args delivered 34/96 and RPC `ReadableStream` args 24/96 at 32 x 1 MiB (`Network connection lost`);
  fetch bodies 96/96 in every cell. Channels ride fetch streaming bodies for the same reason.
- **Module scope is per isolate and shared by every object in it**; instance memory is evicted after
  ~15 s idle while the isolate lives minutes. Warm state is keyed by object id at module scope.
- **On the free plan a Worker is refused at 10 ms CPU once its burst is spent; an object is not.**
  That is why the coordinator object is on by default. One coordinator invocation made 66 lane
  requests on free without refusal.
- **`rowsWritten` counts index writes**, and the free plan's 100k rows/day quota, once spent, makes
  every sync op and channel close fail until 00:00 UTC. Price rows before a free-account run.
- **A lane waiting on children, a channel or a lock gives up its slot.** Without that, a consumer
  holding a lane deadlocks its producer; the gate has the control.
- **Measure on stable pool names.** Fresh ids per job measure object creation: slices ~140 ms p50
  against ~40 ms warm, and single slices to 3.5 s.

## The performance law

There is no single "interpreter ratio", and quoting one is how this project got the number wrong
twice. The whole of the interpreter's behaviour is:

```text
ratio = 1 + D_cy * G
```

`D_cy` is the interpreter's cost in cycles per guest wasm instruction and `G` is guest wasm
instructions retired per native CPU cycle, a property of the guest program. The ratio is whatever
native does with the same instructions.

**`D_cy` is not one constant across opcode classes.** Measured on the shipped interpreter it is
1.5-2.5 for arithmetic and around 5 for memory-dense loops, so a figure quoted from one class does
not transfer to another. What IS near-invariant is the interpreter's cost per load in absolute
terms, 2.2-2.7 ns once out of L1, which is why the ratio falls as the guest stalls more: a pointer
chase reads 4.41x at 16 KiB and 1.01x at 64 MiB.

**`D_cy` is a property of the interpreter's architecture, not of interpretation.** Wasmi 2.0 built
natively interprets the same guests 1.11-2.06x faster than wasm3 built natively, so the shipped
figure is wasm3's floor rather than the technique's. wasm3 is still the right choice here, because
hosted as wasm32 the ranking inverts and every measured alternative is slower there. Do not write
that any ratio is inherent to interpreting.

Consequences worth carrying:

- Latency-bound guests whose working set MISSES CACHE measure **1.14x on a deployed Worker**. The
  condition is load-bearing: the same chase reads 4.41x when it fits in L1.
- ILP-saturated cheap ALU code is the worst case, and it is a microbenchmark condition: it needs the
  host retiring 7.1 guest instructions per cycle, and no SPEC CPU2017 application exceeds an IPC
  of 3.04.
- Weighting by instruction count rather than by native time is the mistake that makes this look
  worse than it is.

Never quote one ratio. Quote the law and the guest's character.

## Conventions

- `bunx`, never `npx`.
- Imports use a `.js` specifier even for `.ts` files. bun resolves this; `node` does not.
- Errors come from `src/errors.ts` and carry a stable dotted `code`. Do not throw a bare `Error`
  from a public path, and do not make a caller match on a message string.
- Every public API that takes a payload takes `string | Uint8Array`; everything that returns bytes
  also returns decoded text. No caller of this package should ever build a `TextEncoder`.
- Comments: lowercase, terse, one line, no trailing period, only where the WHY is non-obvious, ASCII.
- Every behaviour change ships with its test in the same change, and one spec file per domain — fold
  a new case into the existing spec rather than adding a parallel `*-extra.spec.ts`.
- No runtime is vendored. The consumer supplies it. The only wasm in the package is the interpreter,
  checked in with the script that built it. wasm3 is pinned by SHA and carries three burrow patches;
  `tools/build-interp.sh` is the whole story and the binary is reproducible from it.

## Benchmark rules

Three instrument bugs produced confident wrong numbers here. They are rules now:

1. **A native arm that does not scale with the work is not doing the work.** `acc = acc + 3` repeated
   N times was folded by TurboFan into `acc + 3N`. Assert native time scales with N.
2. **A pointer chase must be a real cycle.** `buf[i] = (i*stride) % n` makes `buf[0] = 0`, which
   self-loops on one L1-resident element. Use Sattolo, and assert the per-load latency matches the
   working set.
3. **State whether iterations are dependent.** Independent iterations measure the interpreter's worst
   case while looking like ordinary code — that property alone moved a hashtable between 20.29x and
   9.54x with nothing else changed.

**No spec asserts a performance magnitude.** Specs assert properties; deploys produce numbers.
Absolute figures come from `burrow probe` on a real Worker, because in-worker clocks read 0 on the
edge and local-to-edge factors run 2.2-6.1x.

## Documentation honesty rule

Two labels, no third state. A runtime is **Verified** when a test in the `runtimes` lane installs a
real build and drives it end to end. Everything else is **Not verified**. Never promote on the
strength of a reading.

Every "this does not work" in the docs names the mechanism and how it was observed, so the next
reader can retest it rather than inherit a guess.

## Commands

```sh
bun install
bun run typecheck                    # tsc over src, and over tests + tools
bun run test                         # gate: the unit and node projects
bun run test:coverage                # same, with istanbul
bun run test:runtimes                # real builds from npm, slow and serial
BURROW_BENCH=1 bun run test:bench    # the workload suite, never in the gate
bun run format:check                 # clang-format over tools/interp/*.c AND prettier
bun run build                        # tsc -p tsconfig.build.json -> dist/
bun run build:interp                 # rebuild src/vendor/wasm3.wasm, needs emcc + wasm-tools
bunx burrow doctor <runtime entry>   # Workers-safety scan
bunx burrow probe <runtime entry>    # deploy, measure on the edge, tear down
```

## Related repositories

- [`drupflare/cartridge`](https://github.com/drupflare/cartridge) — drives an interpreter safely
  inside a Durable Object. burrow produces the `instantiate` callback it accepts; the dependency runs
  one way and neither package imports the other.
- [`drupflare/worker`](https://github.com/drupflare/worker) — Drupal on Workers, the original
  consumer.
- [`gmitch215/bytebox`](https://github.com/gmitch215/bytebox) — Java on Workers, the loader-package
  pattern this one follows.
