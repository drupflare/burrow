# Technical Report: Arbitrary WebAssembly on Cloudflare Workers

What `@drupflare/burrow` does, what it costs, and what was measured to find out. Written for
maintainers. Numbers here carry their method; where a figure came from a local machine rather than a
deploy, it says so.

## Contents

- [Executive Summary](#executive-summary)
- [The Gate](#the-gate)
- [Architecture](#architecture)
- [The Performance Law](#the-performance-law)
- [The Interpreter Build](#the-interpreter-build)
- [What Was Measured and Refuted](#what-was-measured-and-refuted)
- [Native Dynamic Linking](#native-dynamic-linking)
- [Parallel Lanes](#parallel-lanes)
- [Instrument Rules](#instrument-rules)
- [Limits](#limits)

## Executive Summary

Cloudflare Workers forbids WebAssembly code generation at request time. burrow runs arbitrary wasm
anyway by not compiling it: a wasm3 interpreter compiled to wasm32 ships in the bundle, and a guest
arriving with a request is data to that interpreter.

Three execution paths answer one question, _do you know this module at deploy time?_

| path        | when                                             | cost                                    |
| ----------- | ------------------------------------------------ | --------------------------------------- |
| `import`    | the module shipped in the bundle                 | 1.00x, it is native execution           |
| `interpret` | the bytes arrived with the request               | the performance law below               |
| `publish`   | not bundled, and hot enough to earn a round trip | 0.29-0.68 s, never on the response path |

The capability that nothing else has is not speed. **`interpret` is a dynamic linker that needs no
code generation.** An Emscripten side module expects its loader to mint wasm function references for
address-taken symbols, which is codegen and therefore blocked. An interpreter resolves imports in
software, so a function pointer is an index in a table it owns and the problem does not arise.

Three findings drove the work and each cost several rounds to get right. There is no single
interpreter ratio, and quoting one produced two wrong numbers before the law below replaced it.
Every dispatch-cost mechanism tried failed, while every semantic-density mechanism paid. And the
codegen gate is complete within one isolate but says nothing about the platform.

Parallelism leaves the isolate instead. One isolate has one thread, but distinct Durable Objects of
one class run concurrently, and `@drupflare/burrow/parallel` schedules one job across them: 7.8-8.5x
at 16 lanes for a 3-4 s interpreted job, 768 MiB held across 8 isolates where one refuses 192 MiB,
and exactly one commit per slice under forced hedging.

## The Gate

Every hatch tested against a live deployment, not inferred.

| hatch                                                     | result                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `new WebAssembly.Module` / `compile` / `compileStreaming` | `Wasm code generation disallowed by embedder`              |
| `new Function` / `eval`                                   | `Code generation from strings disallowed for this context` |
| `node:vm` `runInThisContext`                              | not implemented                                            |
| `WebAssembly.Function`                                    | absent from the namespace                                  |
| a JS function into a funcref table                        | `must be null or a Wasm function object`                   |
| `workerd:unsafe-eval`                                     | `No such module` in production                             |
| codegen in a Durable Object constructor and method        | blocked in both                                            |

What is open, and is what the package is built on:

| primitive                                                | measurement                                         |
| -------------------------------------------------------- | --------------------------------------------------- |
| `await import('./x.wasm')` in a fetch handler            | a real compiled Module; **12.78 MiB in 1 ms** cold  |
| executing a dynamically imported module                  | 2.60 ms/rep against 2.60 ms/rep statically imported |
| `new WebAssembly.Instance(precompiled, imports)`         | unlimited at request time                           |
| shared `Memory`, `Table.grow()`, cross-instance funcrefs | all allowed                                         |
| wasm tail calls, multi-memory                            | supported                                           |

Cloudflare compiles bundle wasm at upload and caches the artifact, so 12.78 MiB in 1 ms is a cached
artifact being deserialized rather than a compile. The mechanism is `Module::newWasmModuleHandler` in
workerd's `jsg/modules-new.c++`, which takes `Lock::AllowEvalScope(js, true)` unconditionally.

**The scope is the isolate, not the platform.** Dynamic Workers would give native-speed execution of
request-time bytes and are excluded by decision, because burrow targets one traditional Worker and a
mechanism that changes the deployment shape is not a drop-in.

### Parallelism, enumerated the same way

Asked separately and tested on a deployed Worker rather than quoted from documentation, because the
codegen work had already shown received wisdom to be wrong once.

| primitive                                   | deployed                                                   |
| ------------------------------------------- | ---------------------------------------------------------- |
| `SharedArrayBuffer`                         | available and constructible                                |
| `new WebAssembly.Memory({shared: true})`    | works, buffer is a SharedArrayBuffer                       |
| a bundled module using `i32.atomic.rmw.add` | instantiates and runs correctly                            |
| `Worker`                                    | **undefined**                                              |
| `navigator.hardwareConcurrency`             | **1**                                                      |
| `Atomics.wait`                              | **throws `Atomics.wait cannot be called in this context`** |

The shared-memory substrate is entirely open and the execution side is closed. Unlike codegen, the
received wisdom here holds: there is no second thread inside one Worker isolate.

## Architecture

`interpret` drives a vendored wasm3 through a small shim. Loading is split into `burrow_parse` and
`burrow_instantiate` because the dynamic linker has to get between them: an imported global carries
its value from `m3_LinkGlobal`, which only works before `m3_LoadModule` runs the initializers that
read it, while a host function is bound by `m3_LinkRawFunctionEx`, which needs the module to already
have a runtime. Those orderings are opposite, so one load entry point cannot serve both.

`dylink` supplies `__memory_base`, `__table_base` and the `GOT.mem`/`GOT.func` entries a side module
imports. Real zlib 1.3.2 built as an ordinary `-s SIDE_MODULE` links and runs, verified against
node's own zlib.

`Linker.unload(name)` reclaims a library's static image, table slots, symbols, host-import bindings
and module. `burrow_unload` unlinks the module from `rt->modules` before freeing it, which is what
makes the free legal against wasm3's header rule, and clears the library's table slots first because
wasm3 stops a freed module from freeing a borrowed table but does not empty entries it wrote into the
host's. Compiled code pages are not reclaimed: wasm3 gates that on `d_m3EnableCodePageRefCounting`,
which upstream leaves off.

## The Performance Law

There is no single ratio. The whole of the interpreter's behaviour is

```text
ratio = 1 + D_cy * G
```

where `D_cy` is the interpreter's cost in cycles per guest instruction and `G` is guest instructions
retired per native cycle, a property of the guest program.

Same total work, only instruction-level parallelism varied:

| ILP | native ns/instr | interpreted ns/instr | ratio |
| --- | --------------- | -------------------- | ----- |
| 1   | 0.145           | 0.500                | 3.46x |
| 2   | 0.071           | 0.552                | 7.78x |
| 4   | 0.042           | 0.419                | 9.95x |
| 8   | 0.040           | 0.392                | 9.73x |

The interpreter is flat; native falls 3.6x and saturates at the core's issue width. Confirmed on a
hashtable where only the dependence changed: interpreted 161.5 against 164.4 ns/lookup, native 16.9
against 8.5, so the ratio moved between 9.54x and 20.29x while the interpreter never did.

**Latency-bound guests are at parity, and it holds on the edge.** A dependent pointer chase through a
Sattolo permutation reads 1.19x locally at a 4 MiB working set and **1.14x on a deployed Worker**.
The edge reads better because its memory is slower and there is more latency to hide.

`D_cy` is a property of the interpreter's architecture rather than of interpretation. Wasmi 2.0 built
natively interprets the same guests 1.11-2.06x faster than wasm3 built natively. wasm3 is still the
right choice, because hosted as wasm32 the ranking inverts and every measured alternative is slower
there.

**Never quote one ratio.** A geomean over a benchmark mix is a statement about the mix.

## The Interpreter Build

`src/vendor/wasm3.wasm` is not stock wasm3. `tools/build-interp.sh` pins upstream by SHA, applies
three changes and commits the result. The binary is reproducible: two consecutive builds are
byte-identical.

**A typed dispatch table.** V8 emits a runtime signature check on `call_indirect` because a `funcref`
table's entry signatures are not static. Retyping the table to a non-nullable `(ref 0)` makes the
check provably unnecessary, and V8 drops it from every dispatch tail: 5 instructions and 2 loads
each, across 616 of 619 dispatching functions. Measured 3.0-5.9% on four guest shapes, A/A within
0.5%. Two details each cost most of the win, so they are recorded: `(ref null $sig)` does **not** get
the optimization, because V8 keeps the load and compares against -1 as a null check; and the typed
table must be at index 0 or V8 loses the inline instance-data slot. LLVM has no `function-references`
target feature, so this is a post-link rewrite rather than something emcc can emit.

**An affine loop fold.** A loop's induction update folded into its back edge, 4 handlers and +0.48%
size, measured 3.4% on zlib in shipping form against an A/A of 0.23%, winning on all four link
orders. A companion compare fold measured 2.0% faster in the toggle harness and **1.1% slower when
rebuilt in the form it would actually ship**, so it was refused. That gap is the argument for
measuring the artifact rather than the experiment.

**A fusion catalog.** 170 fused handlers over 340 operations, one per sequence in
`tools/interp/fuse-catalog.json`, generated at build time from wasm3's own operation macros so a
fused handler carries wasm3's semantics rather than a hand-written copy. Guests are matched against
the catalog after they compile and the head of each match is overwritten. This is data, not code
generation. `Interpreter.fusedSequences` reports how many sequences fired, and the gate asserts it is
non-zero, because a test that passes whether or not the mechanism engages proves nothing.

Fusion research established the shape of the mechanism, all measured with one binary and a runtime
arm toggle so layout is identical across arms:

- **No footprint crossing below 64 handlers.** Value per removed dispatch is flat to rising with
  handler count, 1.53 to 2.23 ns on zlib, where a cost scaling with handler count would show as a
  falling column.
- **A per-guest catalog is worth 1.67-2.11x; a guest-agnostic one 1.08-1.10x on a guest it has never
  seen.** That gap is the finding, and burrow ships the agnostic one because it runs arbitrary wasm.
- **Portability dies with width.** 318 shared exact keys at W=2 falls to 53 at W=5. Normalising
  wasm3's operand-form suffixes roughly doubles shared coverage at every width.
- **Whole loop bodies beat fixed-width tiling** by 1.27x on libjpeg against a greedy MAXW=8 baseline,
  and 8 loop bodies beat 64 tiles there. They are necessarily per-guest, so they are a build-time
  option rather than the shipped default.
- **Trap guards cost nothing at body width**, 0.4% on libjpeg against an A/A of 1.0110, and guards per
  removed dispatch falls as tiles lengthen.

## What Was Measured and Refuted

Recorded so nobody re-buys them. Each closed a mechanism; none closed the objective behind it.

| mechanism                     | result                                                                     |
| ----------------------------- | -------------------------------------------------------------------------- |
| bounds-check removal          | net loss, geomean 1.038, and it gives up memory safety                     |
| LTO on the interpreter        | geomean 1.005 for 28 KB                                                    |
| `br_table` dispatch           | refuted                                                                    |
| edge specialization           | 1.085x, saturates at six handlers                                          |
| a second value register       | 3-4% ABI cost plus multi-day allocator work                                |
| monolithic interpreter        | loses 1.4-1.56x; 16 call sites predict better than one                     |
| operand scheduling            | no slack exists; LLVM already interleaves the operand chains               |
| dispatch lookahead            | already upstream as `d_m3PreloadNextOp`; measures nothing                  |
| profile-guided handler layout | V8 compiles lazily and allocates in first-execution order                  |
| the escape executor           | 2.6% **slower** than the interpreter on its own real tile                  |
| a new guest IR                | operand movement is 10-17% of retired operations, so it caps at 1.11-1.20x |
| whole-function memoization    | no hot function on any real guest is pure                                  |
| predication                   | loses 4.0-4.3% on the most favourable shape that exists                    |
| batch trace weaving           | 1.30x to the interpreter and **2.3-3.4x worse against native**             |
| dependence-driven widening    | native takes 2.2x more of the same independence                            |

Two rules came out of those negatives and outlive them.

**The host inverts the sign.** Misprediction costs about 26 cycles on both hosts, but a dispatch
costs 2.13x more on V8 than natively, 2.196 ns against 1.031. So any mechanism trading dispatches for
branches can win natively and lose hosted, and native runs must never decide such a trade.

**Symmetry.** A mechanism that exposes parallelism to native and interpreted execution alike cannot
close the gap unless the interpreter has exclusive access to it. Batch weaving improved the
interpreter 1.30x and made the ratio 2.3-3.4x worse, because the batch that fed the interpreter fed
native too and native had the issue width to use it.

## Native Dynamic Linking

Proven on a deployed Worker and **not yet shipped in this package**, recorded because it changes what
the interpreter is for.

In an isolate where `new WebAssembly.Module`, `new Function`, `WebAssembly.Function` and
`table.set(slot, jsFunction)` were all confirmed refused in the same request, real zlib 1.3.2 built as
a stock `-s SIDE_MODULE` loaded through `await import()` and ran natively with **zero adapters**,
deflating 256 KiB which the platform's own `DecompressionStream('deflate')` returned byte for byte.
sqlite3 3.39.0 plus a wasm libc shared one address space and a 658-slot table and answered real SQL.

**The claim that dynamic libraries must be interpreted bundles several prohibitions and is one.**
Walking a side module primitive by primitive, the only refusal is `table.set(slot, jsFunction)`.
Everything downstream fails through that one slot. It is V8-fundamental and not negotiable, but a
build-time thunk is a real wasm function and satisfies it by construction, measured at 8.510 ns
against 8.776 ns for a plain wasm-to-JS import, so the wrapper is free and the whole cost is a
boundary any host callback already pays.

Two things are needed that are **not** refusals, just loader protocol Emscripten leaves to the caller:
`__wasm_apply_data_relocs()` and `__wasm_call_ctors()` must be called explicitly, and omitting them
fails with `function signature mismatch`, which looks exactly like a platform refusal.

The signature universe is 30 across six real libraries and saturates. The count that decides the
architecture is _external_ address-taken symbols, and five of six libraries have zero or one; with a
wasm libc bundled, the adapter requirement across the corpus is zero.

This applies to **bundled** libraries. Arbitrary request-time bytes remain interpreter-only, because
`import()` cannot take bytes from a request and `dylink.0` cannot be read back from a compiled Module.

## Parallel Lanes

One isolate has one thread (see the parallelism gate above), so parallel work on one Worker has to
leave the isolate. Distinct Durable Objects of the same class run on separate execution contexts,
and `@drupflare/burrow/parallel` builds a scheduler over them. Everything here stays inside one
traditional Worker: no service bindings, no Dynamic Workers, no Containers.

### What One Job Gets

Measured on a deployed probe on the free plan. The lane kernel was burrow's interpreter running a
141-byte xorshift guest whose sum is partition-invariant, so every split has one correct answer;
0 of 162 answers were wrong. Overlap was bounded without a cross-machine clock: every lane runs
inside the coordinator's span by causality, so the sum of lane CPU time over the span is a lower
bound on concurrency.

| Measurement                       | Result                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| strong scaling, ~1 s job          | 1,021 / 554 / 440 / 254 / 158 ms at 1 / 2 / 4 / 8 / 16 lanes, 6.46x       |
| weak scaling, 32 lanes            | 19.07x throughput, at least 15.62 concurrent CPU streams                  |
| aggregate memory, one job         | 8 x 96 MiB held; one isolate refuses 192 MiB                              |
| cost model                        | `span = ~23 ms + ~1.6 ms per lane + slowest lane`                         |
| warm pool, 17 min, idles to 5 min | 32 of 32 isolates in every job, no replacements, no failures              |
| co-residency                      | sticky when it happens; a co-resident pair costs the job both slices, 35% |

The efficiency loss is stragglers, not fan-out: the slowest lane's wall time jumps from 135 ms to
about 205 ms between 2 and 4 lanes while the mean stays at 140-160. That is why the scheduler
over-partitions, pulls work and hedges rather than making dispatch cheaper.

Module scope is per isolate, not per object. 7 of 171 isolates hosted two live objects interleaved,
and both read the same module state. Instance memory was gone after every idle of 15 s or more while
module state survived 8 of 8 idles of 120 s, so warm runtime state is kept at module scope keyed by
object id.

### Through the Package

Release gate 3 ran the packed 1.1.0 tarball on deployed Workers, every answer checked against a
native reference. The final build passed all 36 functional runs exactly. Spans are the coordinator's
`Date.now()` across I/O, which advances in 20 ms steps. Pools were warm with stable names, lane
counts were interleaved in rotating order within each round, and the first round was discarded.

| Job at one lane | Plan | 8 lanes | 16 lanes |
| --------------- | ---- | ------- | -------- |
| 0.84 s          | paid | 5.6x    | 5.3x     |
| 0.85 s          | free | 5.3x    | 8.5x     |
| 3.8 s           | paid | 7.2x    | 7.8x     |
| 3.2 s           | free | 5.8x    | 8.5x     |

An earlier pass measured each lane count as its own series and reported 7.8x paid and 9.3x free at
16 lanes for the short job. Those figures are withdrawn: the same one-lane job read 780 ms in one
series and 1,240 ms in the next, and interleaving gave 5.3x and 8.5x.

| Workload                                        | Result                                                      |
| ----------------------------------------------- | ----------------------------------------------------------- |
| memory isolation, 8 x 96 MiB                    | 8 distinct isolates, 768 MiB at once, exact 4/4             |
| one isolate, 192 MiB                            | refused, `RangeError: Invalid typed array length`           |
| image transform, 4 MiB RGBA to gray in a guest  | exact 6/6; 750 ms on 1 lane, 260 ms on 16, transfer bound   |
| convergence, 34 pages, live writes              | a mixed site in 11-12 of every 17-18 reader polls           |
| convergence, 34 pages, staged                   | no mixed or partial read; 580 ms at 16 lanes, 2,063 ms at 1 |
| old generation deleted vs two slots per path    | 104 against 70 rows written per build                       |
| stateful job, every primary held past the hedge | 16 hedges, exactly 16 commits, 3/3                          |
| channel, one producer to one consumer           | 5,000 messages at 4.3-5.1k per second                       |
| QuickJS runtime                                 | fresh slices isolated; sticky state 1, 2, 3 on one lane     |
| 32 lanes through one coordinator, free plan     | 66 lane requests in one invocation, none refused            |
| rows written per sync op, 100 each              | atomic 2 from the caller, 5 from a slice; lock cycle 8      |

The deploy found four defects the unit lane could not: spares were never prepared, so every hedge of
a stateful slice failed; object failures reached callers as untyped errors; a channel close flipped
state in memory before its write succeeded; and a retried producer sent its messages twice. A review
from the first consumer found two more: sticky sessions survived a change of lane state, and a
module-level tag cache could hand `prepare` a stale view after an object moved between isolates,
replaying a range the lane already held. Each is covered by a gate test that fails on the old code.

An 8-hour run on the paid plan, one 32-lane job every 5 minutes through a coordinator, completed all
97 jobs exactly with no missed interval: 79 hedges, no retries, co-residency in 8 jobs and each
repaired, span p50 1,220 ms and p99 3,520 ms. It ran the build before the final scheduler changes
and was not a release gate. Between consecutive jobs, 90% of lanes on average answered from a
different isolate, against 8 of 8 module-scope states surviving a 120 s idle earlier; warm state
outlives short gaps, not five-minute ones.

On the free plan, once its daily rows quota had reset, the sync, channel, stateful and build arms
passed 13 of 13 runs exactly, the stateful job again with 16 hedges and exactly 16 commits.

Three runs on the free plan failed with a non-JSON error in the first minute after a fresh deploy,
and none of 36 did afterwards. The cause was not attributed.

Co-residency is repaired from what jobs already report rather than by a probe, because a probe costs
a subrequest per lane from the caller and a free-plan Worker has 50. In a deployed comparison at 16
lanes no co-residency occurred, and medians were 100 ms with automatic repair and 120 ms without.

### Transport

Release gate 2, deployed, 3 repetitions per cell, each call to a distinct object. Delivered
calls out of attempted:

| Concurrent calls x size | RPC `Uint8Array` argument | RPC `ReadableStream` argument | `fetch` body |
| ----------------------- | ------------------------- | ----------------------------- | ------------ |
| 8 x 512 KiB             | 18/24                     | 24/24                         | 24/24        |
| 16 x 512 KiB            | 31/48                     | 39/48                         | 48/48        |
| 32 x 256 KiB            | 69/96                     | 67/96                         | 96/96        |
| 32 x 1 MiB              | 34/96                     | 24/96                         | 96/96        |

Failed RPC calls rejected with `Network connection lost`; an earlier round saw calls carrying byte
arguments never answered at 4-16 MiB aggregate. Slices, results and channel records therefore all
travel as `stub.fetch` bodies.

### Measured and Closed

- **Self-fetch fan-out.** Children ran in the coordinator's own isolate, and 277 of 300 ended
  `exceededCpu` after the first round.
- **A Worker as coordinator on the free plan.** After two bursts of about 1.6 s, a fetch handler was
  refused at exactly 10 ms of CPU every time, while an object ran 10 of 10 at about 1.5 s.
- **Reading state through to a primary.** 7 ms p50 per query, 1.4-1.5 s for 200 queries; lanes
  replicate instead.
- **Fencing with an external resource.** A resource that compares only tokens it has seen accepted
  a dead holder's write in 5 of 5 trials before the new holder wrote. Protected state lives in the
  lock object and is checked against its current token.
- **Long-poll and WebSocket channels.** 21-31 ms and 4 ms round trips, 155 and 3.4-4.7k messages per
  second, against 2 ms and 8.7-9.1k for a point-to-point stream. Idle channels of both kinds billed
  both ends for the whole 60 s held.
- **Nesting without yielding the slot.** 13-16 of 16 children timed out and 0 of 5 answers were
  exact; with the yield, 721 ms against 710 ms flat.
- **A lock as a scaling primitive.** 17-21 critical sections per second at 4, 16 and 32 lanes, about
  50 ms per hand-off.

## Instrument Rules

Six instrument bugs produced confident wrong numbers here, four of which changed a verdict. The
`bench` lane asserts the first three as correctness checks.

1. **A native arm that does not scale with the work is not doing the work.** `acc = acc + 3` repeated
   N times folded to `acc + 3N`.
2. **A pointer chase must be a real cycle.** `buf[i] = (i * stride) % n` makes `buf[0] = 0`, which
   self-loops on one L1-resident element. A later round hit the same rule differently: a chase
   reaching a fixed point read **0.40 ns per L1 load**, physically impossible, and every pre-fix
   number was wrong in a way that changed the answer.
3. **State whether iterations are dependent.** That property alone moved one benchmark between 20.29x
   and 9.54x.
4. **Separate builds are not comparable at these effect sizes.** Binaryen's duplicate-function
   elimination merged four handlers in one build and not another, giving 775 against 779 named
   functions and shifting every index. Within-configuration link-order spread measures 0.95-3.61%,
   and the size spread alone reached 1,196 bytes. Prefer a same-binary runtime toggle.
5. **A fire counter that reads the same across arms is a claim about the binary, so check the
   binary.** One round explained an identical counter by inference and was wrong: the gate bit had
   never been compiled in.

6. **Interleave the arms of a scaling curve.** Measured as separate series, the same one-lane job
   read 780 ms and then 1,240 ms, and the 16-lane ratio built on the first series read 7.8x against
   5.3x interleaved. Rotating the arms within each round puts drift on every arm equally.

A seventh is about the observer. An instrument competing with its own measurement for cores produced
an
A/A of 1.0376 with a MAD of 0.0752, and the contaminant was the agent's own progress polling.

**No spec asserts a performance magnitude.** Specs assert properties; deploys produce numbers, because
in-worker clocks read 0 on the edge and local-to-edge factors run 2.2-6.1x.

## Limits

php.wasm needs 152.25 MiB against a 128 MiB isolate cap, so the interpreter cannot host it.

The interpreter implements no SIMD. A guest declaring `v128` is refused at load with
`burrow.interpret.unsupported`, and `doctor` reports `wasm-simd`. The check reads function signatures
and local declarations, which are the two places the binary format states a value type exactly; a
module moving vectors only through the operand stack is not caught.

`maxMemoryBytes` sets wasm3's runtime limit, and **wasm3 clamps rather than refuses**: `memory.grow`
answers success and `memory.size` reports the larger size while only memory up to the ceiling is
backed, and the first access past it traps. Memory safety holds; what the guest is told about its size
does not.

A library linked into a host shares that host's whole memory and table, which is what a dynamic
linking ABI is rather than a weakness in this implementation. `allowHostAccess: true` is required, and
without it the linker throws `burrow.dylink.host_access_denied`.

Performance figures in this report were measured on an M2 Pro unless they say otherwise. The deployed
measurements are the codegen gate, the parallelism gate, the 1.14x pointer chase, the native dynamic
linking result, and everything under Parallel Lanes.
