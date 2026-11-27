#!/usr/bin/env bash
# Apply the regenerated files a PR's CI run handed back, to the PR branch, in a
# sparse throwaway worktree: no build, little disk. Commits and pushes once.
#
#   scripts/ci/apply-ci-artifacts.sh <pr-number>
#
# Artifacts it knows (all produced by .github/workflows/ci.yml on a red):
#   reference-docs      -> docs/reference/
#   generated-api-types -> packages/api-types/src/generated.d.ts
#   mcp-generated       -> the MCP manifest and token-budget baseline
# Exit 3: no CI run for the PR's head yet. Exit 4: that run is still going.
# Never `gh pr merge`: the merge bot enqueues a PR once its checks are green.
set -euo pipefail
PR="${1:?usage: apply-ci-artifacts.sh <pr-number>}"
REPO="${REPO:-Synap-core/backend}"
ROOT="$(git rev-parse --show-toplevel)"
MCP=packages/api/src/routers/mcp
WT="$(mktemp -d)/pr-$PR"

read -r BRANCH SHA < <(gh pr view "$PR" -R "$REPO" --json headRefName,headRefOid -q '.headRefName+" "+.headRefOid')
RUN=$(gh run list -R "$REPO" --commit "$SHA" --limit 20 --json databaseId,name,event -q '[.[]|select(.name=="CI" and .event=="pull_request")][0].databaseId')
[ -n "$RUN" ] && [ "$RUN" != "null" ] || { echo "#$PR: no CI run for $SHA yet"; exit 3; }
[ "$(gh run view "$RUN" -R "$REPO" --json status -q .status)" = completed ] || { echo "#$PR: run $RUN is still going"; exit 4; }
ARTS=$(gh api "repos/$REPO/actions/runs/$RUN/artifacts" -q '.artifacts[].name')

cd "$ROOT"
git fetch -q origin "$BRANCH"
git worktree add -q --no-checkout --detach "$WT" "origin/$BRANCH"
trap 'cd "$ROOT"; git worktree remove --force "$WT" 2>/dev/null || true; git worktree prune' EXIT
cd "$WT"
git sparse-checkout set --no-cone docs/reference packages/api-types/src "$MCP"
git checkout -q --detach "origin/$BRANCH"

fetch() { local d; d=$(mktemp -d); gh run download "$RUN" -R "$REPO" -n "$1" -D "$d"; echo "$d"; }
if grep -qx reference-docs <<<"$ARTS"; then cp -R "$(fetch reference-docs)"/. docs/reference/; fi
if grep -qx generated-api-types <<<"$ARTS"; then
  f=$(find "$(fetch generated-api-types)" -name generated.d.ts | head -1); [ -n "$f" ] && cp "$f" packages/api-types/src/generated.d.ts
fi
if grep -qx mcp-generated <<<"$ARTS"; then
  d=$(fetch mcp-generated)
  cp "$d"/mcp-tools.manifest.json "$d"/token-budget.baseline.json "$MCP/tools/" 2>/dev/null || true
fi

if [ -z "$(git status --porcelain)" ]; then echo "#$PR: the artifacts change nothing"; exit 0; fi
git add -A docs/reference packages/api-types/src "$MCP"
git -c core.hooksPath=/dev/null commit -q -m "chore: regenerate generated files from CI's own run

Applies the artifacts run $RUN generated for the tree it tested (this branch
merged with main)."
git -c core.hooksPath=/dev/null push -q origin "HEAD:refs/heads/$BRANCH"
echo "#$PR: pushed $(git rev-parse --short HEAD) to $BRANCH"
