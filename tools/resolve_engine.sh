#!/bin/sh
# Print the scrutate engine the playground should run, as "COMMIT REF".
#
#   sh tools/resolve_engine.sh           the newest release; before the first release, the newest
#                                         main commit whose ci.yml run passed
#   sh tools/resolve_engine.sh v0.1.0    that release (a rollback, or a test)
#   sh tools/resolve_engine.sh main      the newest main commit whose ci.yml run passed
#
# Needs the GitHub CLI; in a workflow, GH_TOKEN is the job's own token (public reads only).
set -eu
repo=scrutate/scrutate
want=${1:-}
if [ -z "$want" ]; then
  # 404 (with the error body on stdout) when nothing is released yet; drafts and prereleases are
  # never "latest"
  if tag=$(gh api "repos/$repo/releases/latest" --jq .tag_name 2>/dev/null) && [ -n "$tag" ]; then
    want=$tag
  else
    want=main
  fi
fi
case $want in
  main)
    commit=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1" \
      --jq '.workflow_runs[0].head_sha // empty')
    ;;
  v[0-9]*)
    # a release's tagged commit passed ci.yml: release.yml runs it before it publishes
    commit=$(gh api "repos/$repo/commits/$want" --jq .sha)
    ;;
  *)
    echo "the engine must be a release tag (v...) or main, not '$want'" >&2
    exit 2
    ;;
esac
[ -n "$commit" ] || { echo "no scrutate commit found for $want" >&2; exit 1; }
echo "$commit $want"
