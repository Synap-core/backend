/**
 * TRIPWIRE — every key scope is classified once: named by a key USE, or not
 * derived with its reason (keys plan Decision 2, 2026-10-27: "scopes as uses
 * in words, derived server-side").
 *
 * The `use → scope` table lives in `@synap-core/types/grants` (`KEY_USES`),
 * which cannot import the database (`API_KEY_SCOPES`). This guard pins the two
 * together: KEY_USE_SCOPES ∪ KEY_SCOPES_NOT_DERIVED must EQUAL API_KEY_SCOPES,
 * with no scope in both. A new scope fails here until someone decides which
 * door it is; a renamed one fails as both "unknown" and "unclassified".
 * Privileged scopes (`PRIVILEGED_MINT_SCOPES`) must be among the not-derived:
 * no page use may ever open them.
 *
 * NOT COVERED (stated): whether each use names the RIGHT scope for its door
 * (that `mcp` is the scope `/mcp` checks) is the reviewed table itself; the
 * mint door's derivation is driven end to end in
 * `routers/api-keys.uses-derive.pglite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { API_KEY_SCOPES, PRIVILEGED_MINT_SCOPES } from "@synap/database/schema";
import {
  KEY_SCOPES_NOT_DERIVED,
  KEY_USE_SCOPES,
  KEY_USES,
} from "@synap-core/types/grants";

const all = new Set<string>(API_KEY_SCOPES);
const derived = new Set(KEY_USE_SCOPES);
const notDerived = new Set(Object.keys(KEY_SCOPES_NOT_DERIVED));

describe("key uses ↔ API key scopes", () => {
  it("non-vacuous: both sides hold real scopes", () => {
    expect(all.size).toBeGreaterThanOrEqual(15);
    expect(KEY_USES.length).toBeGreaterThanOrEqual(5);
    expect(derived.has("hub-protocol.write")).toBe(true);
    expect(notDerived.has("setup.agent")).toBe(true);
  });

  it("every scope a use names is a real scope", () => {
    expect([...derived].filter((s) => !all.has(s)).sort()).toEqual([]);
    expect([...notDerived].filter((s) => !all.has(s)).sort()).toEqual([]);
  });

  it("every real scope is classified exactly once", () => {
    const unclassified = [...all].filter(
      (s) => !derived.has(s) && !notDerived.has(s)
    );
    const twice = [...all].filter((s) => derived.has(s) && notDerived.has(s));
    expect(
      unclassified.sort(),
      "A new API key scope: name it in a KEY_USES row or in KEY_SCOPES_NOT_DERIVED with its reason (@synap-core/types/grants key-uses.ts)."
    ).toEqual([]);
    expect(twice.sort()).toEqual([]);
  });

  it("no use opens a privileged scope", () => {
    for (const s of PRIVILEGED_MINT_SCOPES) {
      expect(derived.has(s), s).toBe(false);
      expect(notDerived.has(s), s).toBe(true);
    }
  });
});
