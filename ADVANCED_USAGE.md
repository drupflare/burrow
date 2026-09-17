# Advanced Usage

Reference material for the parts of burrow that need more than a signature to use correctly.

## Contents

- [Runtime Status](#runtime-status)
- [The Runtime Contract](#the-runtime-contract)
- [Dynamic Linking](#dynamic-linking)
- [The Performance Law](#the-performance-law)
- [Memory Budgeting](#memory-budgeting)
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
