/**
 * TRIPWIRE — the "AI — read & propose" preset covers every subject and verb it
 * should, and nothing it must not.
 *
 * The preset lives in `@synap-core/types/grants`, which cannot import the two
 * sources it is built from (a build cycle). This guard DERIVES both here:
 *  - reads = every subject in GRANT_READ_SPECS (the read hook);
 *  - doors = every door in GATE_WRITE_DOORS, folded to the grammar spelling by
 *    `grantRequestKey` (the fold every refusing layer uses).
 * Every door verb is CLASSIFIED: a destructive verb (DESTRUCTIVE_ACTIONS) or
 * `approve` must be refused; every other verb — create, update and each gate
 * verb — must be permitted at BOTH refusing layers, the key grant
 * (`grantRequestForWrite` + `permits`) and the agent capability rung
 * (`decideAgentPolicy` rung 1), or be listed in AI_PRESET_EXCLUSIONS with a
 * reason (and then be refused at both). A new door fails here until decided.
 *
 * NOT COVERED (stated): a write path that does not pass
 * `checkPermissionOrPropose` (posting a channel message) is outside both
 * layers and outside this guard.
 */
import { describe, expect, it } from "vitest";
import {
  DESTRUCTIVE_ACTIONS,
  GATE_WRITE_DOORS,
  decideAgentPolicy,
  grantRequestKey,
} from "@synap/governance-policy";
import { permits } from "@synap/governance-policy/grants";
import {
  AI_PRESET_EXCLUSIONS,
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
  MAX_GRANT_PERMISSIONS,
} from "@synap-core/types/grants";
import { secrets } from "@synap/database/schema";
import { GRANT_READ_SPECS, grantReadClause } from "../access/grant-read.js";
import { grantRequestForWrite } from "../utils/grant-write-check.js";

const PRESET = GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
  .grant.permissions;
const SCOPE = { permissions: PRESET };

const readSubjects = [
  ...new Set([...GRANT_READ_SPECS.values()].map((s) => s.subject)),
];
const doors = Object.keys(GATE_WRITE_DOORS).map((d) => {
  const i = d.indexOf("/");
  const raw = { subject: d.slice(0, i), action: d.slice(i + 1) };
  const key = grantRequestKey(raw.subject, raw.action);
  return { ...raw, key: `${key.subject}.${key.action}`, verb: key.action };
});
const refusedVerb = (verb: string) =>
  DESTRUCTIVE_ACTIONS.includes(verb) || verb === "approve";
const grantedDoors = doors.filter((d) => !refusedVerb(d.verb));
const excluded = (key: string) => key in AI_PRESET_EXCLUSIONS;

/** The key grant's answer for a gate door (the same request the gate builds). */
async function grantAllows(subjectType: string, action: string) {
  const req = await grantRequestForWrite({
    subjectType,
    action,
    data: subjectType === "entity" ? { profileSlug: "note" } : {},
  });
  return permits(SCOPE, req);
}

/** The agent capability rung's answer (rung 1 of decideAgentPolicy). */
function capabilityAllows(subjectType: string, action: string) {
  const v = decideAgentPolicy({
    subjectType,
    action,
    agentCapabilities: [...PRESET],
    subjectKind: subjectType === "entity" ? "note" : undefined,
  } as Parameters<typeof decideAgentPolicy>[0]);
  return v.verdict !== "deny";
}

