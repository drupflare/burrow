#!/usr/bin/env bash
# Mines a fusion catalog from one or more guests' own profiles.
#
#   bash tools/interp/mine-catalog.sh <out.json> <guest.wasm>:<export>[:<i32 arg>...]...
#
# One guest gives that guest's own catalog; several give one catalog with each guest weighed
# equally. BUDGET (default 64) caps the catalog's entries and MAX_WIDTH (default 32) the operations
# in one entry. Build against the result with BURROW_FUSE_CATALOG=<out.json> tools/build-interp.sh.
# ARTIFACTS=<dir> keeps one guest's catalog there by its module hash (tools/interp/artifact.ts): a
# later run for the same module and tree takes it instead of profiling again.
#
# The shipped tools/interp/fuse-catalog.json is this over tools/interp/guests (built by its
# build.sh, run:1 each) with MAX_WIDTH=2 and BUDGET=1024, then prettier: short sequences are the
# ones that carry to a guest the catalog never saw.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: mine-catalog.sh <out.json> <guest.wasm>:<export>[:<arg>...]...}"
shift
[ $# -gt 0 ] || {
	echo "mine-catalog.sh: name at least one guest" >&2
	exit 2
}
GUEST="${1%%:*}"
if [ -n "${ARTIFACTS:-}" ] && [ $# -eq 1 ] && bun "$HERE/artifact.ts" load "$ARTIFACTS" "$GUEST" "$OUT"; then
	exit 0
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/burrow-mine.XXXXXX")"

BURROW_PROFILE=1 BURROW_INTERP_OUT="$WORK/profile.wasm" bash "$HERE/../build-interp.sh"

TRACES=()
i=0
for spec in "$@"; do
	IFS=: read -r -a parts <<< "$spec"
	bun "$HERE/trace.ts" "$WORK/profile.wasm" "${parts[0]}" "${parts[1]}" "${parts[@]:2}" \
		--out "$WORK/$i.txt" --widths "$WORK/$i.json"
	TRACES+=("$WORK/$i.txt" --widths "$WORK/$i.json")
	i=$((i + 1))
done

bun "$HERE/../seq-mine.ts" "${TRACES[@]}" --balance --budget "${BUDGET:-64}" \
	--max-width "${MAX_WIDTH:-32}" --out "$OUT"
echo "wrote $OUT"
if [ -n "${ARTIFACTS:-}" ] && [ $# -eq 1 ]; then bun "$HERE/artifact.ts" save "$ARTIFACTS" "$GUEST" "$OUT"; fi
