#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Workspace-member invite chain — server-side smoke test.
#
# Walks every server hop of the CP-managed workspace invite → redeem →
# provisioning chain that a browser can't be scripted for, so a silent
# best-effort failure can never hide for days again (the multi-day debugging
# saga this script exists to prevent). No browser, no SPA.
#
#   1. CP  POST /pods/:podId/invites  (type=workspace)  → 201 + non-empty inviteUrl
#   2. inviteUrl HOST is reachable (not 404) and is NOT the pod-admin host
#   3. `emailSent` present in the 201 body (loud WARN if false — copy-link fallback)
#   4. CP  POST /pods/invites/:token/redeem  (verified invitee session)  → 2xx
#   5. Pod Kratos admin: a Kratos identity now exists for the invitee email
#   6. Pod DB: a `workspace_members` row exists for that identity + workspace
#      (gated — needs POD_DATABASE_URL + psql on the pod host)
#   7. Pod Kratos admin: the `cp` OIDC credential is attached to that identity
#      (the silent-best-effort wire — a missing cred = broken "Continue with
#       Synap Cloud" for this member, with NO other signal)
#   8. NEGATIVE: redeem an invite addressed to another email with the invitee
#      session → 403 + code:"INVITE_EMAIL_MISMATCH"
#   9. NEGATIVE (security floor, gated): a member's pod session token setting a
#      FOREIGN X-Workspace-Id on a /trpc call → 403
#
# It needs deploy-time secrets and is meant to be run by an operator on (or with
# network access to) the pod host — exactly like verify-federated-signin.sh.
#
# Required env:
#   CP               CP API base            (e.g. https://api.synap.live)
#   POD              target Pod base        (e.g. https://pod.thearch.synap.live)
#   POD_ID           CP dataPods.id of the target pod
#   WORKSPACE_ID     workspace to invite into (pod-side workspaces.id)
#   INVITEE_EMAIL    the invitee's email (== the verified fixture user's email)
#   INVITEE_TOKEN    Bearer session token of the VERIFIED invitee CP user
#                    (Better-Auth session token or OAuth access JWT; emailVerified)
#   CP_ADMIN_TOKEN   Bearer session token of a user who can admin WORKSPACE_ID's
#                    invite scope (mints the invitations)
#
# Optional env:
#   ROLE                  invite role (admin|editor|viewer)   [viewer]
#   KRATOS_ADMIN          pod Kratos admin API                [http://localhost:4434]
#   POD_DATABASE_URL      pod Postgres URL — enables check 6 (workspace_members)
#   ADMIN_HOST            pod-admin host; check 2 asserts inviteUrl host != this
#   MISMATCH_EMAIL        email for the negative redeem       [auto random]
#   MEMBER_POD_TOKEN      a member's Kratos session token — enables floor check 9
#   FOREIGN_WORKSPACE_ID  a workspace the member is NOT in    — enables floor check 9
#
# Usage:
#   CP=https://api.synap.live POD=https://pod.thearch.synap.live \
#   POD_ID=... WORKSPACE_ID=... INVITEE_EMAIL=member@example.com \
#   INVITEE_TOKEN=... CP_ADMIN_TOKEN=... \
#   ./verify-invite-flow.sh
# ---------------------------------------------------------------------------
set -uo pipefail

CP="${CP:-https://api.synap.live}"
POD="${POD:-https://pod.thearch.synap.live}"
POD_ID="${POD_ID:-}"
WORKSPACE_ID="${WORKSPACE_ID:-}"
INVITEE_EMAIL="${INVITEE_EMAIL:-}"
INVITEE_TOKEN="${INVITEE_TOKEN:-}"
CP_ADMIN_TOKEN="${CP_ADMIN_TOKEN:-}"
ROLE="${ROLE:-viewer}"
KRATOS_ADMIN="${KRATOS_ADMIN:-http://localhost:4434}"
POD_DATABASE_URL="${POD_DATABASE_URL:-}"
ADMIN_HOST="${ADMIN_HOST:-}"
MISMATCH_EMAIL="${MISMATCH_EMAIL:-invite-smoke-mismatch-$$@invalid.test}"
MEMBER_POD_TOKEN="${MEMBER_POD_TOKEN:-}"
FOREIGN_WORKSPACE_ID="${FOREIGN_WORKSPACE_ID:-}"

