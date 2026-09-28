/* included into m3_compile.c after m3_fuse.h in a BURROW_PROFILE build; counts dispatches per pc */

#define BURROW_PROF_BITS 20
#define BURROW_PROF_MASK ((1u << BURROW_PROF_BITS) - 1)

static u32* g_prof_key;
static u32* g_prof_count;
static double g_prof_total;
int g_prof_nofuse;

/* every dispatch lands here, through the patched nextOpDirect and jumpOpDirect */
void burrow_prof_hit(pc_t i_pc) {
	if (!g_prof_key) {
		g_prof_key = (u32*) calloc(1u << BURROW_PROF_BITS, sizeof(u32));
		g_prof_count = (u32*) calloc(1u << BURROW_PROF_BITS, sizeof(u32));
		if (!g_prof_key || !g_prof_count) abort();
	}
	u32 k = (u32) (uintptr_t) i_pc;
	u32 h = (k * 2654435761u) >> (32 - BURROW_PROF_BITS);
	while (g_prof_key[h] && g_prof_key[h] != k) h = (h + 1) & BURROW_PROF_MASK;
	g_prof_key[h] = k;
	g_prof_count[h]++;
	g_prof_total += 1;
}

__attribute__((export_name("burrow_prof_count"))) u32 burrow_prof_count(u32 i_pc) {
	if (!g_prof_key) return 0;
	u32 h = (i_pc * 2654435761u) >> (32 - BURROW_PROF_BITS);
	while (g_prof_key[h] && g_prof_key[h] != i_pc) h = (h + 1) & BURROW_PROF_MASK;
	return g_prof_key[h] == i_pc ? g_prof_count[h] : 0;
}

__attribute__((export_name("burrow_prof_total"))) double burrow_prof_total(void) {
	return g_prof_total;
}

__attribute__((export_name("burrow_prof_reset"))) void burrow_prof_reset(void) {
	if (g_prof_count) memset(g_prof_count, 0, sizeof(u32) << BURROW_PROF_BITS);
	g_prof_total = 0;
}

/* 1 profiles the stream the compiler emitted, 0 the one left after fusion */
__attribute__((export_name("burrow_prof_nofuse"))) void burrow_prof_set_nofuse(int i_on) {
	g_prof_nofuse = i_on;
}

__attribute__((export_name("burrow_prof_sites"))) u32 burrow_prof_sites(void) {
	return g_rec_n;
}

__attribute__((export_name("burrow_prof_site_pc"))) u32 burrow_prof_site_pc(u32 i) {
	return (u32) (uintptr_t) g_rec_pc[i];
}

/* the handler at the site now, so a retro-patched op reads as what actually runs */
__attribute__((export_name("burrow_prof_site_op"))) u32 burrow_prof_site_op(u32 i) {
	return (u32) (uintptr_t) fuse_at(g_rec_pc[i]);
}
