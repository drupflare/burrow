/*
 * A stand-in for a language runtime hosting extensions, built as `-s MAIN_MODULE`.
 *
 * It owns the heap and a registry that an extension writes into, which is the shape every real
 * extension ABI has: the extension allocates out of the runtime's allocator and hands back pointers
 * the runtime dereferences. That only works when both sit in one address space.
 */
#include <stdlib.h>
#include <string.h>

static int registry[64];
static int registered;

int host_register(int value) {
	if (registered >= 64) return -1;
	registry[registered] = value;
	return ++registered;
}

int host_registered(void) {
	return registered;
}

int host_slot(int i) {
	return (i >= 0 && i < registered) ? registry[i] : -1;
}

/* reads a string the extension owns, which is the check that the two share an address space */
int host_sum(const char* s) {
	int n = 0;
	while (*s) n += (unsigned char) *s++;
	return n;
}

int main(void) {
	return 0;
}
