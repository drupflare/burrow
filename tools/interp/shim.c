/*
 * burrow's wasm3 embedding, compiled to wasm32 and shipped as src/vendor/wasm3.wasm.
 *
 * Built by tools/build-interp.sh. The exports below are the whole surface src/interpret.ts and
 * src/dylink.ts drive; nothing else about wasm3 is reachable from JavaScript.
 *
 * Loading is split into burrow_parse and burrow_instantiate because the dynamic linker has to get
 * between them. An imported global carries its value from m3_LinkGlobal, which only works before
 * m3_LoadModule runs the initializers that read it; a host function is bound by
 * m3_LinkRawFunctionEx, which needs the module to already have a runtime. Those two orderings are
 * opposite, so a single load entry point cannot serve both.
 *
 * Anything reaching into m3_env.h structs rather than the public header is marked where it happens.
 */
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include "wasm3.h"
#include "m3_env.h"
#if d_m3Fuse
/* defined in m3_fuse.h, which m3_compile.c includes because the opcodes live in that unit */
extern unsigned burrow_fuse_apply(void);
extern void burrow_fuse_reset(void);
extern unsigned burrow_fuse_count(void);
#endif

/* how many operation sequences the fusion pass has replaced; 0 means the pass never fired */
__attribute__((export_name("burrow_fused"))) int burrow_fused(void) {
#if d_m3Fuse
	return (int) burrow_fuse_count();
#else
	return 0;
#endif
}

#define MAX_MODULES 32
#define MAX_TRAMPOLINES 512

/* implemented in JavaScript; the id says which linked import is being called */
__attribute__((import_module("burrow"), import_name("host_call"))) extern int host_call(
	int id, uint64_t* sp, void* mem
);

static IM3Environment env;
static IM3Runtime rt;
static IM3Module modules[MAX_MODULES];
static int module_count;
static char errbuf[512];
static int trampolines_used;
static IM3Function reserved[MAX_TRAMPOLINES];
static IM3Module reserved_in[MAX_TRAMPOLINES];
/* non-NULL means the id is live; both burrow_link and burrow_reserve claim one, unload frees it */
static IM3Module trampoline_owner[MAX_TRAMPOLINES];

__attribute__((export_name("burrow_alloc"))) void* burrow_alloc(int n) {
	return malloc((size_t) n);
}

__attribute__((export_name("burrow_free"))) void burrow_free(void* p) {
	free(p);
}

__attribute__((export_name("burrow_error"))) const char* burrow_error(void) {
	return errbuf;
}

static int fail(M3Result r, int code) {
	if (r) strncpy(errbuf, r, sizeof(errbuf) - 1);
	return code;
}

static int say(const char* message, int code) {
	strncpy(errbuf, message, sizeof(errbuf) - 1);
	return code;
}

static IM3Module at(int index) {
	return (index < 0 || index >= module_count) ? NULL : modules[index];
}

/*
 * memory_limit caps every guest's linear memory in bytes; 0 leaves it uncapped.
 *
 * Reaches into M3Runtime because wasm3 exposes no setter. The cap is what stops a hostile or merely
 * runaway guest from growing until the isolate dies, which takes the whole Durable Object with it
 * rather than one request.
 */
__attribute__((export_name("burrow_init"))) int burrow_init(int stack_bytes, int memory_limit) {
	errbuf[0] = 0;
	// re-initialising used to strand the previous runtime and every module in it
	if (rt) m3_FreeRuntime(rt);
#if d_m3Fuse
	// the recorded stream points into code pages the freed runtime owned
	burrow_fuse_reset();
#endif
	module_count = 0;
	trampolines_used = 0;
	memset(modules, 0, sizeof(modules));
	memset(reserved, 0, sizeof(reserved));
	memset(reserved_in, 0, sizeof(reserved_in));
	memset(trampoline_owner, 0, sizeof(trampoline_owner));
	if (!env) env = m3_NewEnvironment();
	if (!env) return say("no environment", -1);
	rt = m3_NewRuntime(env, (uint32_t) stack_bytes, NULL);
	if (!rt) return say("no runtime", -2);
	if (memory_limit > 0) rt->memoryLimit = (uint32_t) memory_limit;
	return 0;
}

