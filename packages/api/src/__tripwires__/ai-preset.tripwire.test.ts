/**
 * TRIPWIRE — the "AI — read & propose" preset covers every subject it should,
 * and nothing it must not.
 *
 * The preset lives in `@synap-core/types/grants`, which cannot import the two
 * sources it is built from (a build cycle). This guard DERIVES both here:
 *  - reads  = every subject in GRANT_READ_SPECS (the read hook);
 *  - writes = every create/update door in GATE_WRITE_DOORS.
 * Each must be permitted by the preset, at BOTH refusing layers — the key grant
 * (`grantRequestForWrite` + `permits`, which folds focus_session → session) and
 * the agent capability rung (`decideAgentPolicy` rung 1, which reads the raw
 * door subject) — or be listed in AI_PRESET_EXCLUSIONS with a reason. A new
 * door or read subject therefore fails here until someone decides.
 *
 * NOT COVERED (stated): doors whose verb is not create/update are asserted
 * REFUSED (no gate verb, no delete), not individually reviewed; a write path
 * that does not pass `checkPermissionOrPropose` (posting a channel message) is
 * outside both layers and outside this guard.
 */
import { describe, expect, it } from "vitest";
import { GATE_WRITE_DOORS, decideAgentPolicy } from "@synap/governance-policy";
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
  return { subject: d.slice(0, i), action: d.slice(i + 1) };
});
const writeDoors = doors.filter((d) => ["create", "update"].includes(d.action));
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
    expect(writeDoors.length).toBeGreaterThanOrEqual(40);
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

  it("creates/updates on every gated write subject at BOTH layers, or excludes it", async () => {
    const missing: string[] = [];
    for (const { subject, action } of writeDoors) {
      if (excluded(`${subject}.${action}`)) continue;
      if (!(await grantAllows(subject, action)))
        missing.push(`${subject}.${action} (key grant)`);
      if (!capabilityAllows(subject, action))
        missing.push(`${subject}.${action} (capability rung)`);
    }
    expect(
      missing,
      "Add the subject to AI_WRITE_SUBJECTS or AI_PRESET_EXCLUSIONS (types/grants/presets.ts)."
    ).toEqual([]);
  });

  it("refuses every exclusion, every delete and every other door verb", async () => {
    const leaks: string[] = [];
    for (const key of Object.keys(AI_PRESET_EXCLUSIONS)) {
      const [subject, action] = key.split(".") as [string, string];
      if (permits(SCOPE, { subject, action })) leaks.push(key);
    }
    for (const { subject, action } of doors) {
      if (action === "create" || action === "update") continue;
      if (await grantAllows(subject, action))
        leaks.push(`${subject}/${action} (key grant)`);
      if (capabilityAllows(subject, action))
        leaks.push(`${subject}/${action} (capability rung)`);
    }
    expect(leaks).toEqual([]);
  });

  it("every exclusion names a real read subject or write door", () => {
    const real = new Set([
      ...readSubjects.map((s) => `${s}.read`),
      ...writeDoors.map((d) => `${d.subject}.${d.action}`),
    ]);
    expect(
      Object.keys(AI_PRESET_EXCLUSIONS).filter((k) => !real.has(k))
    ).toEqual([]);
  });
});

describe("an agent holding the preset", () => {
  it("can start a session, link, build a view and define a kind", async () => {
    for (const [subject, action] of [
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
