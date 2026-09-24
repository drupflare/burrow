# @drupflare/burrow

Execute arbitrary WebAssembly on Cloudflare Workers.

## 📋 Table of Contents

- [🎯 Why Burrow](#-why-burrow)
- [📥 Install](#-install)
- [🚀 Quick Start](#-quick-start)
- [🔁 Execution Paths](#-execution-paths)
- [🔗 Dynamic Libraries](#-dynamic-libraries)
- [📦 Declaring a Runtime](#-declaring-a-runtime)
- [🧮 Memory Budget](#-memory-budget)
- [⚡ Parallel Lanes](#-parallel-lanes)
- [🩺 Doctor](#-doctor)
- [🔒 Security](#-security)
- [🧭 Subpath Exports](#-subpath-exports)
- [🧪 Testing](#-testing)
- [📄 License](#-license)

## 🎯 Why Burrow

Cloudflare Workers forbids WebAssembly code generation at request time. A Worker cannot call
`new WebAssembly.Module`, `WebAssembly.compile`, `eval` or `new Function`, so it cannot run code it
did not know about at deploy time.

burrow runs it anyway, by not compiling it. An interpreter compiled to wasm ships in the bundle, and
a guest module arriving with a request is data to that interpreter. Nothing is generated, so nothing
is blocked.

The same property makes dynamic linking work. Loading a `-s SIDE_MODULE` build normally means
producing a `funcref` for every address-taken symbol, which is code generation. To an interpreter a
function pointer is an index into its own table, so that step does not exist.

burrow ships no language runtime. The consumer provides one; burrow handles acquisition, residency
and safety.

## 📥 Install

```sh
bun add @drupflare/burrow
```

The types expect the Workers globals, from `@cloudflare/workers-types` or `wrangler types`.

## 🚀 Quick Start

```ts
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
import { createInterpreter } from '@drupflare/burrow/interpret';

export default {
  async fetch(request: Request) {
    const vm = await createInterpreter({ module: wasm3 });
    const guest = vm.load(new Uint8Array(await request.arrayBuffer()));
    return Response.json({ answer: guest.call('main') });
  }
};
```

Host functions are plain JavaScript, which is legal here because the guest's `call_indirect` never
touches a real funcref table:

```ts
const guest = vm.load(bytes, {
  imports: {
    env: {
      now: { signature: 'i()', fn: () => Date.now() | 0 },
      log: { signature: 'v(ii)', fn: (ptr, len) => console.log(guest.readText(ptr, len)) }
    }
  }
});
```

## 🔁 Execution Paths

Three paths, chosen by one question: do you know this module at deploy time?

| Path        | For                                                | Speed               |
| ----------- | -------------------------------------------------- | ------------------- |
| `interpret` | bytes the deployment never saw                     | see the ratio below |
| `import`    | modules that shipped in the bundle                 | 1.00x, native       |
| `publish`   | bytes that should become native, in the background | 1.00x once live     |

`interpret` is the default because it is the only one that always works. `import` is not better,
only narrower.

The interpreted ratio is set by the guest, not by burrow:

> **ratio = 1 + D_cy x G**, where `G` is guest instructions retired per native cycle.

The interpreter's overhead is additive and nearly constant, so what decides the ratio is how much
the guest already stalls. A pointer chase over a 64 MiB working set measures 1.01x; the same chase
over 16 KiB measures 4.41x; a per-byte transform measures 20x.

**Match the work to the path.** Memory-bound and latency-bound work interprets for almost nothing.
Compute-dense work with a small working set belongs in the bundle, or on the native path via
`publish`. [ADVANCED_USAGE.md](ADVANCED_USAGE.md) carries the measured curve and the by-shape table.

## 🔗 Dynamic Libraries

```ts
import { createLinker } from '@drupflare/burrow/dylink';

const linker = createLinker(vm);
const lib = linker.load(soBytes, { name: 'ext' });

lib.call('ext_run', 20, 22);
lib.readText(lib.address('greeting')!);
```

Linked against a host runtime, an extension shares the host's heap, table and symbols, which is what
a real extension ABI needs:

```ts
const host = vm.load(mainModuleBytes);
const ext = createLinker(vm, { host }).load(extensionBytes);

ext.call('ext_install'); // allocates from the host heap and calls back into it
```

Admission reads the library's declared demand rather than its size, because a library's `.bss`
occupies no bytes in the file:

```ts
const { memorySize, tableSize, needed } = linker.inspect(soBytes);
```

Verified against zlib 1.3.2 built as an ordinary `-s SIDE_MODULE`: the interpreted library
compresses, and node's own zlib reads the result back.

Loading at request time buys reach rather than speed. Anything on a hot path belongs in the bundle.
[ADVANCED_USAGE.md](ADVANCED_USAGE.md) has the cost model and the work shapes that suit it.

## 📦 Declaring a Runtime

```ts
import { Burrow, defineRuntime } from '@drupflare/burrow';

const php = defineRuntime({
  name: 'php',
  load: () => import('./runtimes/php.js'),
  instantiate: async ({ loaded, io, lines }) => {
    const mod = await loaded.PHPFactory({ stdout: lines(io.print) });
    return { FS: mod.FS, callMain: (argv) => mod.callMain(argv) };
  },
  memory: { initial: 96 * 1024 * 1024, peak: 116 * 1024 * 1024 }
});

const burrow = new Burrow({ runtimes: [php] });

await using sh = await burrow.session('php');
await sh.evalText('<?php echo phpversion();');
```

`load` must be a thunk around a literal specifier, because esbuild cannot follow a computed one.

## 🧮 Memory Budget

`Budget` tracks linear memory per resident runtime against the isolate cap, refuses a boot that
would not fit, and evicts least-recently-used residents first. Declared figures are corrected from
observation after each run.

A lease is the interlock: nothing leased is ever evicted, and a boot that cannot fit throws
`BudgetError` rather than letting the isolate run out.

## ⚡ Parallel Lanes

One isolate has one thread. `@drupflare/burrow/parallel` spreads one job across Durable Objects of
the same Worker, each on its own execution context, and gathers the results in order.

```ts
import { defineLane, LanePool } from '@drupflare/burrow/parallel';
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';

export const BurrowLane = defineLane({
  interpreter: wasm3,
  tasks: { checksum: (input) => input.reduce((a, b) => (a + b) >>> 0, 0) }
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pool = new LanePool(env.BURROW_LANES, { size: 16 });
    const sums = await pool.map({ task: 'checksum' }, [new Uint8Array([1, 2]), 'text']);
    return Response.json(sums.map((r) => r.number()));
  }
};
```

```jsonc
"durable_objects": { "bindings": [{ "name": "BURROW_LANES", "class_name": "BurrowLane" }] },
"migrations": [{ "tag": "burrow-lanes", "new_sqlite_classes": ["BurrowLane"] }]
```

A slice can be guest wasm, a named task from your bundle, or a runtime evaluation. The pool retries
failures on spare lanes and hedges slow slices, and accepts exactly one result per slice. Measured
through the packed package on deployed Workers, a warm 16-lane pool ran an interpreted guest job
that takes 3-4 s on one lane 7.8-8.5x faster; shorter jobs scale less, because every slice pays a
fixed dispatch cost.

`spawn` and `scope` give thread-like handles, `atomic` and `mutex` coordinate lanes, and `channel`
streams messages between them. [ADVANCED_USAGE.md](ADVANCED_USAGE.md#parallel-lanes) covers the
semantics and the measurements.

## 🩺 Doctor

```sh
bunx burrow doctor ./runtimes/php.js
```

Scans a runtime for patterns that are fatal on Workers: `eval`, `new Function`, request-time wasm
compilation, browser-only glue, and an unguarded `self.location` read. It reports findings and never
a clean bill of health, because a source scan cannot prove the absence of a JIT. Exit code 0 means
nothing known-fatal was seen.

## 🔒 Security

burrow runs code the deployment never saw. Treat a guest as untrusted unless you built it.

**What the platform already handles.** A Worker isolate is ephemeral and has no filesystem, no
subprocesses and no syscalls, so the persistence-shaped threats do not apply: there is nowhere for a
miner to keep running, nothing for a trojan to install into, and no host to pivot to. A hostile
guest gets one request.

**What is left is the capabilities you hand over.** The guest can reach exactly as far as the host
functions you supply. An import that fetches reaches the network; one that reads a binding reads
your data; one that takes a pointer and a length can be handed any pointer. Supply the narrowest
imports that do the job, validate arguments inside them rather than trusting the guest, and grant
nothing you would not grant a browser extension.

```ts
const vm = await createInterpreter({ module: wasm3, maxMemoryBytes: 64 * 1024 * 1024 });

const guest = vm.load(untrustedBytes, {
  imports: {
    env: {
      // no fetch, no bindings, no clock the caller did not ask for
      log: {
        signature: 'v(ii)',
        // cap the length here rather than trusting the one the guest passed
        fn: (ptr, len) => console.log(guest.readText(ptr, Math.min(len, 4096)))
      }
    }
  }
});
```

**Set `maxMemoryBytes` for any guest you did not build.** Without it a guest can grow memory until
the isolate dies, and an isolate OOM fails every request on that isolate rather than one.

**Dynamic libraries linked into a host are not sandboxed from it.** They share one memory and one
table, so a library can read and write everything the host holds and call anything the host can.
That is what an extension ABI is, and it is also what a hostile library wants, so it has to be asked
for:

```ts
createLinker(vm, { host, allowHostAccess: true }); // only for libraries you would run in-process
createLinker(vm); // user-supplied: each library gets an address space of its own
```

Without a host, libraries resolve no symbols across each other and cannot reach the host's heap.

**Guest memory is isolated; guest CPU is not.** Every guest access is bounds-checked, so a guest
cannot read the interpreter or another guest. Nothing here stops a guest spinning, so the Worker CPU
limit is what ends a runaway loop. Do not run untrusted guests inside a Durable Object you need to
stay responsive.

**Isolates are shared across requests.** Anything a previous request left in an interpreter's memory
is readable by the next guest loaded into it. Create a fresh interpreter per tenant, or per request
where the data warrants it.

`burrow doctor` reports findings and never a clean bill of health, so it is a lint rather than a
gate. [ADVANCED_USAGE.md](ADVANCED_USAGE.md#security) has the threat model in full.

## 🧭 Subpath Exports

| Export        | Contents                                |
| ------------- | --------------------------------------- |
| `.`           | everything except `./parallel`          |
| `./interpret` | `createInterpreter`, `WasmInterpreter`  |
| `./dylink`    | `createLinker`, `readDylink`, `Library` |
| `./registry`  | `Burrow`, leases                        |
| `./session`   | `Session` and the `eval` surface        |
| `./budget`    | `Budget`                                |
| `./runtime`   | `defineRuntime`, `RuntimeSpec`          |
| `./adapt`     | `lines`, `memoryFS`, `mkdirp`           |
| `./doctor`    | `inspectSource`, `inspectWasm`          |
| `./publish`   | `publishVersion`                        |
| `./probe`     | `probe`                                 |
| `./parallel`  | `LanePool`, `defineLane`, `LaneTask`    |
| `./errors`    | every error type and its code           |

The interpreter binary is an asset rather than a module, and it is imported by path:

```ts
import wasm3 from '@drupflare/burrow/vendor/wasm3.wasm';
```

## 🧪 Testing

```sh
bun run typecheck
bun run test          # gate: unit and node
bun run test:runtimes # real builds installed from npm
bun run format:check
```

Every error carries a stable dotted `code`. Match on that, never on a message.

## 📄 License

MIT