/* the lowest free module slot, reusing one an unload emptied before taking a fresh one */
static int free_slot(void) {
	for (int i = 0; i < module_count; ++i) {
		if (!modules[i]) return i;
	}
	return module_count < MAX_MODULES ? module_count++ : -1;
}

/* parses a module without instantiating it, answering its index or a negative error */
__attribute__((export_name("burrow_parse"))) int burrow_parse(uint8_t* bytes, int len) {
	errbuf[0] = 0;
	int index = free_slot();
	if (index < 0) return say("too many modules", -1);
	IM3Module mod;
	M3Result r = m3_ParseModule(env, &mod, bytes, (uint32_t) len);
	if (r) return fail(r, -2);
	modules[index] = mod;
	return index;
}

/* instantiates a parsed module: resolves its imports, backs its memory and runs its initializers */
__attribute__((export_name("burrow_instantiate"))) int burrow_instantiate(int index) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	M3Result r = m3_LoadModule(rt, mod);
	if (r) return fail(r, -2);
	return 0;
}

/*
 * Registers the module under a name, which is what lets a later module's imports resolve against
 * its exports. A dynamic library imports from "env", so naming the host module "env" is how the two
 * come to share a memory, a table and a symbol set.
 */
__attribute__((export_name("burrow_name"))) int burrow_name(int index, const char* name) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	m3_SetModuleName(mod, name);
	return 0;
}

/* runs the start function, which for an emscripten side module applies its data relocations */
__attribute__((export_name("burrow_run_start"))) int burrow_run_start(int index) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	M3Result r = m3_RunStart(mod);
	if (r) return fail(r, -2);
	return 0;
}

/*
 * Detaches an import the host has already answered, so wasm3's own module-to-module linking leaves
 * it alone.
 *
 * Load-time linking is all-or-nothing per module NAME: once a module called "env" is in the
 * runtime, every "env.x" import must be one of its exports or the instantiation fails with an
 * unknown import. A main module exports its memory, its table and its symbols, but it cannot export
 * __memory_base, because that value belongs to the library being placed and not to the host.
 * Clearing the import record is how a supplied value survives being linked against a host.
 */
static void detach(M3ImportInfo* import) {
	m3_Free(import->moduleUtf8);
	m3_Free(import->fieldUtf8);
	import->moduleUtf8 = NULL;
	import->fieldUtf8 = NULL;
}

/*
 * Supplies the value of an imported i32 global. Must run between parse and instantiate: the data
 * and element segment offsets read __memory_base and __table_base while the module is being
 * instantiated, so a value set afterwards arrives too late to place anything.
 */
__attribute__((export_name("burrow_link_global"))) int burrow_link_global(
	int index, const char* module_name, const char* field, int32_t value
) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	M3TaggedValue v;
	v.type = c_m3Type_i32;
	v.value.i32 = value;
	M3Result r = m3_LinkGlobal(mod, module_name, field, &v);
	if (r) return fail(r, -2);

	for (u32 i = 0; i < mod->numGlobals; ++i) {
		IM3Global g = &mod->globals[i];
		if (g->import.moduleUtf8 && g->import.fieldUtf8 &&
			strcmp(g->import.moduleUtf8, module_name) == 0 &&
			strcmp(g->import.fieldUtf8, field) == 0) {
			detach(&g->import);
			break;
		}
	}
	return 0;
}

/*
 * Reads an exported i32 global. A PIC build exports each data symbol it defines as an immutable
 * global holding the symbol's module-relative offset, so this plus __memory_base is the address a
 * GOT.mem entry needs.
 */
__attribute__((export_name("burrow_global"))) int burrow_global(
	int index, const char* name, int32_t* out
) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	IM3Global g = m3_FindGlobal(mod, name);
	if (!g) return say("no such global", -2);
	M3TaggedValue v;
	M3Result r = m3_GetGlobal(g, &v);
	if (r) return fail(r, -3);
	if (v.type != c_m3Type_i32) return say("global is not i32", -4);
	*out = v.value.i32;
	return 0;
}

