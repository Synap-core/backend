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
]);

const RAW_WRITE = /\bdb\.(insert|update|delete)\s*\(/;
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

  it("every hub file with a raw db write also routes through the gate", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      if (!RAW_WRITE.test(src)) continue;
      if (GATE.test(src)) continue;
      const id = file.split("/hub-protocol/")[1] ?? file;
      if (!ALLOWLIST.has(id)) violations.push(id);
    }
    expect(
      violations,
      `Hub file(s) writing the DB directly without checkPermissionOrPropose or ` +
        `getCaller — governance bypass risk:\n  ${violations.join("\n  ")}`
    ).toEqual([]);
  });
});
