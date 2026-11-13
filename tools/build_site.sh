#!/bin/sh
# Assemble the published site in OUT: the pages and assets of this repository, plus the engine
# (a scrutate.wasm built from scrutate at COMMIT, which REF names: a release tag such as v0.1.0,
# or main) and engine.json, which tells the playground the engine's real size and source and
# names the commit of this repository the pages come from.
#
#   sh tools/build_site.sh OUT WASM COMMIT REF
set -eu
usage() { echo "usage: sh tools/build_site.sh OUT WASM COMMIT REF" >&2; exit 2; }
[ $# -eq 4 ] || usage
out=$1 wasm=$2 commit=$3 ref=$4
case $commit in
  *[!0-9a-f]*) commit= ;;
esac
[ ${#commit} -eq 40 ] || { echo "COMMIT must be a full 40-character scrutate commit hash" >&2; exit 2; }
case $ref in
  *[!A-Za-z0-9._-]*) echo "REF must be a release tag (v...) or main, not '$ref'" >&2; exit 2 ;;
  main | v[0-9]*) ;;
  *) echo "REF must be a release tag (v...) or main, not '$ref'" >&2; exit 2 ;;
esac
[ -s "$wasm" ] || { echo "no engine at $wasm" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd)
site=$(git -C "$here" rev-parse HEAD)
# OUT is deleted first, so only a new folder, an empty one or an earlier build is accepted
if [ -e "$out/.git" ] || { [ -d "$out" ] && [ "$(cd "$out" && pwd)" = "$here" ]; }; then
  echo "OUT is a git checkout; give an empty or new folder" >&2
  exit 2
fi
if [ -e "$out" ] && { [ ! -d "$out" ] || [ -n "$(ls -A "$out")" ]; } && [ ! -f "$out/playground/engine.json" ]; then
  echo "OUT exists and is not an earlier build; give an empty or new folder" >&2
  exit 2
fi
rm -rf "$out"
mkdir -p "$out"
cp -R "$here/index.html" "$here/robots.txt" "$here/sitemap.xml" "$here/assets" "$here/playground" "$out/"
cp "$wasm" "$out/playground/scrutate.wasm"
bytes=$(wc -c < "$wasm" | tr -d ' ')
printf '{"scrutate":"%s","ref":"%s","bytes":%s,"site":"%s"}\n' "$commit" "$ref" "$bytes" "$site" > "$out/playground/engine.json"
echo "$out: site with scrutate $ref at $commit ($bytes bytes)"