/*
 * One trampoline serves every linked import, because m3_LinkRawFunctionEx carries userdata through
 * to the import context. A pool of per-id trampolines would otherwise be needed, since C cannot
 * close over an id and the preprocessor cannot generate numbered symbols from arithmetic.
 */
static const void* trampoline(IM3Runtime r, IM3ImportContext ctx, uint64_t* sp, void* mem) {
	(void) r;
	int id = (int) (intptr_t) ctx->userdata;
	return host_call(id, sp, mem) ? m3Err_trapAbort : m3Err_none;
}

static int claim_trampoline(IM3Module mod) {
	for (int i = 0; i < MAX_TRAMPOLINES; ++i) {
		if (!trampoline_owner[i]) {
			trampoline_owner[i] = mod;
			if (i >= trampolines_used) trampolines_used = i + 1;
			return i;
		}
	}
	return -1;
}

/*
 * Installs a host function for an import, answering the id JavaScript will be called back with.
 *
 * The signature is wasm3's own notation, e.g. "i(ii)" for (i32, i32) -> i32.
 */
__attribute__((export_name("burrow_link"))) int burrow_link(
	int module_index, const char* module_name, const char* field, const char* sig
) {
	errbuf[0] = 0;
	IM3Module mod = at(module_index);
	if (!mod) return say("bad module", -1);
	int id = claim_trampoline(mod);
	if (id < 0) return say("too many linked imports", -2);
	M3Result r =
		m3_LinkRawFunctionEx(mod, module_name, field, sig, trampoline, (const void*) (intptr_t) id);
	if (r) {
		trampoline_owner[id] = NULL;
		return fail(r, -3);
	}
	return id;
}

/* implemented in m3_compile.c; binds a host function to an already-located import */
extern M3Result CompileRawFunction(
	IM3Module io_module, IM3Function io_function, const void* i_function, const void* i_userdata
);

/*
 * Claims a function import for the host before the module is instantiated, answering its id.
 *
 * Needed for the same reason detach() is: with a host module registered under the import's module
 * name, an import the host does not export fails the instantiation before anything can be bound to
 * it. Reserving detaches it; burrow_bind installs the trampoline once the module has a runtime,
 * which is a requirement CompileRawFunction asserts.
 */
__attribute__((export_name("burrow_reserve"))) int burrow_reserve(
	int module_index, const char* module_name, const char* field
) {
	errbuf[0] = 0;
	IM3Module mod = at(module_index);
	if (!mod) return say("bad module", -1);

	for (u32 i = 0; i < mod->numFunctions; ++i) {
		IM3Function f = &mod->functions[i];
		if (!f->import.moduleUtf8 || !f->import.fieldUtf8) continue;
		if (strcmp(f->import.moduleUtf8, module_name) != 0) continue;
		if (strcmp(f->import.fieldUtf8, field) != 0) continue;
		int id = claim_trampoline(mod);
		if (id < 0) return say("too many linked imports", -2);
		reserved[id] = f;
		reserved_in[id] = mod;
		detach(&f->import);
		return id;
	}
	return say("no such import", -3);
}

__attribute__((export_name("burrow_bind"))) int burrow_bind(int id) {
	errbuf[0] = 0;
	if (id < 0 || id >= trampolines_used || !reserved[id]) return say("bad import id", -1);
	M3Result r = CompileRawFunction(
		reserved_in[id], reserved[id], (const void*) trampoline, (const void*) (intptr_t) id
	);
	if (r) return fail(r, -2);
	return 0;
}

/* calls an export by name with up to four i32 arguments, answering its i64-widened result */
static int64_t call_function(IM3Function f, int32_t a0, int32_t a1, int32_t a2, int32_t a3) {
#if d_m3Fuse
	// wasm3 compiles a function on first call, so fusing before each call catches what the last one
	// emitted; the pass only walks operations recorded since it last ran
	burrow_fuse_apply();
#endif
	const void* args[4] = {&a0, &a1, &a2, &a3};
	uint32_t n = m3_GetArgCount(f);
	if (n > 4) return say("more than four arguments", -2);
	M3Result r = m3_Call(f, n, n ? args : NULL);
	if (r) return fail(r, -3);
	int64_t out = 0;
	if (m3_GetRetCount(f) > 0) {
		const void* rets[1] = {&out};
		r = m3_GetResults(f, 1, rets);
		if (r) return fail(r, -4);
	}
	return out;
}

