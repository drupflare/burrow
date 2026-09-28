#include <string.h>
#include "sqlite3.h"
#include <emscripten.h>

/* SQLITE_OS_OTHER: a VFS that only has to serve an in-memory database */
static int rnd(sqlite3_vfs* v, int n, char* out) {
	(void) v;
	for (int i = 0; i < n; ++i) out[i] = (char) (i * 37 + 11);
	return n;
}
static int slp(sqlite3_vfs* v, int us) {
	(void) v;
	return us;
}
static int now(sqlite3_vfs* v, sqlite3_int64* t) {
	(void) v;
	*t = 210866760000000LL;
	return 0;
}
static int nowd(sqlite3_vfs* v, double* t) {
	(void) v;
	*t = 2440587.5;
	return 0;
}
static int opn(sqlite3_vfs* v, const char* z, sqlite3_file* f, int fl, int* o) {
	(void) v, (void) z, (void) f, (void) fl, (void) o;
	return SQLITE_CANTOPEN;
}
static int acc_(sqlite3_vfs* v, const char* z, int fl, int* r) {
	(void) v, (void) z, (void) fl;
	*r = 0;
	return 0;
}
static int full(sqlite3_vfs* v, const char* z, int n, char* o) {
	(void) v;
	strncpy(o, z, (size_t) n);
	return 0;
}
static int err(sqlite3_vfs* v, int n, char* o) {
	(void) v, (void) n, (void) o;
	return 0;
}
static sqlite3_vfs vfs = {1,	0, 256, 0, "mem", 0,   opn, 0,	  acc_,
						  full, 0, 0,	0, 0,	  rnd, slp, nowd, err};

int sqlite3_os_init(void) {
	(void) now;
	return sqlite3_vfs_register(&vfs, 1);
}
int sqlite3_os_end(void) {
	return 0;
}

static int step_all(sqlite3* db, const char* sql, long long* out) {
	sqlite3_stmt* st;
	if (sqlite3_prepare_v2(db, sql, -1, &st, 0) != SQLITE_OK) return -1;
	while (sqlite3_step(st) == SQLITE_ROW) *out = *out * 31 + sqlite3_column_int64(st, 0);
	sqlite3_finalize(st);
	return 0;
}

EMSCRIPTEN_KEEPALIVE int run(int n) {
	long long acc = 0;
	for (int k = 0; k < n; ++k) {
		sqlite3* db;
		if (sqlite3_open(":memory:", &db) != SQLITE_OK) return -1;
		sqlite3_exec(db, "create table t(a integer primary key, b text, c int)", 0, 0, 0);
		sqlite3_exec(db, "begin", 0, 0, 0);
		sqlite3_stmt* ins;
		sqlite3_prepare_v2(db, "insert into t(b, c) values (?, ?)", -1, &ins, 0);
		char buf[32];
		for (int i = 0; i < 3000; ++i) {
			int len = 0;
			unsigned v = (unsigned) i * 2654435761u;
			while (len < 12) {
				buf[len++] = (char) ('a' + (v % 26));
				v /= 7;
				if (!v) v = (unsigned) i + 99;
			}
			sqlite3_bind_text(ins, 1, buf, len, SQLITE_TRANSIENT);
			sqlite3_bind_int(ins, 2, (int) ((unsigned) i * 7919u % 1000u));
			sqlite3_step(ins);
			sqlite3_reset(ins);
		}
		sqlite3_finalize(ins);
		sqlite3_exec(db, "commit", 0, 0, 0);
		sqlite3_exec(db, "create index tc on t(c)", 0, 0, 0);
		if (step_all(db, "select sum(length(b)) + count(*) from t where c % 7 = 3", &acc))
			return -2;
		if (step_all(db, "select c * 1000 + count(*) from t group by c order by c limit 50", &acc))
			return -3;
		if (step_all(db, "select a from t where c between 100 and 140 order by b limit 40", &acc))
			return -4;
		if (step_all(db, "select count(*) from t x join t y on x.c = y.c where x.a < 300", &acc))
			return -5;
		sqlite3_close(db);
	}
	return (int) acc;
}
