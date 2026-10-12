import { describe, expect, it } from "vitest";
import {
  AI_GATE_VERBS,
  AI_PRESET_EXCLUSIONS,
  AI_READ_PROPOSE_ROLE_ID,
  AI_READ_SUBJECTS,
  AI_WRITE_SUBJECTS,
  GRANT_PRESETS,
  agentKeyGrantPermissions,
  aiDefaultCapabilities,
} from "./presets.js";
import { MAX_GRANT_PERMISSIONS } from "./draft.js";
import {
  GRANT_GATE_ACTIONS,
  assertPermissions,
  patternMatches,
  type GrantRequest,
} from "./grammar.js";

const preset = GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!;
const perms = preset.grant.permissions;
const allows = (p: readonly string[], req: GrantRequest) =>
  p.some((x) => patternMatches(x, req));

describe("AI — read & propose", () => {
  it("is the renamed agent preset, valid and within the per-grant cap", () => {
    expect(preset.name).toBe("AI — read & propose");
    expect(() => assertPermissions(perms)).not.toThrow();
    expect(perms.length).toBeLessThanOrEqual(MAX_GRANT_PERMISSIONS);
    expect(aiDefaultCapabilities()).toEqual([...perms]);
  });

  it("reads every listed subject and creates/updates every listed write subject", () => {
    for (const s of AI_READ_SUBJECTS)
      expect(allows(perms, { subject: s, action: "read" }), s).toBe(true);
    for (const [s, actions] of Object.entries(AI_WRITE_SUBJECTS))
      for (const action of actions)
        expect(
          allows(perms, { subject: s, qualifier: "note", action }),
          `${s}.${action}`
        ).toBe(true);
  });

  it("never deletes, never names a gate verb, never touches an exclusion", () => {
    // The two gate verbs it does hold: rejecting a proposal (an agent withdraws
    // its own work) and a lifecycle status move — reversible, the move an
    // entity.update used to carry before the status door split it out, with
    // done/lost and humanOnly options still floored at the door.
    const held = (subject: string, action: string) =>
      (subject === "proposal" && action === "reject") ||
      (subject === "entity" && action === "transition");
    const subjects = [
      ...AI_READ_SUBJECTS,
      ...Object.keys(AI_WRITE_SUBJECTS),
      "vault",
      "workspace",
      "rule",
    ];
    for (const subject of subjects) {
      expect(allows(perms, { subject, action: "delete" }), subject).toBe(false);
      for (const action of GRANT_GATE_ACTIONS)
        expect(allows(perms, { subject, action }), `${subject}.${action}`).toBe(
          held(subject, action)
        );
    }
    for (const key of Object.keys(AI_PRESET_EXCLUSIONS)) {
      const [subject, action] = key.split(".");
      expect(allows(perms, { subject, action }), key).toBe(false);
    }
  });
});

describe("AI — read & propose: the gate verbs", () => {
  it("rejects a proposal, never approves one", () => {
    expect(allows(perms, { subject: "proposal", action: "reject" })).toBe(true);
    expect(allows(perms, { subject: "proposal", action: "approve" })).toBe(
      false
    );
  });
  it("holds each named daily verb, and no exclusion", () => {
    for (const v of AI_GATE_VERBS) {
      const segs = v.split(".");
      const req =
        segs.length === 3
          ? { subject: segs[0], qualifier: "note", action: segs[2] }
          : { subject: segs[0], action: segs[1] };
      expect(allows(perms, req), v).toBe(true);
      expect(Object.keys(AI_PRESET_EXCLUSIONS)).not.toContain(v);
    }
  });
  it("lists sessions once, in the grammar spelling", () => {
    expect(perms.some((p) => p.startsWith("focus_session"))).toBe(false);
    expect(perms).toContain("session.create");
  });
});

describe("agentKeyGrantPermissions — an agent's key grant from its capabilities", () => {
  it("[] / * / *.* stay full access", () => {
    for (const caps of [
      [],
      null,
      undefined,
      ["*"],
      ["*.*"],
      ["entity.read", "*.*"],
    ])
      expect(agentKeyGrantPermissions(caps).permissions).toEqual(["*"]);
  });

  it("keeps the capability patterns and adds every read (reads are never bounded)", () => {
    const { permissions, dropped } = agentKeyGrantPermissions([
      "entity.note.create",
    ]);
    expect(dropped).toEqual([]);
    expect(
      allows(permissions, {
        subject: "entity",
        qualifier: "note",
        action: "create",
      })
    ).toBe(true);
    expect(
      allows(permissions, {
        subject: "entity",
        qualifier: "task",
        action: "create",
      })
    ).toBe(false);
    expect(allows(permissions, { subject: "document", action: "read" })).toBe(
      true
    );
    expect(allows(permissions, { subject: "vault", action: "read" })).toBe(
      false
    );
  });

  it("the preset round-trips as itself", () => {
    expect(agentKeyGrantPermissions(perms).permissions).toEqual([...perms]);
  });

  it("drops a pattern that does not parse — narrower, never wider", () => {
    const { permissions, dropped } = agentKeyGrantPermissions([
      "projectMember.create",
      "shell",
    ]);
    expect(dropped).toEqual(["projectMember.create"]);
    expect(permissions).toContain("shell");
    expect(permissions).not.toContain("*");
  });
});
