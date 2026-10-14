#!/usr/bin/env bash
# `synap update --from-source` syncs the checkout, then RE-EXECS the synced
# installer, so the update runs the code it installs. A running bash keeps the
# functions it parsed: before this, the perso pod's update (2026-10-14) synced
# a Kratos-render fix to disk and still rendered with the OLD function.
#
# Real `synap` (v1) in a clone; origin has v2 = the same script plus a probe at
# the top of cmd_update that reports and exits. Asserts:
#   1. v1 `update --from-source` ends up running v2 (the probe fires)
#   2. same pid, and the lock it holds is recognised (no "already running")
#   3. the re-exec happens once (the probe sees SYNAP_UPDATE_SYNCED=1)
#   4. installer unchanged by the sync → no re-exec (the probe never fires)
# Does NOT cover the rest of the update (update-engine.test.sh does).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/docker" <<'D'
#!/usr/bin/env bash
exit 0
D
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# origin: v1 = the real installer + deploy helpers + a minimal deploy dir
git init -q -b main "$TMP/origin"
mkdir -p "$TMP/origin/deploy"
cp "$HERE/synap" "$TMP/origin/synap"
cp "$HERE/deploy/"*.sh "$HERE/deploy/docker-compose.yml" "$HERE/deploy/env.schema" "$TMP/origin/deploy/" 2>/dev/null
( cd "$TMP/origin" && git add -A && git commit -qm v1 )
git clone -q "$TMP/origin" "$TMP/pod"
printf 'DOMAIN=pod.example.com\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nKRATOS_SECRETS_COOKIE=x\nCOMPOSE_PROJECT_NAME=synap-backend\n' > "$TMP/pod/deploy/.env"

probe='    [ -n "${SYNAP_UPDATE_SYNCED:-}" ] && { echo "PROBE v2 pid=$$ held=${SYNAP_LOCK_HELD_BY:-} synced=$SYNAP_UPDATE_SYNCED"; exit 0; }'

# ── 1–3: origin moves to v2 (installer changed) ───────────────────────────────
awk -v p="$probe" '{print} /^cmd_update\(\) \{/{print p}' "$TMP/origin/synap" > "$TMP/v2" && cp "$TMP/v2" "$TMP/origin/synap"
grep -q 'PROBE v2' "$TMP/origin/synap" || { bad "could not plant the v2 probe"; exit 1; }
( cd "$TMP/origin" && git commit -qam v2 )
out=$(cd "$TMP/pod" && ./synap update --from-source 2>&1); rc=$?
pid_line=$(printf '%s\n' "$out" | grep 'PROBE v2' | head -1)
[ -n "$pid_line" ] && ok "re-exec: v1 'update --from-source' ran the synced v2 installer" || { bad "re-exec: v2 never ran (rc=$rc)"; printf '%s\n' "$out" | tail -8; }
printf '%s\n' "$out" | grep -q 'already running' && bad "lock: the re-exec'd installer refused its own lock" || ok "lock: the re-exec'd installer keeps the lock it holds"
p=$(sed -n 's/.*pid=\([0-9]*\).*/\1/p' <<<"$pid_line"); h=$(sed -n 's/.*held=\([0-9]*\).*/\1/p' <<<"$pid_line")
[ -n "$p" ] && [ "$p" = "$h" ] && ok "re-exec: same pid ($p), lock marked as held by it" || bad "re-exec: pid=$p held=$h"
[ "$(printf '%s\n' "$out" | grep -c 'PROBE v2')" = 1 ] && ok "re-exec: exactly once" || bad "re-exec: probe count $(printf '%s\n' "$out" | grep -c 'PROBE v2')"
[ "$(git -C "$TMP/pod" rev-parse HEAD)" = "$(git -C "$TMP/origin" rev-parse HEAD)" ] && ok "sync: the clone is at origin's v2" || bad "sync: clone not at origin"

# ── 4: nothing new on origin → the running installer is current, no re-exec ───
out=$(cd "$TMP/pod" && ./synap update --from-source 2>&1)
# v2 is now both on disk and running: the probe fires only through the export
# that follows a no-change sync, never through a re-exec message.
printf '%s\n' "$out" | grep -q 'continuing with the new one' && bad "no-change: re-exec'd although the installer did not change" || ok "no-change: no re-exec when the installer is unchanged"

[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
