/**
 * Firewalls for the from-intent conductor: the topic files exist, catalog
 * teaching points at them, and agent-os is NOT the schema/intent conductor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../skills"
);

describe("from-intent conductor firewalls", () => {
  it("conductor + extend-first topics exist", () => {
    expect(existsSync(join(ROOT, "synap/from-intent.md"))).toBe(true);
    expect(existsSync(join(ROOT, "synap-schema/extend-first.md"))).toBe(true);
  });

  it("from-intent says hats are any kind and defers domain install to agent-os", () => {
    const src = readFileSync(join(ROOT, "synap/from-intent.md"), "utf8");
    expect(src).toMatch(/any kind/i);
    expect(src).toMatch(/agent-os/);
    expect(src).toMatch(/extend-first/);
    expect(src).toMatch(/one next write/i);
    expect(src).toMatch(/twin/);
    expect(src).toMatch(/7-step/);
    expect(src.length).toBeGreaterThan(400);
  });

  // 2026-09-20: the conductor became SESSION-FIRST and PLAN-FIRST once the
  // narrow doors gained a session lifecycle and `synap_capture` gained the
  // connected-plan lane. Before that, "ONE next write" + 40-odd flat tools was
  // an instruction to file N separate proposals — which is exactly what one
  // agent did, hitting the pending-proposal cap at 17 while building one pack.
  //
  // LIMITATION, stated rather than implied: this scans PROSE. It proves the
  // contract is still written down, not that an agent obeys it. It cannot see
  // an agent that reads the file and files fourteen proposals anyway.
  it("from-intent names the session as the unit of work, before structure", () => {
    const src = readFileSync(join(ROOT, "synap/from-intent.md"), "utf8");
    expect(src).toMatch(/synap_start_session/);
    // The session must be named in the ORIENT firewall (§0), not merely
    // mentioned later as one option among many — that was the old shape.
    const orient = src.slice(src.indexOf("### 0."), src.indexOf("### 1."));
    expect(orient.length).toBeGreaterThan(200);
    expect(orient).toMatch(/synap_start_session/);
  });

  it("from-intent teaches the connected PLAN as ONE proposal", () => {
    const src = readFileSync(join(ROOT, "synap/from-intent.md"), "utf8");
    expect(src).toMatch(/connected PLAN/i);
    expect(src).toMatch(/all-or-none/i);
    // The plan args an agent actually has to pass. A doc that says "use a plan"
    // without naming them sends the agent back to the flat tools.
    for (const arg of [
      "projects",
      "sessions",
      "documents",
      "links",
      "skills",
      "automations",
      "rules",
    ]) {
      expect(src, `plan arg ${arg} must be named`).toMatch(
        new RegExp(`\\b${arg}\\[\\]`)
      );
    }
    // The firewall that makes it bite.
    expect(src).toMatch(/Splitting one coherent structure into N proposals/i);
  });

  // 2026-09-20 — CAPABILITY LADDER. `proposeCapabilityEnable`, `tool.request`
  // and the package `require` dependency were all BUILT and governed, and
  // taught in ZERO skill files — measured. The only capability door an agent
  // knew was `market.install` (11 files), i.e. the heaviest and most
  // permission-shaped of them. That is this repo's recurring shape: built,
  // decided, unreachable.
  //
  // LIMITATION: prose scan. It proves the ladder is still written down and
  // still names REACHABLE doors; it cannot prove an agent climbs it.
  it("from-intent teaches the capability ladder, and only reachable doors", () => {
    const src = readFileSync(join(ROOT, "synap/from-intent.md"), "utf8");

    // The boundary, stated with its reason.
    expect(src).toMatch(/plan never installs a capability/i);

    // Every rung must name a door that EXISTS on an agent surface.
    for (const door of [
      "synap_list_capabilities",
      "synap_run_capability",
      "market.search",
      "market.install",
      "tool.request",
    ]) {
      expect(src, `capability ladder must name ${door}`).toContain(door);
    }

    // The trap this replaces: `proposeCapabilityEnable` is NOT agent-callable —
    // it fires automatically from `execute-capability.ts` when a draft skill is
    // refused. Teaching it as a tool would send an agent hunting for a door
    // that does not exist on any surface.
    expect(
      src,
      "proposeCapabilityEnable is internal — the skill must teach 'just run it', not a call"
    ).not.toContain("proposeCapabilityEnable");

    // Ordering advice that keeps the author-time rejection from biting.
    expect(src).toMatch(/author the automation LAST/i);
  });

  it("agent-os When NOT points at from-intent", () => {
    const src = readFileSync(join(ROOT, "agent-os/SKILL.md"), "utf8");
    expect(src).toMatch(/from-intent/);
    expect(src).toMatch(/When NOT to use this skill/);
  });

  it("_teaching.json lists both topics", () => {
    const json = JSON.parse(
      readFileSync(join(ROOT, "_teaching.json"), "utf8")
    ) as Record<string, unknown>;
    expect(json["synap/from-intent"]).toBeTruthy();
    expect(json["synap-schema/extend-first"]).toBeTruthy();
  });
});