describe("AI preset coverage (derived from the read hook and the write doors)", () => {
  it("scans real sources (non-vacuity)", () => {
    expect(readSubjects.length).toBeGreaterThanOrEqual(25);
    expect(grantedDoors.length).toBeGreaterThanOrEqual(60);
    expect(doors.some((d) => d.key === "view.update_content")).toBe(true);
    expect(PRESET.length).toBeGreaterThan(30);
    expect(PRESET.length).toBeLessThanOrEqual(MAX_GRANT_PERMISSIONS);
  });

  it("reads every read-hook subject, or excludes it with a reason", () => {
    const missing = readSubjects.filter(
      (s) =>
        !excluded(`${s}.read`) &&
        !permits(SCOPE, { subject: s, action: "read" })
    );
    expect(
      missing,
      "Add the subject to AI_READ_SUBJECTS or AI_PRESET_EXCLUSIONS (types/grants/presets.ts)."
    ).toEqual([]);
  });

  it("holds every non-destructive door verb at BOTH layers, or excludes it", async () => {
    const missing: string[] = [];
    for (const { subject, action, key } of grantedDoors) {
      if (excluded(key)) continue;
      if (!(await grantAllows(subject, action)))
        missing.push(`${key} (key grant)`);
      if (!capabilityAllows(subject, action))
        missing.push(`${key} (capability rung)`);
    }
    expect(
      missing,
      "Add the verb to AI_WRITE_SUBJECTS / AI_GATE_VERBS or AI_PRESET_EXCLUSIONS (types/grants/presets.ts)."
    ).toEqual([]);
  });

  it("refuses every exclusion, every delete/archive/merge/purge and approve", async () => {
    const leaks: string[] = [];
    for (const { subject, action, key, verb } of doors) {
      if (!refusedVerb(verb) && !excluded(key)) continue;
      if (await grantAllows(subject, action)) leaks.push(`${key} (key grant)`);
      if (capabilityAllows(subject, action))
        leaks.push(`${key} (capability rung)`);
    }
    for (const key of Object.keys(AI_PRESET_EXCLUSIONS)) {
      const [subject, action] = key.split(".") as [string, string];
      if (permits(SCOPE, { subject, action })) leaks.push(key);
    }
    expect(leaks).toEqual([]);
  });

  it("rejects a proposal, never approves one", () => {
    expect(permits(SCOPE, { subject: "proposal", action: "reject" })).toBe(
      true
    );
    expect(permits(SCOPE, { subject: "proposal", action: "approve" })).toBe(
      false
    );
  });

  it("every exclusion names a real read subject or door", () => {
    const real = new Set([
      ...readSubjects.map((s) => `${s}.read`),
      ...doors.map((d) => d.key),
    ]);
    expect(
      Object.keys(AI_PRESET_EXCLUSIONS).filter((k) => !real.has(k))
    ).toEqual([]);
  });
});

describe("an agent holding the preset", () => {
  it("can start a session, link, build a view and define a kind", async () => {
    for (const [subject, action] of [
      ["facet", "attach"],
      ["document", "session_narrative_update"],
      ["playbook", "run"],
      ["channel", "create_branch"],
      ["view", "updateContent"],
      ["relationDef", "create"],
      ["focus_session", "create"],
      ["focus_session", "update"],
      ["link", "create"],
      ["view", "create"],
      // synap_define_kind → defineProfile: the kind, then its fields.
      ["profile", "create"],
      ["property_def", "create"],
      ["entity", "create"],
    ] as const) {
      expect(await grantAllows(subject, action), `${subject}.${action}`).toBe(
        true
      );
      expect(capabilityAllows(subject, action), `${subject}.${action}`).toBe(
        true
      );
    }
    // Posting to a channel is not a governed write: no door, no grant check.
    // Reading the room is granted.
    expect(permits(SCOPE, { subject: "channel", action: "read" })).toBe(true);
  });

  it("never runs a flow with the person's authority (founder rule)", async () => {
    // An automation, command or tool runs later as the human, outside this
    // agent's limits. The AI may draft an automation (created disabled).
    for (const [subject, action] of [
      ["automation", "activate"],
      ["automation", "execute"],
      ["command", "execute"],
      ["tool", "create"],
      ["tool", "update"],
    ] as const) {
      expect(await grantAllows(subject, action), `${subject}.${action}`).toBe(
        false
      );
      expect(capabilityAllows(subject, action), `${subject}.${action}`).toBe(
        false
      );
    }
    expect(await grantAllows("automation", "create")).toBe(true);
    expect(await grantAllows("facet", "detach")).toBe(true);
  });

  it("is refused delete, approve and the vault", async () => {
    expect(await grantAllows("entity", "delete")).toBe(false);
    expect(capabilityAllows("entity", "delete")).toBe(false);
    expect(permits(SCOPE, { subject: "proposal", action: "approve" })).toBe(
      false
    );
    expect(await grantAllows("vault", "grant")).toBe(false);
    expect(capabilityAllows("vault", "grant")).toBe(false);
    // The read hook narrows secrets to nothing (a full `*` grant adds no clause).
    expect(grantReadClause(secrets, SCOPE)).toBeDefined();
    expect(grantReadClause(secrets, { permissions: ["*"] })).toBeUndefined();
  });
});
