/**
 * WRITE-GATE TRIPWIRE
 *
 * The AI/Hub Protocol boundary has no single structural choke point: governance
 * (`checkPermissionOrPropose`) is enforced per-route at varying depths. The
 * standing risk (per the boundary map) is a NEW hub slice that writes the DB
 * directly and silently skips the gate.
 *
 * This tripwire catches exactly that: any file under routers/hub-protocol/ that
 * performs a raw mutation (db.insert/update/delete) MUST also route through the
 * gate — either by calling `checkPermissionOrPropose` itself, or by delegating
 * to a gated regular mutation via `getCaller()` (the sanctioned hub pattern).
 *
 * A hub file doing raw writes with neither is a probable governance bypass.
 * The allowlist may only shrink.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HUB_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "routers",
  "hub-protocol"
);

// Hub files that legitimately write WITHOUT the governance gate. May only
// shrink; justify each. (The gate governs proposal-gated *entity content*; the
// stores below are deliberately outside it.)
const ALLOWLIST = new Set<string>([
  // Episodic/knowledge memory is an ungoverned fast store (intelligence-rules:
  // "memory always on"), not proposal-gated content. Writes/deletes are scoped
  // to the caller's own userId (see deleteMemoryRoute) — not a gate bypass.
  "rest/memory.ts",
  // Pod bootstrap/provisioning — runs at setup time (pre-auth /setup/*), before
  // any governance context exists.
  "rest/setup.ts",
  // Signal infrastructure only (fetch history / auto-links / subscriptions —
  // system state + telemetry); creates no proposal-gated entity content.
  "signals.ts",
  // Intelligence-service self-registration — writes the pod's service registry
  // (intelligenceServices), gated by the hub-protocol.write claim. Infra config,
  // not proposal-gated entity content.
  "services.ts",
  // AI-provider credentials — workspace-level provider config (apiKeys/baseUrls),
  // gated by hub-protocol.write + workspace membership (assertWorkspaceMember on
  // the read side). Infra config, not proposal-gated entity content.
  "rest/ai-providers.ts",
  // TODO: route through checkPermissionOrPropose — acknowledged debt below.
  // Agent skills are workspace-level config (install/uninstall), not user-facing
  // entity content. Low-risk but should be proposal-gated eventually.
  "rest/agent-skills.ts",
  // Cell instances are managed via a separate installation lifecycle (not
  // proposal-gated entity mutations). TODO: add governance gate.
  "rest/cells.ts",
  // Vault entries are workspace-level secrets infra, gated by hub-protocol.write
  // + workspace membership. Not proposal-gated entity content, but should be
  // reviewed for governance coverage eventually.
  "rest/vault.ts",
]);

// NOT justified — DEBT made visible on 2026-10-19 when RAW_WRITE learned to
// see multi-line chains. Each writes directly with no governance gate; listed
// so the tripwire is green for every OTHER file while these are fixed. May
// only shrink; never move an entry to ALLOWLIST without fixing or justifying.
// (Findings per route: lane/sec-webhooks sweep report.)
const KNOWN_UNGATED = new Set<string>([
  // Scope + owner-wide fence (GRANT_OWNER_WIDE_REST_DOORS) since 2026-10-19;
  // still no gate.
  "rest/webhooks.ts",
  // /agents/sync — owner-wide fence since 2026-10-19; no gate.
  "rest/agents.ts",
  // /channel-egress/:id/ack — any row by id, no owner predicate.
  "rest/channel-egress.ts",
  // Account sync / channel delete / mark-read (write scope since 2026-10-19).
  "rest/messaging.ts",
  // CP-JWT door (one-time consent code) — likely by design; unreviewed here.
  "rest/mcp-redeem.ts",
  // Grant-bounded (grantWriteDenial) but not via the gate.
  "rest/agent-users.ts",
  // tRPC hub routers: scope-checked; context.updateThreadContext is floored
  // on channel visibility since 2026-10-19 (lane/sec-w3) but not gated.
  "context.ts",
  "compacted-states.ts",
  "sessions.ts",
]);

/**
 * Tolerates whitespace around the dot: prettier breaks a long chain as
 * `db\n  .insert(table)`, and the previous `\bdb\.(insert|…)` never saw that
 * shape — it was blind to nine files (webhooks.ts among them, whose ungated
 * insert let a read-only key subscribe to every event of the owner) and to the
 * allowlisted memory.ts it claimed to watch. A self-check below pins the
 * multi-line sample. Still blind to `tx.` / repository writes (measured: the
 * scan is file-granular, not route-granular — one gated route in a file
 * clears every other route in it).
 */
const RAW_WRITE = /\bdb\s*\.\s*(insert|update|delete)\s*\(/;
const GATE = /checkPermissionOrPropose|getCaller/;

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts")
    )
      out.push(full);
  }
  return out;
}

const FILES = collect(HUB_DIR);

describe("write-gate tripwire — no hub raw write bypasses governance", () => {
  it("found hub-protocol files to scan", () => {
    expect(FILES.length).toBeGreaterThan(3);
  });

  it("RAW_WRITE sees the prettier-broken chain shape (self-check)", () => {
    expect(
      RAW_WRITE.test("await db\n        .insert(webhookSubscriptions)")
    ).toBe(true);
    expect(RAW_WRITE.test("db.update(x)")).toBe(true);
    expect(RAW_WRITE.test("db.query.x.findMany(")).toBe(false);
  });

  it("every KNOWN_UNGATED entry still writes raw and skips the gate", () => {
    // A fixed file must leave the debt list (it may only shrink).
    const stale = [...KNOWN_UNGATED].filter((id) => {
      const file = FILES.find((f) => f.endsWith(`/hub-protocol/${id}`));
      if (!file) return true;
      const src = readFileSync(file, "utf8");
      return !RAW_WRITE.test(src) || GATE.test(src);
    });
    expect(stale).toEqual([]);
  });

  it("every hub file with a raw db write also routes through the gate", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      if (!RAW_WRITE.test(src)) continue;
      if (GATE.test(src)) continue;
      const id = file.split("/hub-protocol/")[1] ?? file;
      if (!ALLOWLIST.has(id) && !KNOWN_UNGATED.has(id)) violations.push(id);
    }
    expect(
      violations,
      `Hub file(s) writing the DB directly without checkPermissionOrPropose or ` +
        `getCaller — governance bypass risk:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });
});
