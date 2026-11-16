#!/usr/bin/env bash
# ============================================================================
# `_pgs_fp_accepts`: a restored count is checked against the dump's RANGE, not
# one moving number. Pins the 2026-11-16 false RED: the backup drill recorded
# 52|11702|162 (read after the dumps) and restored 52|11701|162, because the pod
# wrote an entity while pg_dump ran; `.drill-failed` then stopped every update.
#
# Also pins the wiring: the dump records fingerprint.before, and the three
# places that compare a restore (drill, fresh-host restore, `synap restore`)
# go through the one helper, never a bare string compare.
# ============================================================================
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAFETY="${FPR_TEST_SAFETY:-$SCRIPT_DIR/../pgdata-safety.sh}"
SYNAP="${FPR_TEST_SYNAP:-$SCRIPT_DIR/../../synap}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $*"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $*"; }

# shellcheck disable=SC1090
. "$SAFETY"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT

# case <name> <after (fingerprint)> <before (fingerprint.before, "-" = none)> <got> <accept|refuse>
case_() {
  local name="$1" after="$2" before="$3" got="$4" want="$5" d="$T/$RANDOM$RANDOM"
  mkdir -p "$d"; printf '%s\n' "$after" > "$d/fingerprint"
  [ "$before" = "-" ] || printf '%s\n' "$before" > "$d/fingerprint.before"
  if _pgs_fp_accepts "$d" "$got"; then r=accept; else r=refuse; fi
  [ "$r" = "$want" ] && ok "$name → $r" || bad "$name: wanted $want, got $r (after=$after before=$before got=$got)"
}

echo "── the range"
case_ "the founder's pod: write during the dump (restored 11701, recorded 11702, before 11701)" "52|11702|162" "52|11701|162" "52|11701|162" accept
case_ "restored equals the recorded count"                     "5|100|1" "5|98|1"  "5|100|1" accept
case_ "restored in the middle of the range"                    "5|100|1" "5|98|1"  "5|99|1"  accept
case_ "restored at the low end"                                "5|100|1" "5|98|1"  "5|98|1"  accept
case_ "a delete during the dump (range runs downward)"         "5|98|1"  "5|100|1" "5|99|1"  accept
case_ "restored below the range: rows are missing"             "5|100|1" "5|98|1"  "5|97|1"  refuse
case_ "restored above the range: rows that were never there"   "5|100|1" "5|98|1"  "5|101|1" refuse
case_ "a different user count outside the range"               "5|100|1" "5|100|1" "4|100|1" refuse
case_ "api_keys outside the range"                             "5|100|2" "5|100|1" "5|100|3" refuse

echo "── no range recorded, or nothing read"
case_ "older dump (no fingerprint.before): exact match passes" "5|100|1" "-"       "5|100|1" accept
case_ "older dump: a difference of one is still RED"           "5|100|1" "-"       "5|99|1"  refuse
case_ "restored count unreadable"                              "5|100|1" "5|98|1"  ""        refuse
case_ "restored count is not numbers"                          "5|100|1" "5|98|1"  "5|x|1"   refuse
case_ "fields missing from the restored count"                 "5|100|1" "5|98|1"  "5|99"    refuse
case_ "before has the wrong shape"                             "5|100|1" "5|98"    "5|99|1"  refuse

echo "── wiring"
d="$T/nodump"; mkdir -p "$d"
printf '%s\n' "$(sed -n '/^_pgs_dump_into()/,/^}/p' "$SAFETY")" > "$T/dump-fn"
first_fp="$(grep -n '_pgs_fingerprint' "$T/dump-fn" | head -1 | cut -d: -f1)"
first_dump="$(grep -n 'pg_dump' "$T/dump-fn" | head -1 | cut -d: -f1)"
grep -q 'fingerprint.before' "$T/dump-fn" && [ "$first_fp" -lt "$first_dump" ] \
  && ok "the dump reads the count before its first pg_dump" || bad "fingerprint.before not written before the first pg_dump"
n="$(grep -c '_pgs_fp_accepts' "$SAFETY")"
[ "$n" -ge 3 ] && ok "drill and fresh-host restore compare through _pgs_fp_accepts ($n uses)" || bad "pgdata-safety.sh uses the helper $n times"
grep -q '_pgs_fp_accepts "\$target"' "$SYNAP" && ok "synap restore compares through _pgs_fp_accepts" || bad "synap restore still compares by string"
# The helper's own exact-match line is the one allowed compare; the sha256 checks in
# `synap` are a different thing.
! grep -nE '"\$got" (!)?= "\$expected"' "$SAFETY" >/dev/null && ! grep -nE '"\$got" != "\$want" \]; then' "$SYNAP" >/dev/null \
  && ok "no bare string compare of a restored fingerprint is left" \
  || bad "bare compare: $(grep -nE '"\$got" (!)?= "\$expected"' "$SAFETY"; grep -nE '"\$got" != "\$want" \]; then' "$SYNAP")"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
