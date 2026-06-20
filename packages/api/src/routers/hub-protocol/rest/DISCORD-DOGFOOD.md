# Discord Hub Bridge — Dogfood Runbook

Manual verification for `POST /api/hub/discord/agent-turn` (the V0 BYOA Discord
bridge). A real DB-backed vitest is impractical here (the endpoint needs a live
pod: an `orchestrator` agent row, a reachable Intelligence Service, and a valid
agent hub key with `linkedUserId`), so this is the canonical manual check.

## Prerequisites

- Pod running and reachable (`$POD_URL`, e.g. `http://localhost:4000`).
- An agent hub key with the `hub-protocol.write` scope (`$HUB_KEY`).
- The `orchestrator` agent synced (`agents.slug='orchestrator' AND active=true`).
  If it is NOT synced, the endpoint returns **503** `{"error":"Orchestrator agent
not synced — run agent sync"}` — that is correct behavior, not a bug.
- A workspace the bearer is a member of (`$WORKSPACE_ID`).

```bash
POD_URL=http://localhost:4000
HUB_KEY=...                                   # agent key, hub-protocol.write
WORKSPACE_ID=808939d1-86b3-4c52-a153-ae06ece2c54e
```

## 1. Happy path — one turn, one reply

```bash
curl -s -X POST "$POD_URL/api/hub/discord/agent-turn" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "'"$WORKSPACE_ID"'",
    "discordChannelId": "111111111111111111",
    "discordUserId": "222222222222222222",
    "discordUsername": "dogfood-user",
    "text": "hello from discord",
    "messageId": "333333333333333333"
  }'
```

Expected: HTTP 200, body `{"reply":"<agent reply text>"}` (non-empty when the IS
turn succeeds).

Side effects (verify in DB):

- Exactly ONE `channels` row with `external_source='discord'`,
  `external_id='111111111111111111'`.
- Exactly ONE inbound `messages` row (role=`user`, author_type=`external`),
  `hash = sha256('discord:111111111111111111:333333333333333333')`.
- Exactly ONE assistant `messages` row (role=`assistant`) with
  `previous_hash = <that inbound hash>` — **only if the IS turn succeeded**.

## 2. Idempotency — POST the SAME messageId twice

Re-run the EXACT command from step 1 (same `messageId`).

Expected:

- HTTP 200, `{"reply":"<identical reply text>"}` — the prior assistant reply is
  replayed, **the IS turn does NOT run again**.
- DB unchanged: still exactly ONE inbound row and ONE assistant row for that
  `messageId`. No duplicate inbound, no second assistant turn.

If the first turn is still in flight when the duplicate arrives (no assistant row
yet), the duplicate returns `{"reply":""}` (200) rather than running a second turn.

Verify counts:

```sql
SELECT role, count(*)
FROM messages
WHERE hash = encode(digest('discord:111111111111111111:333333333333333333','sha256'),'hex')
   OR previous_hash = encode(digest('discord:111111111111111111:333333333333333333','sha256'),'hex')
GROUP BY role;
-- expect: user=1, assistant<=1  (NEVER assistant>1 or user>1)
```

## 3. IS outage — no persisted apology

Point the resolved IS at an unreachable endpoint (or stop the IS) and POST a NEW
`messageId`.

Expected:

- HTTP 200, `{"reply":"The AI service is temporarily unavailable. Please try
again in a moment."}`.
- The inbound `user` message IS recorded (inbox semantics), but **NO assistant
  message is persisted** (the apology is returned to the bot, never written to
  channel history). A later retry with the same `messageId` can therefore still
  produce the real reply once the IS recovers — step 2's guard returns the empty
  reply until a genuine assistant turn lands.

## 4. Missing scope

Call with a key lacking `hub-protocol.write`.

Expected: HTTP 403 `{"error":"Insufficient scope: hub-protocol.write required"}`.

## 5. Cross-workspace guard

Call with a `workspaceId` the bearer is NOT a member of.

Expected: HTTP 403 (from `resolveActingContext` → `getWorkspaceMembership`).
`body.workspaceId` can never be used to write into an inaccessible workspace.