__attribute__((export_name("burrow_call"))) int64_t
burrow_call(const char* name, int32_t a0, int32_t a1, int32_t a2, int32_t a3) {
	errbuf[0] = 0;
	IM3Function f;
	M3Result r = m3_FindFunction(&f, rt, name);
	if (r) return fail(r, -1);
	return call_function(f, a0, a1, a2, a3);
}

/*
 * Calls an export of one specific module. A library and its host routinely export the same name -
 * a side module re-exports the libc symbols it was linked against - and m3_FindFunction answers
 * whichever was loaded last, which is not the one the caller named.
 */
__attribute__((export_name("burrow_call_in"))) int64_t
burrow_call_in(int index, const char* name, int32_t a0, int32_t a1, int32_t a2, int32_t a3) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	IM3Function f;
	M3Result r = m3_FindFunctionIn(&f, mod, name);
	if (r) return fail(r, -1);
	return call_function(f, a0, a1, a2, a3);
}

/* whether an export exists, so a host can probe without treating a miss as an error */
__attribute__((export_name("burrow_has"))) int burrow_has(const char* name) {
	IM3Function f;
	return m3_FindFunction(&f, rt, name) ? 0 : 1;
}

__attribute__((export_name("burrow_has_in"))) int burrow_has_in(int index, const char* name) {
	IM3Module mod = at(index);
	if (!mod) return 0;
	IM3Function f;
	return m3_FindFunctionIn(&f, mod, name) ? 0 : 1;
}

/*
 * The module's memory 0. An import that resolved against another module answers that module's
 * memory, which is what makes a host and its libraries share one address space.
 */
__attribute__((export_name("burrow_mem_ptr"))) void* burrow_mem_ptr(int index) {
	IM3Module mod = at(index);
	if (!mod) return NULL;
	size_t size = 0;
	return m3_GetMemory(mod, &size, 0);
}

__attribute__((export_name("burrow_mem_size"))) int burrow_mem_size(int index) {
	IM3Module mod = at(index);
	if (!mod) return 0;
	return (int) m3_GetMemorySize(mod, 0);
}

/*
 * Grows memory 0 to at least `pages`. A side module declares only enough memory to hold its own
 * data image, so a library loaded without a host has no stack and no heap until this runs.
 *
 * Reaches into M3Memory for the current page count; wasm3 exposes growth to guest code through
 * memory.grow but has no host entry point for it.
 */
__attribute__((export_name("burrow_grow_memory"))) int burrow_grow_memory(int index, int pages) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	if (!mod->numMemories) return say("module has no memory", -2);
	IM3Memory memory = mod->memories[0];
	if ((u64) pages <= memory->numPages) return 0;
	M3Result r = ResizeMemory(rt, memory, (u64) pages);
	if (r) return fail(r, -3);
	return 0;
}

__attribute__((export_name("burrow_table_size"))) int burrow_table_size(int index) {
	IM3Module mod = at(index);
	if (!mod || !mod->numTables) return 0;
	return (int) mod->tables[0]->size;
}

/*
 * Grows table 0 by `extra` slots, answering the first new index.
 *
 * A GOT.func entry needs a table slot for a symbol the module's own element segments did not place,
 * and the declared table size covers only those segments. Reaches into M3Table because wasm3
 * exposes table.grow to guest code and nothing to a host.
 */
__attribute__((export_name("burrow_grow_table"))) int burrow_grow_table(int index, int extra) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);
	if (!mod->numTables) return say("module has no table", -2);
	IM3Table table = mod->tables[0];
	u32 first = table->size;
	if (extra <= 0) return (int) first;
	if (table->hasMax && first + (u32) extra > table->maxSize) {
		return say("table would exceed its declared maximum", -3);
	}
	void** grown = (void**) realloc(table->elements, (first + (u32) extra) * sizeof(void*));
	if (!grown) return say("out of memory growing table", -4);
	memset(grown + first, 0, (size_t) extra * sizeof(void*));
	table->elements = grown;
	table->size = first + (u32) extra;
	return (int) first;
}

