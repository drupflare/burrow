#!/usr/bin/env bash
# Builds src/vendor/wasm3.wasm from wasm3 plus tools/interp/shim.c.
#
# The binary is committed, so this only runs when the shim or the pinned wasm3 changes. Re-run it
# and commit the result; do not edit the .wasm.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="${TMPDIR:-/tmp}/burrow-interp"
OUT="$ROOT/src/vendor/wasm3.wasm"

# pinned: an interpreter is the one dependency whose behaviour must not move under the benchmarks
WASM3_REPO="https://github.com/wasm3/wasm3.git"
WASM3_REF="${WASM3_REF:-main}"

command -v emcc > /dev/null || {
	echo "emcc not found. Install emscripten and re-run." >&2
	exit 1
}

mkdir -p "$WORK" "$(dirname "$OUT")"

if [ ! -d "$WORK/wasm3" ]; then
	git clone --depth 1 --branch "$WASM3_REF" "$WASM3_REPO" "$WORK/wasm3"
fi

SRC="$WORK/wasm3/source"
CORE=(
	"$SRC/m3_bind.c" "$SRC/m3_code.c" "$SRC/m3_compile.c" "$SRC/m3_core.c"
	"$SRC/m3_env.c" "$SRC/m3_exec.c" "$SRC/m3_function.c" "$SRC/m3_info.c"
	"$SRC/m3_module.c" "$SRC/m3_parse.c" "$SRC/m3_api_libc.c" "$SRC/m3_validate.c"
)

# -mtail-call: workerd supports the tail-call proposal, and wasm3's dispatch is built on musttail.
# STACK_SIZE must exceed d_m3MaxNativeStack (8 MiB - 128 KiB) or wasm3's stack-limit computation
# underflows and every guest call traps as a stack overflow before it runs an instruction.
emcc -O3 -DNDEBUG \
	-I"$SRC" \
	-Dd_m3HasWASI=0 -Dd_m3HasTracer=0 -Dd_m3HasUVWASI=0 \
	"${CORE[@]}" "$HERE/interp/shim.c" \
	-s STANDALONE_WASM=1 --no-entry \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=16777216 \
	-s STACK_SIZE=8388608 \
	-mtail-call \
	-s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
	-o "$OUT"

echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
