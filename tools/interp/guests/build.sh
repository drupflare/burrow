#!/usr/bin/env bash
# Builds the four guests the default fusion catalog is mined from, into the directory given.
#
# Each is a standalone wasm exporting run(n), which does n rounds of its workload and answers a
# checksum. The libraries come from emscripten's own ports, which it fetches on first use.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build.sh <out-dir>}"
mkdir -p "$OUT"
CACHE="$(em-config CACHE)"
COMMON=(-O2 -sSTANDALONE_WASM=1 --no-entry -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576
	-sINITIAL_MEMORY=16777216 -sFILESYSTEM=0)

emcc "${COMMON[@]}" -sUSE_ZLIB=1 "$HERE/zlib.c" -o "$OUT/zlib.wasm"
emcc "${COMMON[@]}" -sUSE_LIBJPEG=1 "$HERE/jpeg.c" -o "$OUT/jpeg.wasm"

# lua and sqlite build from the port sources rather than the port libraries, so only fetch them
embuilder build sqlite3 contrib.lua > /dev/null 2>&1
LUA="$(ls -d "$CACHE"/ports/contrib.lua/lua-*/src | head -1)"
SQL="$(ls -d "$CACHE"/ports/sqlite3/sqlite-amalgamation-* | head -1)"

LUASRC=()
for f in "$LUA"/*.c; do
	case "$(basename "$f")" in lua.c | luac.c) ;; *) LUASRC+=("$f") ;; esac
done
# no setjmp: emscripten's needs JavaScript, and the workload never raises a Lua error
emcc "${COMMON[@]}" -I"$LUA" '-DLUAI_THROW(L,c)=__builtin_trap()' '-DLUAI_TRY(L,c,f,ud)=((f)(L,ud))' \
	"$HERE/lua.c" "${LUASRC[@]}" -o "$OUT/lua.wasm"

emcc "${COMMON[@]}" -I"$SQL" -DSQLITE_OS_OTHER=1 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION \
	-DSQLITE_TEMP_STORE=3 -DSQLITE_OMIT_WAL "$HERE/sqlite.c" "$SQL/sqlite3.c" -o "$OUT/sqlite.wasm"

echo "built $(ls "$OUT"/*.wasm | tr '\n' ' ')"
