/*
 * An extension for host.c, built as `-s SIDE_MODULE`.
 *
 * Every cross-boundary shape a real extension uses is here: it allocates from the host's heap,
 * passes the host a pointer into its own static image, calls back into the host, and keeps mutable
 * state of its own across calls.
 */
extern int host_register(int value);
extern int host_sum(const char* s);
extern void* malloc(unsigned long n);
extern char* strcpy(char* d, const char* s);

static const char name[] = "ext_greeting";
static int state = 7;

int ext_install(void) {
	char* copy = (char*) malloc(sizeof(name));
	if (!copy) return -1;
	strcpy(copy, name);
	return host_register(host_sum(copy) + state);
}

const char* ext_name(void) {
	return name;
}

int ext_bump(int by) {
	state += by;
	return state;
}
