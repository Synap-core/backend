#!/usr/bin/env bash
# Guard: migrations are FORWARD-ONLY (expand/contract). A failed update rolls
# back images only (`_ue_rollback` in synap), so the previous release runs on
# the newer schema; a migration that has not shipped may not DROP a table or
# column, RENAME, change a column TYPE or SET NOT NULL unless it carries
#   -- synap:contract-of <earlier migration>.sql
# naming an expand step that IS in the newest release tag.
# The checker: scripts/check-migrations-forward-only.mjs (its header lists what
# it cannot see). This file runs it on THIS tree, then on fixture repos that
# pin each rule — including a shallow, tagless clone (the CI checkout's shape),
# so the baseline is proven to come from origin's tags, not from local ones.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$HERE/scripts/check-migrations-forward-only.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v node >/dev/null 2>&1 || { echo "FAIL - node is required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "FAIL - git is required"; exit 1; }
G() { git -c user.email=t@t -c user.name=t -c init.defaultBranch=main "$@"; }

# ── 1. this tree ──────────────────────────────────────────────────────────────
out="$(cd "$HERE" && node "$CHECK" 2>&1)"; rc=$?
shipped="$(sed -n 's/.* — \([0-9]*\) shipped;.*/\1/p' <<<"$out")"
if [ "$rc" = 0 ] && [ "${shipped:-0}" -ge 100 ]; then
    ok "this tree: no unmarked destructive migration ($(head -1 <<<"$out"))"
else
    bad "this tree: rc=$rc"; printf '%s\n' "$out" | sed 's/^/      /'
fi

# ── fixtures ──────────────────────────────────────────────────────────────────
M=packages/database/migrations
# repo <dir>: v1.0.0 ships 0001_init (with a DROP TABLE of its own: released
# history is never re-judged) and 0002_expand.
repo() {
    rm -rf "$1"; mkdir -p "$1/$M"
    printf 'CREATE TABLE t (id int, old_col text);\nDROP TABLE IF EXISTS legacy;\n' > "$1/$M/0001_init.sql"
    printf 'ALTER TABLE t ADD COLUMN IF NOT EXISTS new_col text;\n' > "$1/$M/0002_expand.sql"
    ( cd "$1" && G init -q && G add -A && G commit -qm v1 && G tag v1.0.0 )
}
R="$TMP/r"
expect() { # <rc> <label> <file> <content> [grep-in-output]
    repo "$R"; printf '%b' "$4" > "$R/$M/$3"
    out="$(node "$CHECK" --repo "$R" 2>&1)"; rc=$?
    if [ "$rc" = "$1" ] && { [ -z "${5:-}" ] || grep -qF -- "$5" <<<"$out"; }; then ok "$2"
    else bad "$2 (rc=$rc, want $1${5:+, output containing '$5'})"; printf '%s\n' "$out" | sed 's/^/      /'; fi
}

# 2. every destructive kind is seen (the non-vacuity floor: a literal sample of
#    each thing the scan hunts must turn it red)
expect 1 "sees DROP TABLE"                0003_x.sql 'DROP TABLE t;\n'                                  "DROP TABLE"
expect 1 "sees DROP COLUMN"               0003_x.sql 'ALTER TABLE t DROP COLUMN old_col;\n'             "DROP COLUMN"
expect 1 "sees DROP <col> (COLUMN omitted)" 0003_x.sql 'ALTER TABLE ONLY t DROP IF EXISTS old_col;\n'   "DROP COLUMN"
expect 1 "sees a DROP COLUMN after a comma, on its own line" 0003_x.sql 'ALTER TABLE t\n  ADD COLUMN a int,\n  DROP COLUMN old_col;\n' "0003_x.sql:3 DROP COLUMN"
expect 1 "sees RENAME COLUMN"             0003_x.sql 'ALTER TABLE t RENAME COLUMN old_col TO c;\n'      "RENAME"
expect 1 "sees RENAME TO (table)"         0003_x.sql 'ALTER TABLE t RENAME TO t2;\n'                    "RENAME"
expect 1 "sees ALTER COLUMN … TYPE"       0003_x.sql 'ALTER TABLE t ALTER COLUMN id TYPE bigint;\n'     "column TYPE change"
expect 1 "sees ALTER … SET DATA TYPE"     0003_x.sql 'ALTER TABLE t ALTER "id" SET DATA TYPE bigint;\n' "column TYPE change"
expect 1 "sees SET NOT NULL"              0003_x.sql 'ALTER TABLE t ALTER COLUMN old_col SET NOT NULL;\n' "SET NOT NULL"
expect 1 "sees a DROP COLUMN inside EXECUTE '…'" 0003_x.sql "DO \$\$ BEGIN EXECUTE 'ALTER TABLE t DROP COLUMN old_col'; END \$\$;\n" "DROP COLUMN"
expect 1 "sees a DROP TABLE inside a DO \$\$ block" 0003_x.sql 'DO $$\nBEGIN\n  -- tidy up\n  DROP TABLE t;\nEND $$;\n' "0003_x.sql:4 DROP TABLE"