pass=0; fail=0; warn=0; skip=0
ok(){   echo "  ✅ $1"; pass=$((pass+1)); }
no(){   echo "  ❌ $1"; fail=$((fail+1)); }
wn(){   echo "  ⚠️  $1"; warn=$((warn+1)); }
sk(){   echo "  ⏭️  $1"; skip=$((skip+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/vinv.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
# Read a top-level JSON field from a saved response body (empty on any error).
jf(){ node -pe "try{(JSON.parse(require('fs').readFileSync('$1','utf8'))$2)??''}catch(e){''}" 2>/dev/null; }

# Fail fast on missing required inputs — an operator should see exactly what's absent.
missing=""
for v in POD_ID WORKSPACE_ID INVITEE_EMAIL INVITEE_TOKEN CP_ADMIN_TOKEN; do
  [ -z "${!v}" ] && missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "── invite smoke test ── ABORT: missing required env:$missing"
  echo "   see the header of this script for the full contract."
  exit 2
fi

echo "── Workspace-invite smoke test ──  CP=$CP  POD=$POD  ws=$WORKSPACE_ID  invitee=$INVITEE_EMAIL"

# 1. CP mints the managed invitation → 201 + a non-empty inviteUrl.
CREATE_CODE=$(curl -sS -o "$TMP/create.json" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $CP_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$CP/pods/$POD_ID/invites" \
  -d "{\"type\":\"workspace\",\"workspaceId\":\"$WORKSPACE_ID\",\"role\":\"$ROLE\",\"email\":\"$INVITEE_EMAIL\"}")
INVITE_URL=$(jf "$TMP/create.json" ".inviteUrl")
if [ "$CREATE_CODE" = "201" ] && [ -n "$INVITE_URL" ]; then
  ok "1. create invite → 201 + inviteUrl"
else
  no "1. create invite → $CREATE_CODE (inviteUrl='$INVITE_URL'): $(head -c 200 "$TMP/create.json")"
fi

# 3. emailSent must be present; false is a real degradation (copy-link fallback).
EMAIL_SENT=$(node -pe "try{const o=JSON.parse(require('fs').readFileSync('$TMP/create.json','utf8'));'emailSent' in o?String(o.emailSent):'MISSING'}catch(e){'MISSING'}" 2>/dev/null)
case "$EMAIL_SENT" in
  true)    ok "3. emailSent=true" ;;
  false)   wn "3. emailSent=FALSE — invitee got NO email; only the copy-link fallback works. Check the CP mailer." ;;
  *)       no "3. emailSent field MISSING from create response" ;;
esac

# Derive the redemption token from the inviteUrl (strip query, take the segment
# after /invite/, else the last path segment). CP always returns a valid URL.
TOKEN=""
if [ -n "$INVITE_URL" ]; then
  URL_NOQ="${INVITE_URL%%\?*}"
  case "$URL_NOQ" in
    */invite/*) TOKEN="${URL_NOQ##*/invite/}" ;;
    *)          TOKEN="${URL_NOQ##*/}" ;;
  esac
fi

# 2. The inviteUrl host must be reachable (not a 404) and must NOT be the admin host.
if [ -n "$INVITE_URL" ]; then
  HOST_NOSCHEME="${INVITE_URL#*://}"; INV_HOST="${HOST_NOSCHEME%%/*}"
  RCODE=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 15 "$INVITE_URL")
  if [ "$RCODE" = "404" ] || [ "$RCODE" = "000" ]; then
    no "2. inviteUrl host unreachable/404 (HTTP $RCODE, host=$INV_HOST) — landing page is a dead link"
  elif [ -n "$ADMIN_HOST" ] && [ "$INV_HOST" = "$ADMIN_HOST" ]; then
    no "2. inviteUrl points at the ADMIN host ($INV_HOST) — must be the user-facing host"
  else
    ok "2. inviteUrl host reachable (HTTP $RCODE, host=$INV_HOST)"
  fi
else
  sk "2. no inviteUrl to reach (check 1 failed)"
fi

