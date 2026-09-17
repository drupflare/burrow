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

# pinned to a SHA: an interpreter is the one dependency whose behaviour must not move under the
# benchmarks, and a branch name moves
WASM3_REPO="https://github.com/wasm3/wasm3.git"
WASM3_REF="${WASM3_REF:-deeaca9ce815565478ab854e0db9046a479c92ff}"

command -v emcc > /dev/null || {
	echo "emcc not found. Install emscripten and re-run." >&2
	exit 1
}

# wabt 1.0.41 rejects call_indirect against a typed table, so the retype step needs wasm-tools
command -v wasm-tools > /dev/null || {
	echo "wasm-tools not found. brew install wasm-tools and re-run." >&2
	exit 1
}

mkdir -p "$WORK" "$(dirname "$OUT")"

# the cached clone is reused across builds, so re-checkout every time or a stale tree silently wins
if [ ! -d "$WORK/wasm3/.git" ]; then
	git init -q "$WORK/wasm3"
	git -C "$WORK/wasm3" remote add origin "$WASM3_REPO"
fi
git -C "$WORK/wasm3" fetch -q --depth 1 origin "$WASM3_REF"
git -C "$WORK/wasm3" -c advice.detachedHead=false checkout -q --force FETCH_HEAD

SRC="$WORK/wasm3/source"

# folds a loop's affine induction update into its back edge; upstream has no equivalent, and the
# forced checkout above reverts it so re-running stays idempotent
patch -s -p1 -d "$SRC" < "$HERE/interp/wasm3-fold-loop-back-edge.patch"
patch -s -p1 -d "$SRC" < "$HERE/interp/wasm3-fuse-hook.patch"

# one handler per catalog tile, running its operations with no dispatch between them
node "$HERE/interp/gen-fuse.mjs" "$HERE/interp/fuse-catalog.json" "$SRC/m3_exec.h" "$SRC/m3_fuse.h"

# appended rather than patched: it has to land after every opcode, and the tail moves as patches apply
printf '\n#if d_m3Fuse\n#include "m3_fuse.h"\n#endif\n' >> "$SRC/m3_compile.c"

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
	-Dd_m3HasWASI=0 -Dd_m3HasTracer=0 -Dd_m3HasUVWASI=0 -Dd_m3Fuse=1 \
	"${CORE[@]}" "$HERE/interp/shim.c" \
	-s STANDALONE_WASM=1 --no-entry \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=16777216 \
	-s STACK_SIZE=8388608 \
	-mtail-call \
	-s EXPORTED_FUNCTIONS='["_malloc","_free"]' \
	-o "$OUT"

# emcc cannot emit a typed dispatch table; LLVM has no function-references target feature
wasm-tools print "$OUT" -o "$WORK/interp.wat"
node "$HERE/interp/typed-dispatch.mjs" "$WORK/interp.wat" "$WORK/interp-typed.wat"
wasm-tools parse "$WORK/interp-typed.wat" -o "$OUT"

echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