# 3. look-alikes and prose stay green
expect 0 "a comment that mentions DROP TABLE is not a statement" 0003_x.sql '-- we used to DROP TABLE t here\n/* and RENAME it, /* nested */ SET NOT NULL */\nSELECT 1;\n'
expect 0 "a -- comment inside a DO \$\$ block is stripped"     0003_x.sql 'DO $$\nBEGIN\n  -- never DROP TABLE t\n  PERFORM 1;\nEND $$;\n'
expect 0 "DROP INDEX / CONSTRAINT / NOT NULL / DEFAULT are not column drops" 0003_x.sql 'DROP INDEX IF EXISTS i;\nALTER TABLE t DROP CONSTRAINT IF EXISTS c;\nALTER TABLE t ALTER COLUMN old_col DROP NOT NULL, ALTER COLUMN id DROP DEFAULT;\n'
expect 0 "ADD COLUMN … NOT NULL DEFAULT and ALTER TYPE … ADD VALUE are additive" 0003_x.sql "ALTER TABLE t ADD COLUMN n int NOT NULL DEFAULT 0;\nALTER TYPE kind ADD VALUE IF NOT EXISTS 'x';\n"
expect 0 "'--' inside a string is not a comment" 0003_x.sql "INSERT INTO t (old_col) VALUES ('a -- b');\n"

# 4. the contract marker
expect 0 "a contract step naming a SHIPPED expand passes" 0003_x.sql '-- synap:contract-of 0002_expand.sql\nALTER TABLE t DROP COLUMN old_col;\n'
expect 1 "a marker naming an expand that has NOT shipped is refused" 0003_x.sql '-- synap:contract-of 0004_later.sql\nALTER TABLE t DROP COLUMN old_col;\n' "no such migration"
repo "$R"; printf 'ALTER TABLE t ADD COLUMN c2 text;\n' > "$R/$M/0003_expand2.sql"
printf -- '-- synap:contract-of 0003_expand2.sql\nALTER TABLE t DROP COLUMN old_col;\n' > "$R/$M/0004_contract.sql"
out="$(node "$CHECK" --repo "$R" 2>&1)"; rc=$?
[ "$rc" = 1 ] && grep -qF "it has not shipped yet" <<<"$out" \
  && ok "expand and contract in the same unreleased batch is refused (the expand has not shipped)" || { bad "same-batch contract: rc=$rc"; printf '%s\n' "$out" | sed 's/^/      /'; }

# 5. "not shipped" is a SET DIFFERENCE with the release, not "numbered after it"
expect 1 "a late-merged migration numbered BELOW the released ones is still judged" 0001b_late.sql 'DROP TABLE t;\n' "0001b_late.sql"

# 6. the baseline is the newest v* tag by VERSION (v1.10.0 > v1.9.0)
repo "$R"
( cd "$R" && G tag v0.9.0 HEAD && printf 'ALTER TABLE t DROP COLUMN old_col;\n' > "$M/0003_drop.sql" && G add -A && G commit -qm v1.10 && G tag v1.10.0 \
  && G checkout -q v1.0.0 2>/dev/null && G tag v1.9.0 && G checkout -q main )
out="$(node "$CHECK" --repo "$R" 2>&1)"; rc=$?
[ "$rc" = 0 ] && grep -q "v1.10.0" <<<"$out" && ok "baseline = newest tag by version (v1.10.0, not lexical v1.9.0)" || { bad "version order: rc=$rc"; printf '%s\n' "$out" | sed 's/^/      /'; }

# 7. CI shape: a shallow clone with NO tags — the baseline comes from origin
repo "$TMP/origin-src"; printf 'ALTER TABLE t ADD COLUMN x int;\n' > "$TMP/origin-src/$M/0003_x.sql"
printf 'ALTER TABLE t RENAME COLUMN old_col TO c;\n' > "$TMP/origin-src/$M/0004_rename.sql"
( cd "$TMP/origin-src" && G add -A && G commit -qm next )
G clone -q --bare "$TMP/origin-src" "$TMP/origin.git"
G clone -q --depth=1 --no-tags "file://$TMP/origin.git" "$TMP/ci"
[ -z "$(git -C "$TMP/ci" tag -l)" ] && ok "fixture: the CI-shaped clone has no tags" || bad "fixture: the CI-shaped clone has tags"
out="$(node "$CHECK" --repo "$TMP/ci" 2>&1)"; rc=$?
[ "$rc" = 1 ] && grep -q "v1.0.0 (newest v\* tag, origin)" <<<"$out" && grep -qF "0004_rename.sql:1 RENAME" <<<"$out" && ! grep -q "0001_init" <<<"$out" \
  && ok "CI shape: the baseline is read from origin's tags and fetched; the unshipped RENAME is caught" || { bad "CI shape: rc=$rc"; printf '%s\n' "$out" | sed 's/^/      /'; }

# 8. no baseline is never a pass
repo "$R"; ( cd "$R" && G tag -d v1.0.0 >/dev/null )
out="$(node "$CHECK" --repo "$R" 2>&1)"; rc=$?
[ "$rc" = 2 ] && grep -q "no v\* release tag" <<<"$out" && ok "no release tag anywhere → exit 2 (cannot check), never 0" || { bad "no tag: rc=$rc"; printf '%s\n' "$out" | sed 's/^/      /'; }
mkdir -p "$TMP/nogit/$M"; : > "$TMP/nogit/$M/0001.sql"
out="$(node "$CHECK" --repo "$TMP/nogit" 2>&1)"; rc=$?
[ "$rc" = 2 ] && ok "not a git checkout → exit 2 (cannot check), never 0" || { bad "no git: rc=$rc"; printf '%s\n' "$out" | sed 's/^/      /'; }

exit $fail
