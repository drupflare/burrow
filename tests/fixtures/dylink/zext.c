/*
 * A dynamic library built against a real third-party dependency, for the runtimes lane.
 *
 * Built by tests/runtimes/dylink.spec.ts as `emcc -sUSE_ZLIB=1 -sSIDE_MODULE=1`, which links
 * zlib 1.3.2 into the .so and leaves libc as undefined imports for the loader to answer. What it
 * proves is not that a hand-written fixture round-trips: it is that an unmodified upstream library,
 * compiled the way anyone would compile one, links and runs with no code generation.
 */
#include <zlib.h>
#include <stdlib.h>

/* compresses in place into a caller-provided buffer, answering the packed length or a negative rc
 */
int ext_deflate(const unsigned char* in, int n, unsigned char* out, int cap) {
	uLongf packed = (uLongf) cap;
	int rc = compress2(out, &packed, in, (uLong) n, 9);
	return rc == Z_OK ? (int) packed : -rc;
}

int ext_inflate(const unsigned char* in, int n, unsigned char* out, int cap) {
	uLongf got = (uLongf) cap;
	int rc = uncompress(out, &got, in, (uLong) n);
	return rc == Z_OK ? (int) got : -rc;
}

unsigned long ext_crc(const unsigned char* in, int n) {
	return crc32(crc32(0L, Z_NULL, 0), in, (uInt) n);
}

int ext_bound(int n) {
	return (int) compressBound((uLong) n);
}
