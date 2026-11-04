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
# A clean request (synap-clean.service) is answered in ITS contract's shape,
# state/clean/result.json {id, action, status:"failed", detail, finishedAt}
# (+ "by":"unit"), since the backend that asked reads that file.
#
#   request-outcome.sh <update|compose|archive|clean>   (needs SYNAP_DEPLOY_DIR)
# ============================================================================
name="${1:-}"
d="${SYNAP_DEPLOY_DIR:?request-outcome.sh needs SYNAP_DEPLOY_DIR}"
case "$name" in
    update)  latest="$d/state/last-update.json"; kind="pod.update" ;;
    compose) latest="$d/state/last-compose-request.json"; kind="pod.compose-request" ;;
    archive) latest="$d/state/last-archive-request.json"; kind="pod.archive-request" ;;
    clean)   latest="$d/state/clean/result.json"; kind="pod.clean" ;;
    *) echo "usage: request-outcome.sh <update|compose|archive|clean>" >&2; exit 2 ;;
esac
taken="$d/state/requests/$name.taken.json"
[ "$name" = clean ] && taken="$d/state/clean/request.taken.json"
[ -f "$taken" ] || exit 0                              # no request this run (a timer start)
id="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9][A-Za-z0-9_.:-]\{0,127\}\)".*/\1/p' "$taken" | head -n 1)"
[ -n "$id" ] || exit 0                                 # no id: no waiter can match an outcome
if [ "$name" = clean ]; then
    grep -qF "\"id\":\"$id\"" "$latest" 2>/dev/null && exit 0     # the engine answered it
else
    grep -qF "\"request\":\"$id\"" "$latest" 2>/dev/null && exit 0   # the engine answered it (fixed string: ids hold dots)
fi
how="$(printf '%s' "${SERVICE_RESULT:-unknown} ${EXIT_CODE:-} ${EXIT_STATUS:-}" | tr -cd 'A-Za-z0-9 _.-' | sed 's/ *$//')"
reason="the engine stopped before recording an outcome for this request (${how}); the pod may have changed — run synap doctor, see journalctl -u synap-${name}.service"
pod="$(sed -n 's/^DOMAIN=//p' "$d/.env" 2>/dev/null | tail -n 1 | tr -cd 'A-Za-z0-9.-')"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ev="{\"ts\":\"${ts}\",\"kind\":\"${kind}\",\"status\":\"failed\",\"by\":\"unit\",\"request\":\"${id}\",\"reason\":\"${reason}\",\"pod\":\"${pod}\"}"
mkdir -p "$(dirname "$latest")"
if [ "$name" = clean ]; then
    action="$(sed -n 's/.*"action"[[:space:]]*:[[:space:]]*"\([a-z-]\{1,64\}\)".*/\1/p' "$taken" | head -n 1)"
    printf '%s\n' "{\"id\":\"${id}\",\"action\":\"${action}\",\"status\":\"failed\",\"detail\":\"${reason}\",\"finishedAt\":\"${ts}\",\"by\":\"unit\"}" > "$latest.tmp" \
        && mv -f "$latest.tmp" "$latest"
else
    printf '%s\n' "$ev" > "$latest.tmp" && mv -f "$latest.tmp" "$latest"
fi
printf '%s\n' "$ev" >> "$d/state/events.jsonl"
echo "SYNAP_EVENT $ev"
