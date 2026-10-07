/**
 * TRIPWIRE — the space brief is DISCOVERABLE from the tools an agent already calls.
 *
 * The CAPABILITY is proven elsewhere: `orient-light-subtraction.test.ts:403`
 * ("orient pinned to a space serves its brief") shows a pinned orient returns
 * `brief` and an unpinned one carries no `brief` key at all. What no test could
 * see is whether an agent ever LEARNS that. The brief ships, and if no tool
 * says so, the agent never pins a space — and never sees the space's SKILLS,
 * which are the whole point of the brief.
 *
 * Measured 2026-10-07: `synap_orient` documented `workspaceId` only as "pin the
 * map (and the profile sample)"; `synap_set_workspace_focus` said nothing about
 * its reply carrying the brief; `synap_list_workspaces` told you how to find an
 * id, not what to do with one. The feature was reachable in code and invisible
 * in prose.
 *
 * How it reads: the REAL `tools.list()` every client is built from, matched on
 * a value — the door must NAME the brief (and, where the brief rides, its
 * `skills`), not merely contain the substring. A non-vacuity check proves the
 * reader can still see a literal sample, so a scan that starts matching nothing
 * fails rather than passes.
 *
 * What it CANNOT see: the wording. It catches a description that stops naming
 * the brief; it does not police HOW it is described. Verified by negative
 * control — reverting any one description to the pre-fix wording reds the
 * matching case and no other.
 */

import { describe, it, expect } from "vitest";
import { tools } from "./index.js";

/** Does the description NAME the space brief (value, not substring luck)? */
const namesBrief = (d: string) => /\bbrief\b/i.test(d);

async function descriptions(): Promise<Map<string, string>> {
  const defs = await tools.list();
  return new Map(defs.map((t) => [t.name, t.description ?? ""]));
}

describe("space-brief discoverability — the doors an agent already calls", () => {
  it("the reader is non-vacuous: it can see the brief named, and the set is real", async () => {
    const byName = await descriptions();
    // The three doors this guard is about must exist — a rename is caught here.
    for (const n of [
      "synap_orient",
      "synap_set_workspace_focus",
      "synap_list_workspaces",
    ]) {
      expect(byName.get(n), `${n} is missing from tools.list()`).toBeTruthy();
    }
    // Self-check: the matcher fires on a literal sample, so a green result can
    // never mean "the scan is blind".
    expect(namesBrief("…and orient returns that space's brief…")).toBe(true);
    expect(namesBrief("no such word here")).toBe(false);
  });

  it("synap_orient names the brief AND its skills on a pinned workspaceId", async () => {
    const orient = (await descriptions()).get("synap_orient")!;
    expect(namesBrief(orient)).toBe(true);
    // The agent must learn BOTH that pinning returns it and what rides in it —
    // the skills are the actionable half, so they are named too.
    expect(orient).toMatch(/workspaceId/);
    expect(orient).toMatch(/\bskills?\b/i);
  });

  it("synap_set_workspace_focus says its reply carries the brief", async () => {
    const focus = (await descriptions()).get("synap_set_workspace_focus")!;
    expect(namesBrief(focus)).toBe(true);
  });

  it("synap_list_workspaces points from an id to what to do with it", async () => {
    const list = (await descriptions()).get("synap_list_workspaces")!;
    expect(namesBrief(list)).toBe(true);
  });
});
