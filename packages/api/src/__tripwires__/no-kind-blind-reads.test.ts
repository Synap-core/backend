import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — no NEW kind-blind reads (`eq(entities.type, …)`).
 *
 * After Kind+Facets, a role-wearer's `entities.type` is its PRIMARY kind
 * (person/company/item), NOT the role slug it wears — so filtering entities with
 * `eq(entities.type, slug)` is row-blind: it silently misses every facet-wearer
 * (and every twin profile row that shares a slug). The canonical polymorphic
 * read door is `profileSlugScopeCondition` / `profileScopeConditions`
 * (facet-resolution-service.ts), which ORs the kind branch with a facet EXISTS.
 *
 * The current tree still carries a grandfathered set of `eq(entities.type, …)`
 * uses — some legitimate (literal PRIMARY-kind filters like "file"/"event",
 * and the door's own kind branch), some pre-existing kind-blind debt on dynamic
 * profile slugs. This tripwire FREEZES that set as a ratchet: the debt may
 * shrink freely, but it may not grow and no NEW file may introduce the pattern.
 * When you fix one, lower its count here; when a build fails, you added one —
 * use `profileSlugScopeCondition` instead.
 *
 * SCOPE: every `packages/<pkg>/src` in the backend monorepo, skipping tests /
 * .d.ts / dist.
 */

const TOKEN = /eq\(entities\.type,/g;

// cwd is packages/api; the backend repo root is two levels up.
const REPO_ROOT = join(process.cwd(), "..", "..");
const PACKAGES = join(REPO_ROOT, "packages");

// Frozen baseline — repo-root-relative path → current occurrence count. The
// live scan may be <= each entry (fixes) but never > (growth) and never add a
// key (new file). facet-resolution-service.ts is the DOOR (its kind branch is
// the canonical implementation, not a violation).
const FROZEN: Record<string, number> = {
  "packages/api/src/routers/devplane.ts": 2,
  // Wave 3 router-decomposition (2026-08-12) split entities.ts by domain — a
  // path re-key, not a debt change. `list`'s facet-vs-kind branching kept its
  // 1 occurrence in entities/read.ts; adminList's search filter +adminBatch-
  // Delete's id-list filter kept their 2 in entities/admin.ts.
  "packages/api/src/routers/entities/read.ts": 1,
  "packages/api/src/routers/entities/admin.ts": 2,
  // file-upload.ts previously filtered GET /:entityId/url on eq(entities.type,
  // "file"); it now resolves bytes via entities.documentId instead, so the
  // pattern is gone (0 occurrences) — entry removed.
  "packages/api/src/routers/hub.ts": 2,
  "packages/api/src/routers/webhooks-inbound.ts": 1,
  "packages/api/src/services/event-end/run-event-end.ts": 1,
  "packages/api/src/services/event-sync/run-event-sync.ts": 1,
  // Layer-2 dedup queries `event` by (start-window, title) — `event` is a pure
  // PRIMARY kind (no role/facet wearers), the sanctioned literal-kind case.
  "packages/api/src/services/event-sync/run-gcal-import.ts": 1,
  "packages/api/src/utils/assert-known-profile-slug.ts": 1, // JSDoc: names the row-blind fallback it deliberately preserves, not code
  "packages/api/src/utils/user-scoped.ts": 1, // JSDoc example, not code
  "packages/database/src/repositories/entity-repository.ts": 1,
  "packages/database/src/services/facet-resolution-service.ts": 1, // the DOOR
  "packages/database/src/utils/materialize-entity.ts": 1,
  // automation-executor.ts was split by step-family (router-decomposition Wave
  // 2, 2026-08-12) — a path re-key, not a debt change. The `entity_create`
  // dedup-lookup call (`eq(entities.type, profileSlug)`) plus a JSDoc comment
  // in `entity_update` that names the same pattern as prose landed in
  // steps/output.ts (2); the `query` node's profileSlug filter landed in
  // steps/query.ts (1).
  "packages/jobs/src/workers/steps/output.ts": 2,
  "packages/jobs/src/workers/steps/query.ts": 1,
  "packages/jobs/src/workers/crm-daily-digest.ts": 1,
  "packages/jobs/src/workers/proactive-intelligence.ts": 1,
  // pod-hygiene-near-dup.ts scans SCAN_KINDS = ["person", "company"] — both
  // pure PRIMARY kinds with no role wearers, the sanctioned literal-kind case
  // (same shape as event-sync's `event` dedup above).
  "packages/jobs/src/workers/pod-hygiene-near-dup.ts": 1,
  // team-roster-context.ts filters eq(entities.type, "person") — 'person' is a
  // primary kind, not a role slug; the tripwire's pattern-match alone can't
  // tell a sanctioned literal-kind read from row-blind role-slug debt, so this
  // is a false positive, not code to fix.
  "packages/api/src/services/team-roster-context.ts": 1,
};

function tsFilesUnderSrc(pkgRoot: string, acc: string[]): void {
  let src: string;
  try {
    src = join(pkgRoot, "src");
    readdirSync(src);
  } catch {
    return;
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      )
        acc.push(p);
    }
  };
  walk(src);
}

function liveCounts(): Record<string, number> {
  const acc: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (pkg.isDirectory()) tsFilesUnderSrc(join(PACKAGES, pkg.name), acc);
  }
  const counts: Record<string, number> = {};
  for (const f of acc) {
    const n = (readFileSync(f, "utf8").match(TOKEN) ?? []).length;
    if (n > 0) counts[relative(REPO_ROOT, f)] = n;
  }
  return counts;
}

describe("tripwire: no new kind-blind reads (eq(entities.type, …))", () => {
  it("introduces no eq(entities.type, …) in a file outside the frozen baseline", () => {
    const live = liveCounts();
    const newFiles = Object.keys(live).filter((f) => !(f in FROZEN));
    expect(newFiles).toEqual([]);
  });

  it("grows no file's eq(entities.type, …) count beyond the frozen baseline", () => {
    const live = liveCounts();
    const grown = Object.entries(live)
      .filter(([f, n]) => f in FROZEN && n > FROZEN[f])
      .map(([f, n]) => `${f}: ${n} > frozen ${FROZEN[f]}`);
    expect(grown).toEqual([]);
  });
});
