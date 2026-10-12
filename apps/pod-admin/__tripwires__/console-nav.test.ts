import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";

import {
  consoleRedirects,
  DIAGNOSE_DESTINATION,
  NAV_ITEMS,
  SEARCH_DESTINATION,
} from "../lib/console-nav";
import {
  isBannedAdminPath,
  isMatcherExcluded,
  isSelfService,
} from "../lib/route-policy";

/**
 * The console's IA invariants. Each one is a defect that typechecks:
 *
 *   • an admin page under a self-service or matcher-excluded prefix renders
 *     with the wrong gate (or none) and nothing errors;
 *   • a moved page whose old URL is not redirected breaks every bookmark;
 *   • a palette category or diagnose section without a nav home links nowhere;
 *   • a nav word that forks from the vocabulary registry is the hand-written
 *     label map `.claude/rules/vocabulary.md` forbids.
 */

const NAV_IDS = new Set(NAV_ITEMS.map((i) => i.id));

describe("console nav", () => {
  it("has unique ids and unique hrefs", () => {
    expect(NAV_IDS.size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });

  it("never puts an admin page under a self-service or banned prefix", () => {
    const bad = NAV_ITEMS.filter((i) => i.audience === "admin").flatMap((i) =>
      [i.href, ...(i.match ?? [])].filter(
        (p) => isSelfService(p) || isMatcherExcluded(p) || isBannedAdminPath(p)
      )
    );
    expect(bad).toEqual([]);
  });

  it("gives members Home and Review only", () => {
    const memberIds = NAV_ITEMS.filter((i) => i.audience === "member").map(
      (i) => i.id
    );
    expect(memberIds.every((id) => ["home", "review"].includes(id))).toBe(true);
  });

  it("turns every legacy entry into a redirect", () => {
    const rules = consoleRedirects();
    for (const item of NAV_ITEMS) {
      for (const legacy of item.legacy ?? []) {
        expect(
          rules.some(
            (r) =>
              r.source === legacy.source &&
              r.destination === (legacy.destination ?? item.href) &&
              r.permanent === false &&
              (legacy.query
                ? r.has?.[0]?.key === legacy.query.key &&
                  r.has[0].value === legacy.query.value
                : r.has === undefined)
          ),
          `${item.id} ← ${legacy.source}`
        ).toBe(true);
      }
    }
  });

  it("never redirects a live nav page away", () => {
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
    const bareSources = consoleRedirects()
      .filter((r) => !r.has)
      .map((r) => r.source);
    expect(bareSources.filter((s) => hrefs.has(s))).toEqual([]);
  });

  it("uses the registry's plural for every kind-backed label", () => {
    const forked = NAV_ITEMS.filter(
      (i) => i.kind && resolveObjectNounPlural(i.kind) !== i.label
    ).map((i) => `${i.id}: ${i.label} ≠ ${resolveObjectNounPlural(i.kind)}`);
    expect(forked).toEqual([]);
  });
});

describe("every door has a nav home", () => {
  it("maps every search category to a nav item", () => {
    for (const [category, dest] of Object.entries(SEARCH_DESTINATION)) {
      expect(NAV_IDS.has(dest.nav), category).toBe(true);
    }
  });

  it("maps every diagnose section the server emits to a nav item", () => {
    // Read from the server's source, not a copy: a section added there must
    // be placed here before Home can route it.
    const dir = fileURLToPath(
      new URL("../../../packages/api/src/services/diagnose", import.meta.url)
    );
    const keys = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/\bkey:\s*"([a-z_]+)"/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(5);
    const unplaced = [...keys].filter((k) => !(k in DIAGNOSE_DESTINATION));
    expect(unplaced).toEqual([]);
    for (const [key, nav] of Object.entries(DIAGNOSE_DESTINATION)) {
      expect(NAV_IDS.has(nav), key).toBe(true);
    }
  });
});
