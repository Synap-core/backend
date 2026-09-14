/**
 * TRIPWIRE — the "where are property schemas?" pointers do not loop.
 *
 * Measured 2026-09-14: `synap_list_profiles` said "for full property schemas
 * use synap_orient or GET /discover", and `synap_orient` said "for entity types
 * and their property schemas, use the profile-listing tool". Neither carries a
 * property schema, so an agent following either pointer ends where it started.
 *
 * How it reads the descriptions (derived from the real `tools.list()`, the
 * array the manifest and every client are built from):
 *   - a SENTENCE is a schema pointer when it mentions "schema" and a directing
 *     verb (use / call / see / "for … schema");
 *   - the tools it points at are the `synap_*` names in that sentence, plus
 *     the door-neutral alias "profile-listing tool" → synap_list_profiles.
 * Assertion: neither of the two tools points the other at schemas, and
 * list_profiles still names a REAL schema source (the discover door).
 *
 * What it cannot see: a pointer phrased without "schema" (e.g. "for fields and
 * enums, call synap_orient"). Verified by negative control against the pre-fix
 * descriptions; the regex boundary is written here rather than implied.
 */

import { describe, it, expect } from "vitest";
import { tools } from "./index.js";

const ALIASES: Array<[RegExp, string]> = [
  [/profile-listing tool/i, "synap_list_profiles"],
];

function schemaPointerTargets(description: string): string[] {
  const sentences = description.split(/(?<=[.!?])\s+/);
  const out = new Set<string>();
  for (const s of sentences) {
    if (!/schema/i.test(s)) continue;
    if (!/\b(use|call|see)\b|\bfor\b[^.]*schema/i.test(s)) continue;
    for (const m of s.match(/synap_[a-z_]+/g) ?? []) out.add(m);
    for (const [re, name] of ALIASES) if (re.test(s)) out.add(name);
  }
  return [...out];
}

describe("schema pointers between list_profiles and orient", () => {
  it("do not point at each other", async () => {
    const defs = await tools.list();
    const byName = new Map(defs.map((t) => [t.name, t.description ?? ""]));
    const listProfiles = byName.get("synap_list_profiles");
    const orient = byName.get("synap_orient");
    // Non-vacuity: both tools exist and the reader can still see a pointer.
    expect(listProfiles).toBeTruthy();
    expect(orient).toBeTruthy();
    expect(
      schemaPointerTargets(
        "For full property schemas use synap_orient or GET /discover."
      )
    ).toEqual(["synap_orient"]);

    expect(schemaPointerTargets(listProfiles!)).not.toContain("synap_orient");
    expect(schemaPointerTargets(orient!)).not.toContain("synap_list_profiles");
  });

  it("list_profiles names a real property-schema source", async () => {
    const defs = await tools.list();
    const listProfiles = defs.find((t) => t.name === "synap_list_profiles")!;
    expect(listProfiles.description).toContain(
      "/api/hub/discover?profileSlugs="
    );
    // …and one an MCP-ONLY agent (no HTTP, no CLI) can actually call.
    const mcpSource = defs.find((t) => t.name === "synap_get_entity");
    expect(mcpSource).toBeTruthy();
    expect(listProfiles.description).toMatch(
      /synap_get_entity[^.]*effectiveProperties/
    );
  });
});
