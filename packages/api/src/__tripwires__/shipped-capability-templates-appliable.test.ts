/**
 * TRIPWIRE — every SHIPPED capability template must be appliable.
 *
 * `POST /api/hub/capabilities/apply` is the ONE door that instantiates a
 * capability's {vault · tools · skills · playbooks · automations}. A template
 * that cannot get past that door's `CapabilityDefinitionSchema` is a template
 * that cannot install — and nothing caught that at author time, so it shipped
 * and failed in the founder's terminal instead:
 *
 *   HTTP 400 — path ["definition","skills"] — expected array, received undefined
 *
 * `discord-bot.capability.json` (a tools-only bridge) shipped with no `skills`
 * key at all while the door demanded one. Same defect class as the "10 stages
 * in 3 shipped capability templates" incident: an author-time shape the install
 * door rejects, discovered only by a human trying to install.
 *
 * This test parses EVERY shipped template through the SAME schema the door uses
 * — imported, never re-declared, so the two can't drift.
 *
 * Scanning discipline (house rule): read the directory ROOT recursively, never a
 * hardcoded file list, and assert corpus SIZE so silent coverage loss is visible.
 * A hardcoded list is how three seeds sat uncovered in the automations validator.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { CapabilityDefinitionSchema } from "../routers/hub-protocol/rest/capabilities.js";

// From packages/api/src/__tripwires__ up to the monorepo root (Code/synap).
const REPO_ROOT = join(import.meta.dirname, "../../../../..");

/**
 * Directory ROOTS scanned recursively for `*.capability.json`. Capability
 * templates are authored in the Control Plane seed catalog today; add a root
 * here (never individual files) if a second home ever appears.
 */
const TEMPLATE_ROOTS = [
  join(REPO_ROOT, "synap-control-plane-api/src/seeds/capability-templates"),
];

/** Floor, not the exact count — 25 templates shipped when this was written. */
const MIN_TEMPLATES = 20;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".capability.json")) out.push(full);
  }
  return out;
}

const rootsAvailable = TEMPLATE_ROOTS.every((r) => existsSync(r));
const TEMPLATE_FILES = rootsAvailable
  ? TEMPLATE_ROOTS.flatMap(walk).sort()
  : [];

describe("shipped capability templates are appliable", () => {
  it("can see the capability-template catalog it validates", () => {
    expect(
      rootsAvailable,
      `Cannot find ${TEMPLATE_ROOTS.join(", ")}. This tripwire validates the ` +
        `shipped capability templates against the apply door's schema, so it ` +
        `needs synap-control-plane-api checked out BESIDE synap-backend. Clone ` +
        `it there — do not delete or skip this test, that is how a template ` +
        `that cannot install shipped before.`
    ).toBe(true);
  });

  it(`is non-vacuous: found at least ${MIN_TEMPLATES} templates`, () => {
    expect(
      TEMPLATE_FILES.length,
      "capability-template corpus shrank — a scanner that matches nothing " +
        "makes every assertion below trivially true"
    ).toBeGreaterThanOrEqual(MIN_TEMPLATES);
  });

  for (const file of TEMPLATE_FILES) {
    const rel = file.slice(REPO_ROOT.length + 1);

    it(`${rel} parses through CapabilityDefinitionSchema`, () => {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const result = CapabilityDefinitionSchema.safeParse(raw);
      // Surface the actual zod issues if this ever regresses — the founder-facing
      // 400 body is exactly this list.
      expect(
        result.success ? [] : result.error.issues,
        `${rel} would be rejected by POST /capabilities/apply`
      ).toEqual([]);
      expect(result.success).toBe(true);
    });
  }
});

/**
 * The shipped-template corpus above pins `tools: []` / `skills: []` — key
 * PRESENT, array empty. The 400 that actually blocked `synap bridge-setup`
 * was a different shape: the telegram-discord-bridge's inline
 * `CAPABILITY_DEFINITION` (its own repo, so not scannable here) declares only
 * `vault` + `tools` and OMITS `skills` entirely, yielding
 * `path: ["definition","skills"], code: "invalid_type"`.
 *
 * `.optional()` and `.default([])` are what make the absent-key case pass, and
 * only `.default([])` makes the applier's `for (const s of def.skills)` safe
 * afterwards. A future tightening back to a bare `z.array(...)` would leave
 * the corpus above green and re-break the bridge — so pin the absent-key
 * shape explicitly.
 */
describe("capability definitions may OMIT tools/skills entirely", () => {
  const base = {
    key: "discord-bot",
    name: "Discord Bot",
    description: "Bridge transport",
  };

  it("bridge-shaped definition (skills key absent) parses and normalizes to []", () => {
    const result = CapabilityDefinitionSchema.safeParse({
      ...base,
      tools: [],
    });
    expect(
      result.success ? [] : result.error.issues,
      "a tools-only capability must be appliable — this is the bridge's shape"
    ).toEqual([]);
    if (result.success) {
      expect(result.data.skills).toEqual([]);
      expect(result.data.tools).toEqual([]);
    }
  });

  it("skills-only definition (tools key absent) parses and normalizes to []", () => {
    const result = CapabilityDefinitionSchema.safeParse({
      ...base,
      skills: [],
    });
    expect(result.success ? [] : result.error.issues).toEqual([]);
    if (result.success) expect(result.data.tools).toEqual([]);
  });

  it("both keys absent still parses (neither is load-bearing for identity)", () => {
    const result = CapabilityDefinitionSchema.safeParse(base);
    expect(result.success ? [] : result.error.issues).toEqual([]);
    if (result.success) {
      expect(result.data.tools).toEqual([]);
      expect(result.data.skills).toEqual([]);
    }
  });
});
