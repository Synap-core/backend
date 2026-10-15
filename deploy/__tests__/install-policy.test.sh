#!/usr/bin/env bash
# `synap policy` — the owner's pod-agent consent file (SECURITY-PLAN-R1 D3).
# Daemon-free: the real CLI against a throwaway deploy dir (no docker is called).
#   show              default when absent, effective refusals, recipients
#   set-mode          managed | self-hosted only; keeps every other key (refuse)
#   add/remove        age recipients: validated like deploy/pod-agent/policy.js,
#                     deduplicated, idempotent; a malformed one writes nothing
#   unusable file     refused, never overwritten (a typo is the owner's to fix)
#   reader parity     what the CLI writes is what pod-agent's readPodAgentPolicy accepts
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required"; exit 1; }

ROOT="$TMP/opt"; DEPLOY="$ROOT/deploy"; F="$DEPLOY/state/pod-agent-policy.json"
mkdir -p "$DEPLOY/state"; cp "$HERE/synap" "$ROOT/synap"
cp "$HERE/deploy/"*.sh "$HERE/deploy/env.schema" "$HERE/deploy/docker-compose.yml" "$HERE/deploy/Caddyfile" "$DEPLOY/"
R1="age1$(printf 'q%.0s' $(seq 1 58))"; R2="age1$(printf 'p%.0s' $(seq 1 58))"
pol() { ( cd "$ROOT" && SYNAP_DEPLOY_DIR="$DEPLOY" bash "$ROOT/synap" policy "$@" ) >"$TMP/out" 2>&1 </dev/null; }
filemode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

pol show; rc=$?
[ "$rc" = 0 ] && grep -q 'mode: self-hosted' "$TMP/out" && grep -q 'archive, restore-archive, configure (mode default)' "$TMP/out" && [ ! -e "$F" ] \
  && ok "show: no file → the self-hosted default, and show creates nothing" || { bad "show default rc=$rc"; cat "$TMP/out"; }

pol set-mode managed; rc=$?
[ "$rc" = 0 ] && [ "$(jq -r .mode "$F")" = managed ] && [ "$(filemode "$F")" = 644 ] \
  && ok "set-mode managed: creates the file (0644)" || { bad "set-mode managed rc=$rc"; cat "$TMP/out"; }
pol show; grep -q 'refuse: (nothing) (mode default)' "$TMP/out" && ok "show: managed refuses nothing" || { bad "show managed"; cat "$TMP/out"; }

pol set-mode public; rc=$?
[ "$rc" != 0 ] && [ "$(jq -r .mode "$F")" = managed ] && ok "set-mode: an unknown mode is refused, file unchanged" || bad "set-mode accepted 'public'"
pol set-mode; [ $? != 0 ] && ok "set-mode: no argument is refused" || bad "set-mode without argument accepted"

pol add-recipient "$R1"; rc=$?
[ "$rc" = 0 ] && [ "$(jq -c .archiveRecipients "$F")" = "[\"$R1\"]" ] && ok "add-recipient: recorded" || { bad "add-recipient rc=$rc"; cat "$TMP/out"; }
pol add-recipient "$R1"; pol add-recipient "$R2"
[ "$(jq -c .archiveRecipients "$F")" = "[\"$R1\",\"$R2\"]" ] && ok "add-recipient: idempotent, order kept" || bad "add-recipient duplicated: $(jq -c .archiveRecipients "$F")"
for badr in "age1" "AGE1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ" "ssh-ed25519 AAAA" "age1qqqq;rm" "age1QQQQQQQQQQQQQQQQQQQQQQQQQQQQ" ""; do
  before="$(cat "$F")"; pol add-recipient "$badr"; rc=$?
  [ "$rc" != 0 ] && [ "$(cat "$F")" = "$before" ] || { bad "add-recipient accepted '$badr'"; }
done
ok "add-recipient: malformed recipients refused, file unchanged"

pol remove-recipient "$R1"; rc=$?
[ "$rc" = 0 ] && [ "$(jq -c .archiveRecipients "$F")" = "[\"$R2\"]" ] && ok "remove-recipient: removed" || { bad "remove-recipient rc=$rc"; cat "$TMP/out"; }
pol remove-recipient "$R1"; [ $? = 0 ] && [ "$(jq -c .archiveRecipients "$F")" = "[\"$R2\"]" ] && ok "remove-recipient: an unlisted recipient is a no-op" || bad "remove-recipient of absent changed the file"

# Other keys the owner wrote survive an edit.
printf '%s\n' "{\"mode\":\"managed\",\"refuse\":[\"restore-archive\"],\"archiveRecipients\":[\"$R2\"]}" > "$F"
pol set-mode self-hosted
[ "$(jq -c .refuse "$F")" = '["restore-archive"]' ] && [ "$(jq -r .mode "$F")" = self-hosted ] \
  && ok "set-mode: the owner's explicit refuse list survives" || bad "set-mode dropped refuse: $(cat "$F")"
pol show; grep -q 'refuse: restore-archive' "$TMP/out" && ! grep -q 'refuse: restore-archive (mode default)' "$TMP/out" \
  && ok "show: an explicit refuse list replaces the mode default" || { bad "show refuse"; cat "$TMP/out"; }

# An unusable file is never overwritten.
printf '%s' '{"mode": "managed",' > "$F"; before="$(cat "$F")"
pol set-mode managed; rc=$?
[ "$rc" != 0 ] && [ "$(cat "$F")" = "$before" ] && grep -q 'not a valid policy file' "$TMP/out" \
  && ok "unusable file: refused with a reason, left as it was" || { bad "unusable file rc=$rc"; cat "$TMP/out"; }
printf '%s' '{"mode":"managed","archiveRecipients":"nope"}' > "$F"
pol add-recipient "$R1"; [ $? != 0 ] && ok "unusable file: a non-array archiveRecipients is refused" || bad "non-array recipients accepted"

# Reader parity: the pod-agent accepts exactly what the CLI writes.
if command -v node >/dev/null 2>&1; then
  rm -f "$F"; pol set-mode managed; pol add-recipient "$R1"
  got="$(node -e 'const p=require(process.argv[1]).readPodAgentPolicy(process.argv[2]);process.stdout.write(JSON.stringify({m:p.mode,e:p.error,r:p.archiveRecipients,s:p.source}))' "$HERE/deploy/pod-agent/policy.js" "$F")"
  [ "$got" = "{\"m\":\"managed\",\"e\":null,\"r\":[\"$R1\"],\"s\":\"file\"}" ] \
    && ok "reader parity: pod-agent's readPodAgentPolicy takes the file as written" || bad "reader parity: $got"
fi

pol bogus; [ $? != 0 ] && grep -q '^Usage: synap policy' "$TMP/out" && ok "unknown action prints the usage" || bad "unknown action"
( cd "$ROOT" && bash "$ROOT/synap" help ) 2>&1 | grep -q 'synap policy <action>' && ok "help documents synap policy" || bad "help lacks synap policy"

exit $fail
