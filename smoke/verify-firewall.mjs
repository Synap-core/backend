#!/usr/bin/env node
/**
 * Post-deploy smoke test — the firewall invariant (non-negotiable).
 *
 * Asserts the client-comms immutability floor via the REAL HTTP door: attempting
 * to relink/reclassify a client-comms channel to `team` must be refused with a
 * clean 403 (not a 500, not a silent success). This is the one security-critical
 * invariant that a bad deploy could regress.
 *
 * Usage:
 *   SYNAP_POD_URL=... SYNAP_HUB_API_KEY=... \
 *   FW_WORKSPACE_ID=<uuid> FW_EXTERNAL_SOURCE=discord FW_EXTERNAL_CHANNEL_ID=<id> \
 *   node smoke/verify-firewall.mjs
 *
 * Find a client-comms channel to target with (on the pod DB):
 *   SELECT external_source, external_channel_id, workspace_id
 *     FROM channels WHERE branch_purpose='client-comms' AND external_channel_id IS NOT NULL LIMIT 1;
 *
 * Exits non-zero on any failed assertion.
 */

const pod = process.env.SYNAP_POD_URL;
const key = process.env.SYNAP_HUB_API_KEY;
const workspaceId = process.env.FW_WORKSPACE_ID;
const externalSource = process.env.FW_EXTERNAL_SOURCE ?? "discord";
const externalChannelId = process.env.FW_EXTERNAL_CHANNEL_ID;

for (const [k, v] of Object.entries({
  SYNAP_POD_URL: pod,
  SYNAP_HUB_API_KEY: key,
  FW_WORKSPACE_ID: workspaceId,
  FW_EXTERNAL_CHANNEL_ID: externalChannelId,
})) {
  if (!v) {
    console.error(`✗ missing env ${k}`);
    process.exit(2);
  }
}

const res = await fetch(`${pod}/api/hub/channels`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    workspaceId,
    externalSource,
    externalChannelId,
    branchPurpose: "team",
    relink: true,
  }),
});
const body = await res.json().catch(() => ({}));

const ok403 = res.status === 403;
const okMsg =
  typeof body.error === "string" && /client-comms.*immutable/i.test(body.error);

console.log(`  status: ${res.status} (expect 403)  ${ok403 ? "✓" : "✗"}`);
console.log(`  body:   ${JSON.stringify(body)}`);
console.log(`  message asserts firewall immutability: ${okMsg ? "✓" : "✗"}`);

if (ok403 && okMsg) {
  console.log(
    "✓ FIREWALL FLOOR HOLDS — client-comms is immutable via the HTTP door."
  );
  process.exit(0);
}
console.error(
  "✗ FIREWALL REGRESSED — a client-comms channel was reclassifiable, or the error was not a clean 403."
);
process.exit(1);
