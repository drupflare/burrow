#!/usr/bin/env bash
# Builds src/vendor/wasm3.wasm from wasm3 plus tools/interp/shim.c.
#
# The binary is committed, so this only runs when the shim or the pinned wasm3 changes. Re-run it
# and commit the result; do not edit the .wasm.
#
# Three variables change what it builds, and the committed binary uses none of them:
#
#   BURROW_INTERP_OUT     where the binary goes, instead of src/vendor/wasm3.wasm
#   BURROW_FUSE_CATALOG   the fusion catalog, instead of tools/interp/fuse-catalog.json
#   BURROW_PROFILE=1      a build that counts dispatches per site, for tools/interp/trace.ts; it
#                         also writes <out>.fusible.json, the operations a catalog tile may hold
#
# A per-guest catalog is those three in turn: a profile build, a trace of the guest, the trace
# mined by tools/seq-mine.ts, and a build against what it mined.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="${TMPDIR:-/tmp}/burrow-interp"
OUT="${BURROW_INTERP_OUT:-$ROOT/src/vendor/wasm3.wasm}"
CATALOG="${BURROW_FUSE_CATALOG:-$HERE/interp/fuse-catalog.json}"
PROFILE="${BURROW_PROFILE:-0}"

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

# the cached clone is reused across builds, so re-checkout every time or a stale tree silently wins;
# a temp cleaner can leave it half deleted, which the -d test alone would take for a clone
if [ ! -d "$WORK/wasm3/.git" ] || ! git -C "$WORK/wasm3" rev-parse -q --verify HEAD > /dev/null 2>&1; then
	git init -q "$WORK/wasm3"
	git -C "$WORK/wasm3" remote remove origin 2> /dev/null || true
	git -C "$WORK/wasm3" remote add origin "$WASM3_REPO"
fi
git -C "$WORK/wasm3" fetch -q --depth 1 origin "$WASM3_REF"
git -C "$WORK/wasm3" -c advice.detachedHead=false checkout -q --force FETCH_HEAD

SRC="$WORK/wasm3/source"

# folds a loop's affine induction update into its back edge; upstream has no equivalent, and the
# forced checkout above reverts it so re-running stays idempotent
patch -s -p1 -d "$SRC" < "$HERE/interp/wasm3-fold-loop-back-edge.patch"
patch -s -p1 -d "$SRC" < "$HERE/interp/wasm3-fuse-hook.patch"
# a register spill written by the op that produced the value, or not written at all after a tee
patch -s -p1 -d "$SRC" < "$HERE/interp/wasm3-fold-spill.patch"

# one handler per catalog tile, running its operations with no dispatch between them
node "$HERE/interp/gen-fuse.mjs" "$CATALOG" "$SRC/m3_exec.h" "$SRC/m3_fuse.h"

# appended rather than patched: it has to land after every opcode, and the tail moves as patches apply
printf '\n#if d_m3Fuse\n#include "m3_fuse.h"\n#endif\n' >> "$SRC/m3_compile.c"

CORE=(
	"$SRC/m3_bind.c" "$SRC/m3_code.c" "$SRC/m3_compile.c" "$SRC/m3_core.c"
	"$SRC/m3_env.c" "$SRC/m3_exec.c" "$SRC/m3_function.c" "$SRC/m3_info.c"
	"$SRC/m3_module.c" "$SRC/m3_parse.c" "$SRC/m3_api_libc.c" "$SRC/m3_validate.c"
)

# -ffile-prefix-map keeps the build directory out of wasm3's __FILE__ strings, so the binary does
# not depend on where it was built
CFLAGS=(
	-O3 -DNDEBUG -I"$SRC" "-ffile-prefix-map=$SRC=wasm3"
	-Dd_m3HasWASI=0 -Dd_m3HasTracer=0 -Dd_m3HasUVWASI=0 -Dd_m3Fuse=1 -mtail-call
)
# -mtail-call: workerd supports the tail-call proposal, and wasm3's dispatch is built on musttail.
# STACK_SIZE must exceed d_m3MaxNativeStack (8 MiB - 128 KiB) or wasm3's stack-limit computation
# underflows and every guest call traps as a stack overflow before it runs an instruction.
LDFLAGS=(
	-sSTANDALONE_WASM=1 --no-entry
	-sALLOW_MEMORY_GROWTH=1
	-sINITIAL_MEMORY=16777216
	-sSTACK_SIZE=8388608
	-mtail-call
	-sEXPORTED_FUNCTIONS='["_malloc","_free"]'
)

if [ "$PROFILE" = 1 ]; then
	patch -s -p1 -d "$SRC" < "$HERE/interp/wasm3-profile-dispatch.patch"
	printf '\n#include "%s"\n' "$HERE/interp/profile.inc" >> "$SRC/m3_compile.c"
	node "$HERE/interp/gen-fuse.mjs" --list "$SRC/m3_exec.h" > "${OUT%.wasm}.fusible.json"
	# linked unoptimised: binaryen merges handlers with identical bodies, and two operations that
	# share one function would share one name in the trace
	OBJS=()
	for f in "${CORE[@]}" "$HERE/interp/shim.c"; do
		emcc "${CFLAGS[@]}" -Dd_burrowProfile=1 -c "$f" -o "$WORK/$(basename "$f" .c).o"
		OBJS+=("$WORK/$(basename "$f" .c).o")
	done
	emcc -O0 --profiling-funcs "${OBJS[@]}" "${LDFLAGS[@]}" -o "$OUT"
else
	emcc "${CFLAGS[@]}" "${CORE[@]}" "$HERE/interp/shim.c" "${LDFLAGS[@]}" -o "$OUT"

	# emcc cannot emit a typed dispatch table; LLVM has no function-references target feature
	wasm-tools print "$OUT" -o "$WORK/interp.wat"
	node "$HERE/interp/typed-dispatch.mjs" "$WORK/interp.wat" "$WORK/interp-typed.wat"
	wasm-tools parse "$WORK/interp-typed.wat" -o "$OUT"
fi

echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