# 4. The invitee redeems with their verified CP session → 2xx (grant reaches the pod).
if [ -n "$TOKEN" ]; then
  RED_CODE=$(curl -sS -o "$TMP/redeem.json" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $INVITEE_TOKEN" \
    "$CP/pods/invites/$TOKEN/redeem")
  if [ "$RED_CODE" -ge 200 ] && [ "$RED_CODE" -lt 300 ]; then
    ok "4. redeem → $RED_CODE"
  else
    no "4. redeem → $RED_CODE: $(head -c 200 "$TMP/redeem.json")"
  fi
else
  sk "4. no token parsed from inviteUrl — cannot redeem"
fi

# 5. Pod Kratos now has an identity for the invitee email.
KENC=$(node -pe "encodeURIComponent('$INVITEE_EMAIL')" 2>/dev/null)
curl -sS -o "$TMP/ids.json" --max-time 15 \
  "$KRATOS_ADMIN/admin/identities?credentials_identifier=$KENC" >/dev/null 2>&1
KID=$(node -pe "try{const a=JSON.parse(require('fs').readFileSync('$TMP/ids.json','utf8'));(Array.isArray(a)&&a[0]&&a[0].id)||''}catch(e){''}" 2>/dev/null)
if [ -n "$KID" ]; then
  ok "5. Kratos identity exists for $INVITEE_EMAIL ($KID)"
else
  no "5. NO Kratos identity for $INVITEE_EMAIL — provisioning did not create/resolve it"
fi

# 6. Pod DB has the workspace_members row (needs DB access — gated).
if [ -z "$POD_DATABASE_URL" ] || ! command -v psql >/dev/null 2>&1; then
  sk "6. workspace_members check (set POD_DATABASE_URL + install psql on the pod host)"
elif [ -z "$KID" ]; then
  sk "6. workspace_members check (no Kratos identity resolved in check 5)"
else
  CNT=$(psql "$POD_DATABASE_URL" -tAc \
    "select count(*) from workspace_members where workspace_id='$WORKSPACE_ID' and user_id='$KID'" 2>/dev/null | tr -d '[:space:]')
  if [ "${CNT:-0}" -ge 1 ] 2>/dev/null; then
    ok "6. workspace_members row present for identity+workspace"
  else
    no "6. NO workspace_members row for user_id=$KID in workspace $WORKSPACE_ID (count=$CNT)"
  fi
fi

# 7. The `cp` OIDC credential is attached — the silent best-effort wire.
if [ -z "$KID" ]; then
  sk "7. cp OIDC credential check (no Kratos identity resolved)"
else
  curl -sS -o "$TMP/idcred.json" --max-time 15 \
    "$KRATOS_ADMIN/admin/identities/$KID?include_credential=oidc" >/dev/null 2>&1
  HAS_CP=$(node -pe "try{const o=JSON.parse(require('fs').readFileSync('$TMP/idcred.json','utf8'));const c=((o.credentials||{}).oidc||{}).config||{};const p=Array.isArray(c.providers)?c.providers:[];p.some(x=>x&&x.provider==='cp')?'yes':'no'}catch(e){'no'}" 2>/dev/null)
  if [ "$HAS_CP" = "yes" ]; then
    ok "7. cp OIDC credential attached (Continue with Synap Cloud will complete silently)"
  else
    no "7. cp OIDC credential MISSING on $KID — this member's Cloud sign-in will hit Kratos account-linking (the silent-best-effort failure)"
  fi
fi

# 8. NEGATIVE: an invite addressed to a DIFFERENT email must reject this invitee.
MIS_CODE=$(curl -sS -o "$TMP/mis_create.json" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $CP_ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$CP/pods/$POD_ID/invites" \
  -d "{\"type\":\"workspace\",\"workspaceId\":\"$WORKSPACE_ID\",\"role\":\"$ROLE\",\"email\":\"$MISMATCH_EMAIL\"}")
MIS_URL=$(jf "$TMP/mis_create.json" ".inviteUrl")
MIS_URL_NOQ="${MIS_URL%%\?*}"
case "$MIS_URL_NOQ" in
  */invite/*) MIS_TOKEN="${MIS_URL_NOQ##*/invite/}" ;;
  *)          MIS_TOKEN="${MIS_URL_NOQ##*/}" ;;
esac
if [ "$MIS_CODE" = "201" ] && [ -n "$MIS_TOKEN" ]; then
  MR_CODE=$(curl -sS -o "$TMP/mis_redeem.json" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $INVITEE_TOKEN" \
    "$CP/pods/invites/$MIS_TOKEN/redeem")
  MR_CODEFIELD=$(jf "$TMP/mis_redeem.json" ".code")
  if [ "$MR_CODE" = "403" ] && [ "$MR_CODEFIELD" = "INVITE_EMAIL_MISMATCH" ]; then
    ok "8. mismatched-email redeem → 403 + INVITE_EMAIL_MISMATCH"
  elif [ "$MR_CODE" = "403" ]; then
    wn "8. mismatched-email redeem → 403 but code='$MR_CODEFIELD' (expected INVITE_EMAIL_MISMATCH)"
  else
    no "8. mismatched-email redeem → $MR_CODE (expected 403): $(head -c 160 "$TMP/mis_redeem.json")"
  fi
else
  sk "8. could not mint the mismatch invite (create → $MIS_CODE) — cannot run the negative redeem"
fi

# 9. NEGATIVE security floor (gated): a member's pod token must not read across
#    into a workspace they're not a member of, even with a forged X-Workspace-Id.
if [ -z "$MEMBER_POD_TOKEN" ] || [ -z "$FOREIGN_WORKSPACE_ID" ]; then
  sk "9. cross-workspace floor check (set MEMBER_POD_TOKEN + FOREIGN_WORKSPACE_ID)"
else
  FL_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "X-Session-Token: $MEMBER_POD_TOKEN" \
    -H "X-Workspace-Id: $FOREIGN_WORKSPACE_ID" \
    "$POD/trpc/agentConfigs.list")
  if [ "$FL_CODE" = "403" ]; then
    ok "9. member token + foreign X-Workspace-Id → 403 (cross-workspace floor holds)"
  else
    no "9. SECURITY: member token + foreign X-Workspace-Id → $FL_CODE (expected 403 — the floor is open)"
  fi
fi

echo "── $pass passed, $fail failed, $warn warn, $skip skipped ──"
[ "$fail" -eq 0 ]