/*
 * Writes a function into a table slot, so a guest's call_indirect through a GOT.func value reaches
 * it. `owner` is the module whose table is written; `from` is the module that defines the function.
 */
__attribute__((export_name("burrow_table_put"))) int burrow_table_put(
	int owner, int slot, int from, const char* name
) {
	errbuf[0] = 0;
	IM3Module table_module = at(owner);
	IM3Module func_module = at(from);
	if (!table_module || !func_module) return say("bad module", -1);
	if (!table_module->numTables) return say("module has no table", -2);
	IM3Table table = table_module->tables[0];
	if (slot < 0 || (u32) slot >= table->size) return say("table slot out of range", -3);
	IM3Function f;
	M3Result r = m3_FindFunctionIn(&f, func_module, name);
	if (r) return fail(r, -4);
	table->elements[slot] = f;
	return 0;
}

/*
 * Empties a run of table slots.
 *
 * Needed before unloading: a side module writes its functions into the HOST's table, and wasm3's
 * own teardown only stops a module freeing a table it borrowed, it does not clear the entries it
 * wrote. Freeing a module whose functions are still reachable through someone else's table leaves
 * them dangling and callable.
 */
__attribute__((export_name("burrow_table_clear"))) int burrow_table_clear(
	int owner, int slot, int count
) {
	errbuf[0] = 0;
	IM3Module table_module = at(owner);
	if (!table_module) return say("bad module", -1);
	if (!table_module->numTables) return say("module has no table", -2);
	IM3Table table = table_module->tables[0];
	if (slot < 0 || count < 0 || (u32) (slot + count) > table->size) {
		return say("table slot out of range", -3);
	}
	for (int i = 0; i < count; ++i) table->elements[slot + i] = NULL;
	return 0;
}

/*
 * Releases a module: unlinks it from the runtime, frees its structures and empties its slot.
 *
 * m3_LoadModule transfers ownership to the runtime and the header forbids m3_FreeModule afterwards,
 * because the runtime's list would dangle. Unlinking first is what makes the free legal, and it is
 * the same two-phase order Runtime_Release uses: drop the borrowed memory and table pointers so
 * m3_FreeModule cannot free a host's, then free.
 *
 * The caller must already have cleared any table slots pointing into this module; see
 * burrow_table_clear. Compiled code pages are NOT reclaimed - wasm3 gates that on
 * d_m3EnableCodePageRefCounting, which upstream leaves off - so they stay with the runtime.
 */
__attribute__((export_name("burrow_unload"))) int burrow_unload(int index) {
	errbuf[0] = 0;
	IM3Module mod = at(index);
	if (!mod) return say("bad module", -1);

	for (IM3Module* link = &rt->modules; *link; link = &(*link)->next) {
		if (*link == mod) {
			*link = mod->next;
			break;
		}
	}

	for (u32 i = 0; i < mod->numMemories; ++i) {
		if (mod->memories[i] && mod->memories[i]->owner != mod) mod->memories[i] = NULL;
	}
	for (u32 i = 0; i < mod->numTables; ++i) {
		if (mod->tables[i] && mod->tables[i]->owner != mod) mod->tables[i] = NULL;
	}

	if (rt->lastCalled && rt->lastCalled->module == mod) rt->lastCalled = NULL;

	for (int i = 0; i < trampolines_used; ++i) {
		if (trampoline_owner[i] != mod) continue;
		trampoline_owner[i] = NULL;
		reserved[i] = NULL;
		reserved_in[i] = NULL;
	}

	m3_FreeModule(mod);
	modules[index] = NULL;
	return 0;
}

/* the slot a function already occupies in a table, or -1; keeps one symbol to one pointer */
__attribute__((export_name("burrow_table_find"))) int burrow_table_find(
	int owner, int from, const char* name
) {
	IM3Module table_module = at(owner);
	IM3Module func_module = at(from);
	if (!table_module || !func_module || !table_module->numTables) return -1;
	IM3Function f;
	if (m3_FindFunctionIn(&f, func_module, name)) return -1;
	IM3Table table = table_module->tables[0];
	for (u32 i = 0; i < table->size; ++i) {
		if (table->elements[i] == (void*) f) return (int) i;
	}
	return -1;
}
