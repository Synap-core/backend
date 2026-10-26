#!/usr/bin/env bash
# `synap install` / `update --from-source` must not silently destroy work.
#
# c6b343e6: sync_git_before_build ran `git fetch` + `git reset --hard
# origin/<branch>` with no look at the tree, so a contributor who cloned, edited
# and followed "Install from a clone" lost the edits. It now REFUSES when tracked
# files are modified or HEAD holds commits origin lacks, names what it found, and
# resets only on SYNAP_FORCE_GIT_SYNC=1 (a deploy checkout that is clean syncs as
# before).
# 738c7043: help screens print through `cat <<EOF`, which never interprets `\033`,
# so literal colour strings showed up as raw codes. The colours are real escape
# bytes now.
#
# Drives the REAL function (extracted from `synap` with awk, not copied) in
# throwaway repos. Does NOT drive the docker build that follows the sync.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# The function under test + the two helpers it calls, lifted from the installer.
awk '/^(is_git_repo|get_repo_root|sync_git_before_build)\(\) \{/{p=1} p{print} p&&/^}/{p=0}' "$HERE/synap" > "$TMP/fn.sh"
grep -q '^sync_git_before_build()' "$TMP/fn.sh" || { bad "could not extract sync_git_before_build"; exit 1; }
RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
# shellcheck disable=SC1091
. "$TMP/fn.sh"

git init -q -b main "$TMP/origin"
echo v1 > "$TMP/origin/file"; ( cd "$TMP/origin" && git add -A && git commit -qm v1 )
fresh() { rm -rf "$TMP/clone"; git clone -q "$TMP/origin" "$TMP/clone"; }
run() { ( cd "$TMP/clone" && unset SYNAP_UPDATE_SYNCED SYNAP_SKIP_GIT_SYNC; sync_git_before_build ) 2>&1; }

# 1. a dirty tracked file is refused and survives
fresh; echo "my edit" > "$TMP/clone/file"
out=$(run); rc=$?
[ "$rc" -ne 0 ] && ok "dirty tree: refused (rc=$rc)" || bad "dirty tree: reset ran (rc=0)"
[ "$(cat "$TMP/clone/file")" = "my edit" ] && ok "dirty tree: the edit is still on disk" || bad "dirty tree: the edit was destroyed"
grep -q 'SYNAP_FORCE_GIT_SYNC' <<<"$out" && ok "dirty tree: the message names the override" || bad "dirty tree: no override named: $out"

# 2. a local commit origin lacks is refused and survives
fresh; ( cd "$TMP/clone" && echo local > file && git commit -qam local )
before=$(git -C "$TMP/clone" rev-parse HEAD)
out=$(run); rc=$?
[ "$rc" -ne 0 ] && ok "unpushed commit: refused (rc=$rc)" || bad "unpushed commit: reset ran"
[ "$(git -C "$TMP/clone" rev-parse HEAD)" = "$before" ] && ok "unpushed commit: HEAD unchanged" || bad "unpushed commit: HEAD moved"

# 3. a clean checkout behind origin syncs, as before
fresh; ( cd "$TMP/origin" && echo v2 > file && git commit -qam v2 )
run >/dev/null; rc=$?
[ "$rc" -eq 0 ] && [ "$(cat "$TMP/clone/file")" = v2 ] && ok "clean tree: synced to origin" || bad "clean tree: not synced (rc=$rc)"

# 4. the override resets, and says what it discards first
fresh; echo "my edit" > "$TMP/clone/file"
out=$(cd "$TMP/clone" && SYNAP_FORCE_GIT_SYNC=1 sync_git_before_build 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ "$(cat "$TMP/clone/file")" = v2 ] && ok "override: reset to origin" || bad "override: not reset (rc=$rc)"
grep -q 'discarding' <<<"$out" && grep -q ' M file' <<<"$out" && ok "override: lists what it discards" || bad "override: silent: $out"

# 5. help screens: colours are real escape bytes, so a heredoc prints them as colour
help_out=$("$HERE/synap" install --help 2>&1 | head -5)
grep -q '\\033' <<<"$help_out" && bad "install --help prints a literal \\033" || ok "install --help has no literal \\033"
grep -q $'\033\\[' <<<"$help_out" && ok "install --help carries real escape bytes" || bad "install --help has no colour at all"
main_help=$("$HERE/synap" --help 2>&1 | head -5)
grep -q '\\033' <<<"$main_help" && bad "synap --help prints a literal \\033" || ok "synap --help has no literal \\033"
for v in RED GREEN YELLOW BLUE NC; do
  line=$(grep "^$v=" "$HERE/synap" | head -1)
  grep -q "^$v=\\$'" <<<"$line" || bad "colour $v is not an \$'...' escape: $line"
done

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
