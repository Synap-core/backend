#!/bin/sh
# ============================================================================
# The terminal outcome of a request the unit TOOK but the engine never answered
# (POSIX sh, no jq — it must run when the engine cannot). ExecStopPost= of
# synap-update.service / synap-compose.service / synap-archive.service.
# ============================================================================
# The unit's ExecStartPre takes state/requests/<name>.json before `synap` runs,
# so a run that dies early can no longer loop on it — but then nothing would
# ever answer the request: pod-agent (and the CP behind it) would wait for an
# outcome until its own timeout. When the engine stopped without recording an
# outcome for the taken request's id (no jq, a compose-project conflict, a
# broken bundle, a kill), this records one, in the same file and shape the
# engine uses — status "failed", the reason naming how the service ended
# (systemd's SERVICE_RESULT / EXIT_CODE / EXIT_STATUS), marked "by":"unit" so
# no reader mistakes it for the engine's own verdict (the engine may have
# changed the pod before it stopped) — and appends it to state/events.jsonl.
# An outcome the engine wrote is never touched.
#
#   request-outcome.sh <update|compose|archive>   (needs SYNAP_DEPLOY_DIR)
# ============================================================================
name="${1:-}"
d="${SYNAP_DEPLOY_DIR:?request-outcome.sh needs SYNAP_DEPLOY_DIR}"
case "$name" in
    update)  latest="$d/state/last-update.json"; kind="pod.update" ;;
    compose) latest="$d/state/last-compose-request.json"; kind="pod.compose-request" ;;
    archive) latest="$d/state/last-archive-request.json"; kind="pod.archive-request" ;;
    *) echo "usage: request-outcome.sh <update|compose|archive>" >&2; exit 2 ;;
esac
taken="$d/state/requests/$name.taken.json"
[ -f "$taken" ] || exit 0                              # no request this run (a timer start)
id="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9][A-Za-z0-9_.:-]\{0,127\}\)".*/\1/p' "$taken" | head -n 1)"
[ -n "$id" ] || exit 0                                 # no id: no waiter can match an outcome
grep -qF "\"request\":\"$id\"" "$latest" 2>/dev/null && exit 0   # the engine answered it (fixed string: ids hold dots)
how="$(printf '%s' "${SERVICE_RESULT:-unknown} ${EXIT_CODE:-} ${EXIT_STATUS:-}" | tr -cd 'A-Za-z0-9 _.-' | sed 's/ *$//')"
reason="the engine stopped before recording an outcome for this request (${how}); the pod may have changed — run synap doctor, see journalctl -u synap-${name}.service"
pod="$(sed -n 's/^DOMAIN=//p' "$d/.env" 2>/dev/null | tail -n 1 | tr -cd 'A-Za-z0-9.-')"
ev="{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"kind\":\"${kind}\",\"status\":\"failed\",\"by\":\"unit\",\"request\":\"${id}\",\"reason\":\"${reason}\",\"pod\":\"${pod}\"}"
mkdir -p "$d/state"
printf '%s\n' "$ev" > "$latest.tmp" && mv -f "$latest.tmp" "$latest"
printf '%s\n' "$ev" >> "$d/state/events.jsonl"
echo "SYNAP_EVENT $ev"
