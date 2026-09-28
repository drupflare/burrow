#include <stdio.h>
#include <stdlib.h>
#include <jpeglib.h>
#include <emscripten.h>

#define W 192
#define H 192
static unsigned char img[W * H * 3];
static unsigned char dec[W * H * 3];

static void fill(void) {
	unsigned s = 777;
	for (int y = 0; y < H; ++y)
		for (int x = 0; x < W; ++x) {
			s = s * 1664525u + 1013904223u;
			unsigned char* p = &img[(y * W + x) * 3];
			p[0] = (unsigned char) (x + (s >> 28));
			p[1] = (unsigned char) (y * 2 + ((s >> 24) & 7));
			p[2] = (unsigned char) ((x ^ y) + ((s >> 20) & 3));
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
		struct jpeg_compress_struct c;
		struct jpeg_error_mgr e;
		unsigned char* buf = NULL;
		unsigned long len = 0;
		c.err = jpeg_std_error(&e);
		jpeg_create_compress(&c);
		jpeg_mem_dest(&c, &buf, &len);
		c.image_width = W;
		c.image_height = H;
		c.input_components = 3;
		c.in_color_space = JCS_RGB;
		jpeg_set_defaults(&c);
		jpeg_set_quality(&c, 85, TRUE);
		jpeg_start_compress(&c, TRUE);
		while (c.next_scanline < H) {
			JSAMPROW row = &img[c.next_scanline * W * 3];
			jpeg_write_scanlines(&c, &row, 1);
		}
		jpeg_finish_compress(&c);
		jpeg_destroy_compress(&c);

		struct jpeg_decompress_struct d;
		d.err = jpeg_std_error(&e);
		jpeg_create_decompress(&d);
		jpeg_mem_src(&d, buf, len);
		jpeg_read_header(&d, TRUE);
		jpeg_start_decompress(&d);
		while (d.output_scanline < d.output_height) {
			JSAMPROW row = &dec[d.output_scanline * W * 3];
			jpeg_read_scanlines(&d, &row, 1);
		}
		jpeg_finish_decompress(&d);
		jpeg_destroy_decompress(&d);
		free(buf);
		for (int i = 0; i < W * H * 3; i += 7) acc = acc * 33 + dec[i];
		acc += (unsigned) len;
	}
	return (int) acc;
}
