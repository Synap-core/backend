#!/usr/bin/env node
/**
 * Dogfood harness — proves the FOCUS-SESSION → proposal linkage end-to-end
 * against a LIVE pod, before shipping to real users.
 *
 * The unification promise is: "everything an agent does is a session" — an
 * agent's governed write, tagged with a focus session, must surface under that
 * session so the review board can group it into one reviewable card. This script
 * exercises exactly that chain and asserts the link:
 *
 *   1. create a throwaway FOCUS session (channel-less, so it can't collide with
 *      or disturb any real channel/compaction session on the pod)
 *   2. perform an agent-authored governed write (create a note entity) tagged
 *      with that focus sessionId  → governance PROPOSES it (agent role can't
 *      auto-apply an entity create)
 *   3. GET /proposals?sessionId=<id>  → the new proposal MUST appear, carrying
 *      the sessionId. (Before the sessionId-threading fix, it did not — the
 *      proposal was session-orphaned and invisible to a session-scoped board.)
 *   4. clean up: reject the proposal + close the focus session.
 *
 * NOTE: `proposals.sessionId` references `focus_sessions` (NOT the message-
 * compaction `sessions` table). This script therefore uses `/focus-sessions`
 * exclusively — do not "simplify" it to `/sessions/getOrCreate`, which is a
 * different subsystem and would both give a false pass (no FK, any UUID matches)
 * and disturb a live compaction session.
 *
 * Run (against the pod your session is connected to):
 *   SYNAP_POD_URL=... SYNAP_HUB_API_KEY=... \
 *     node scripts/dogfood-session-proposals.mjs
 *
 * The key SHOULD be agent-linked (so the entity write proposes rather than
 * auto-applies). Exit code 0 = PASS, 1 = FAIL. Single-pass + small, to respect
 * the pod's edge rate limit.
 */

const POD_URL = process.env.SYNAP_POD_URL;
const API_KEY = process.env.SYNAP_HUB_API_KEY;

if (!POD_URL || !API_KEY) {
  console.error(
    "✗ Set SYNAP_POD_URL and SYNAP_HUB_API_KEY in the environment."
  );
  process.exit(1);
}

const base = `${POD_URL.replace(/\/$/, "")}/api/hub`;

async function hub(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`
    );
  }
  return json;
}

function unwrap(res, keys) {
  if (Array.isArray(res)) return res;
  for (const k of keys) {
    if (Array.isArray(res?.[k])) return res[k];
    if (Array.isArray(res?.data?.[k])) return res.data[k];
  }
  return [];
}

async function main() {
  console.log(`→ pod: ${POD_URL}`);

  // 1. Create a throwaway, channel-less focus session.
  const goal = "dogfood: session→proposal linkage check";
  const session = await hub("POST", "/focus-sessions", { goal });
  const sessionId = session.id ?? session.session?.id;
  if (!sessionId) {
    if (session.proposalId) {
      console.error(
        `✗ INCONCLUSIVE — creating the focus session itself PROPOSED ` +
          `(proposalId ${session.proposalId}). Re-run with a key whose ` +
          `session-create is auto-approved (normal agent governance).`
      );
      process.exit(1);
    }
    console.error(
      `✗ POST /focus-sessions returned no id: ${JSON.stringify(session).slice(0, 300)}`
    );
    process.exit(1);
  }
  console.log(`→ focus session: ${sessionId}`);

  // 2. Agent-authored governed write, tagged with the session → should PROPOSE.
  const marker = `dogfood-session-link-${sessionId.slice(0, 8)}`;
  const created = await hub("POST", "/entities", {
    profileSlug: "note",
    title: marker,
    sessionId,
  });
  const proposedId = created.proposalId ?? created.proposal?.id ?? null;
  console.log(
    `→ write submitted (${proposedId ? "proposed" : created.id ? "auto-applied" : "?"})`
  );

  // 3. THE ASSERTION: the write must surface under the session's proposals,
  //    carrying this exact sessionId. Match on the proposal id when we have it
  //    (exact), else fall back to sessionId equality — NOT a substring match on
  //    the serialized row (which risks false positives on incidental id echoes).
  const proposals = unwrap(
    await hub("GET", `/proposals?sessionId=${encodeURIComponent(sessionId)}`),
    ["proposals", "items"]
  );
  const linked = proposedId
    ? proposals.find((p) => p.id === proposedId)
    : proposals.find((p) => p.sessionId === sessionId);

  let pass = false;
  if (linked && linked.sessionId === sessionId) {
    pass = true;
    console.log(
      `✓ PASS — proposal ${linked.id} is linked to session ${sessionId}`
    );
    try {
      await hub("POST", `/proposals/${linked.id}/reject`, {});
      console.log(`  ↳ cleaned up dogfood proposal`);
    } catch (e) {
      console.log(`  ↳ (could not auto-reject: ${e.message})`);
    }
  } else if (linked) {
    console.log(
      `✗ FAIL — proposal ${linked.id} found for this session but ` +
        `sessionId=${linked.sessionId} (not threaded through)`
    );
  } else if (created.id && !proposedId) {
    console.log(
      `✗ INCONCLUSIVE — the entity write auto-applied (no proposal). Re-run ` +
        `with an AGENT-linked key so the write proposes instead of applying.`
    );
  } else {
    console.log(
      `✗ FAIL — no proposal surfaced under GET /proposals?sessionId=${sessionId}. ` +
        `The session→proposal link is broken (sessionId not threaded to the write).`
    );
  }

  // 4. Close the dogfood session (best-effort).
  try {
    await hub("PATCH", `/focus-sessions/${sessionId}`, { status: "closed" });
  } catch {
    /* best-effort */
  }

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`✗ ERROR: ${err.message}`);
  process.exit(1);
});
