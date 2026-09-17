/* included verbatim into the generated m3_fuse.h; kept as C so an editor treats it as code */

#define BURROW_FUSE_MAXREC (1u << 20)

static pc_t* g_rec_pc;
static IM3Operation* g_rec_op;
static u32 g_rec_n;
static u32 g_fuse_patched;
static u32 g_fuse_total;
/* wasm3 compiles a function on its first call, so the stream grows and only the tail is ever new */
static u32 g_rec_done;

/* wasm3 calls this from EmitOp, so the operation stream is known before the guest runs */
void burrow_fuse_record(pc_t i_pc, void* i_op) {
	if (!g_rec_pc) {
		g_rec_pc = (pc_t*) malloc(sizeof(pc_t) * BURROW_FUSE_MAXREC);
		g_rec_op = (IM3Operation*) malloc(sizeof(IM3Operation) * BURROW_FUSE_MAXREC);
		if (!g_rec_pc || !g_rec_op) return;
	}
	if (g_rec_n >= BURROW_FUSE_MAXREC) return;
	g_rec_pc[g_rec_n] = i_pc;
	g_rec_op[g_rec_n] = (IM3Operation) i_op;
	g_rec_n++;
}

void burrow_fuse_reset(void) {
	g_rec_n = 0;
	g_rec_done = 0;
	g_fuse_patched = 0;
	g_fuse_total = 0;
}

/* read the op back out of the code page: wasm3 retro-patches pointers after EmitOp */
static IM3Operation fuse_at(pc_t i_base) {
	return (IM3Operation) * (void* const*) i_base;
}

static int fuse_match(u32 i_at, const BurrowFuse* i_e) {
	pc_t base = g_rec_pc[i_at];
	if (i_at + i_e->n > g_rec_n) return 0;
	for (u32 k = 0; k < i_e->n; ++k) {
		if (g_rec_pc[i_at + k] != base + i_e->off[k]) return 0;
		if (fuse_at(base + i_e->off[k]) != i_e->want[k]) return 0;
	}
	return 1;
}

/* overwrites the head of every matched tile with its fused handler; answers how many fired */
u32 burrow_fuse_apply(void) {
	if (!g_rec_pc || g_rec_done == g_rec_n) return 0;

	for (u32 i = g_rec_done; i < g_rec_n;) {
		u32 best = BURROW_FUSE_N;
		u8 bestn = 0;
		for (u32 e = 0; e < BURROW_FUSE_N; ++e) {
			const BurrowFuse* ent = &g_burrow_fuse[e];
			// longest tile wins, so a two-op match never shadows a longer one at the same position
			if (ent->n <= bestn) continue;
			if (fuse_at(g_rec_pc[i]) != ent->want[0]) continue;
			if (!fuse_match(i, ent)) continue;
			best = e;
			bestn = ent->n;
		}
		if (best == BURROW_FUSE_N) {
			++i;
			continue;
		}
		*(void**) g_rec_pc[i] = (void*) g_burrow_fuse[best].head;
		g_fuse_patched++;
		i += bestn;
	}
	g_rec_done = g_rec_n;
	g_fuse_total += g_fuse_patched;
	return g_fuse_patched;
}

u32 burrow_fuse_count(void) {
	return g_fuse_total;
}
