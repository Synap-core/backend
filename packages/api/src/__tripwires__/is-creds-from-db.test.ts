import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — Intelligence-Service credentials come from the DB, NEVER env.
 *
 * A backend→IS call MUST resolve `{ endpoint, apiKey }` via
 * `getDefaultActiveService()` (the registered `intelligence_services` row) and
 * send the pod's per-connection `X-API-Key` (verified by the IS `multiTenantAuth`
 * on every /api route). Reading `process.env.INTELLIGENCE_HUB_INTERNAL_KEY` in a
 * backend request path is the anti-pattern that repeatedly caused "the IS key
 * disappeared" 401s — the internal key is a CP↔IS shared secret ONLY and is
 * (correctly) absent from the pod env.
 *
 * Canonical rule in Synap: entity 023f30c5 — "IS credentials live in the DB,
 * NEVER env". If this test fails: route your call through getDefaultActiveService()
 * instead of reading the env var. Do NOT add your file to the allowlist.
 */

// KNOWN, tracked exceptions — pod→IS INTERNAL routes (admin provider-sync +
// fire-and-forget telemetry to /api/internal/*): a different category than
// per-customer AI calls, pending its own migration. The goal is to drive this
// list to EMPTY. New code must never be added here.
const ALLOWLIST = new Set<string>([
  "routers/ai-providers.ts",
  "routers/hub-protocol/rest/ai-providers.ts",
  "routers/proposals.ts",
]);

const BANNED = "process.env.INTELLIGENCE_HUB_INTERNAL_KEY";

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: backend resolves IS creds from the DB, never env", () => {
  it("no request-path file reads process.env.INTELLIGENCE_HUB_INTERNAL_KEY", () => {
    const srcRoot = join(process.cwd(), "src");
    const offenders = tsFiles(srcRoot)
      .filter((f) => readFileSync(f, "utf8").includes(BANNED))
      .map((f) => relative(srcRoot, f))
      .filter((rel) => !ALLOWLIST.has(rel));
    expect(offenders).toEqual([]);
  });
});
