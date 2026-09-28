#include <zlib.h>
#include <emscripten.h>

#define N (1 << 17)
static unsigned char src[N], comp[N + N / 2], out[N];

static void fill(void) {
	unsigned s = 12345;
	const char* words[] = {"alpha ",  "beta ", "gamma ", "delta ",
						   "burrow ", "wasm ", "edge ",	 "slot "};
	int i = 0;
	while (i < N) {
		s = s * 1664525u + 1013904223u;
		const char* w = words[(s >> 24) & 7];
		while (*w && i < N) src[i++] = (unsigned char) *w++;
		if (((s >> 16) & 15) == 0 && i < N) src[i++] = (unsigned char) (s & 0xff);
	}
}

EMSCRIPTEN_KEEPALIVE int run(int n) {
	static int filled;
	if (!filled) {
		fill();
		filled = 1;
	}
	unsigned acc = 0;
	for (int k = 0; k < n; ++k) {
		uLongf cl = sizeof(comp);
		if (compress2(comp, &cl, src, N, 6) != Z_OK) return -1;
		uLongf ol = sizeof(out);
		if (uncompress(out, &ol, comp, cl) != Z_OK) return -2;
		acc = acc * 31 + (unsigned) crc32(0, out, (uInt) ol) + (unsigned) cl;
	}
	return (int) acc;
}
