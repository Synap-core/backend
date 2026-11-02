import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE: every door that writes a person's rule for an agent seeds it on
 * the agent's box, and every door that takes a rule back takes its seed back
 * (host-seed.ts; computers plan v2 §4 K2, decision c83e0661).
 *
 * Why it can break: a new rule writer that forgets `seedHostRules` leaves an
 * agent on its own box asking for what the person approved (the host step
 * keeps the stricter verdict); a new revoker that forgets `revokeHostSeeds`
 * leaves the box allowed after the person took the approval back — a widening
 * nobody approved any more.
 *
 * HOW: the scanned set is DERIVED — every non-test .ts file of the api and
 * database packages that inserts into, or revokes in, `governance_rules`. In
 * each, the number of `seedHostRules(` calls must be at least the number of
 * inserts, and the number of seed-revoke calls at least the number of
 * updates. A file that writes only rules that are never seeded is listed in
 * EXEMPT with the reason; an exemption that no longer writes rules fails.
 *
 * WHAT IT DOES NOT SEE: a call placed on the wrong branch of the same file;
 * granularity is the count per file. The pglite test
 * `database/src/utils/host-seed.pglite.test.ts` holds the behaviour.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, "../../..");
const ROOTS = [join(PACKAGES, "api/src"), join(PACKAGES, "database/src")];

/** path (from packages/) → why its rule writes are never seeded. */
const EXEMPT: Record<string, string> = {
  "database/src/utils/host-seed.ts": "the seed door itself",
  "api/src/routers/proposals/apply-approval.ts":
    "legacy governance.tighten_lane writes only `propose` rules (never seeded)",
  "api/src/services/session-document/ensure-narrative-rule.ts":
    "the narrative agent's own rule: a pod agent, no computer",
  "api/src/services/capture-agent/ensure-capture-agent.ts":
    "the capture agent's own rules: a pod agent, no computer",
  "api/src/services/forms/form-service.ts":
    "a form's own agent: a pod agent, no computer",
  "database/src/utils/backfill-governance-rules.ts":
    "the boot backfill of legacy settings, system-authored",
  "database/src/utils/connection-governance.ts":
    "connection rules: the agent resolver never matches them",
  "database/src/utils/reversible-default.ts":
    "the pod default: an `any` rule, no agent",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) ? [full] : [];
  });
}

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
const INSERT = /\.insert\(\s*governanceRules\s*\)/g;
const UPDATE = /\.update\(\s*governanceRules\s*\)/g;
const SEED = /\bseedHostRules\(/g;
const REVOKE_SEED = /\b(?:revokeHostSeeds|revokeAllHostSeedsOn)\(/g;

function scan() {
  return ROOTS.flatMap(sourceFiles).flatMap((file) => {
    const src = stripComments(readFileSync(file, "utf8"), "ts");
    const inserts = count(src, INSERT);
    const updates = count(src, UPDATE);
    if (inserts === 0 && updates === 0) return [];
    return [
      {
        path: relative(PACKAGES, file),
        inserts,
        updates,
        seeds: count(src, SEED),
        revokes: count(src, REVOKE_SEED),
      },
    ];
  });
}

describe("tripwire: every governance-rule door keeps the host seed", () => {
  const writers = scan();

  it("the patterns see a literal sample (a loosened regex cannot go blind)", () => {
    const sample = `await tx.insert(governanceRules).values(x);
      await db.update( governanceRules ).set(y);
      await seedHostRules(tx, rows); await revokeHostSeeds(db, ids);`;
    expect(count(sample, INSERT)).toBe(1);
    expect(count(sample, UPDATE)).toBe(1);
    expect(count(sample, SEED)).toBe(1);
    expect(count(sample, REVOKE_SEED)).toBe(1);
    // Non-vacuity: the scan found the doors this guard is about.
    expect(writers.map((w) => w.path)).toEqual(
      expect.arrayContaining([
        "api/src/services/proposals/gov-config.ts",
        "api/src/routers/governance-rules.ts",
        "database/src/utils/resolve-agent-governance-decision.ts",
      ])
    );
  });

  it("each rule insert has its seed, each revoke takes its seed back", () => {
    const offenders = writers
      .filter((w) => !EXEMPT[w.path])
      .filter((w) => w.seeds < w.inserts || w.revokes < w.updates)
      .map(
        (w) =>
          `${w.path}: ${w.inserts} insert(s) / ${w.seeds} seedHostRules, ${w.updates} update(s) / ${w.revokes} seed revoke(s)`
      );
    expect(
      offenders,
      "A governance_rules writer skips the host seed (host-seed.ts). Seed a written agent rule on its box (`seedHostRules`) and take a revoked rule's seed back (`revokeHostSeeds`), or list the file in EXEMPT with why its rules are never seeded."
    ).toEqual([]);
  });

  it("every exemption still writes rules (a stale exemption hides a new door)", () => {
    const paths = new Set(writers.map((w) => w.path));
    expect(Object.keys(EXEMPT).filter((p) => !paths.has(p))).toEqual([]);
  });
});
