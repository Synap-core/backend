import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS,
  DESTRUCTIVE_ACTIONS,
  GATE_WRITE_DOORS,
  OWN_ORGANISE_CLASS_PATTERN,
  OWN_ORGANISE_DESTRUCTIVE_EVENT_KEYS,
  OWN_ORGANISE_EVENT_KEYS,
  PROPOSE_REASON,
  decideAgentPolicy,
  findMatchingPattern,
  isOwnOrganiseDestructiveWrite,
  isOwnOrganiseWrite,
  matchesActionPattern,
} from "./index.js";

/**
 * FB1020 B3 — "an agent organises its OWN FRESH work directly": ONE
 * `governance_rules` row (`@own-organise`, verdict auto) at rung 2.8, which
 * covers a write only when its door PROVED the subjects are the agent's own
 * fresh work (`ownWorkOrganise`). These pin the engine half:
 *
 *  - the class row executes exactly the three organise writes with the proof;
 *  - NO other `auto` row (`@reversible`, a glob, `*`) widens an organise write
 *    — the discriminating input: `focus_session.update` IS reversible and IS
 *    on the default whitelist, so without the 2.8 skip + 2.87 default a
 *    session filing would auto-apply with the class switched off;
 *  - class off ⇒ the SAME verdict and reason the door's floor gave before;
 *  - every floor above 2.8 still wins; a proof on any other key fails closed.
 *
 * NOT covered here: whether the proof is TRUE (that is `isOwnFreshWork` and
 * the doors, tested on PGlite in @synap/api) and which row the resolver hands
 * the engine (`resolveGovernanceRule`, @synap/database).
 */

const split = (key: string) => {
  const dot = key.indexOf(".");
  return { subjectType: key.slice(0, dot), action: key.slice(dot + 1) };
};
const classAuto = {
  governanceRuleVerdict: "auto" as const,
  governanceRuleId: "rule-own",
  governanceRuleIsOwnOrganise: true,
};
const TERMINAL = { intoTerminal: true, humanOnly: false };

describe("the own-organise class — shape", () => {
  it("covers exactly the six organise writes, each a real gate door", () => {
    expect([...OWN_ORGANISE_EVENT_KEYS].sort()).toEqual([
      "entity.create",
      "entity.transition",
      "entity.update",
      "focus_session.update",
      "link.delete",
      "project.file_entities",
    ]);
    for (const key of OWN_ORGANISE_EVENT_KEYS) {
      expect(Object.keys(GATE_WRITE_DOORS)).toContain(key.replace(".", "/"));
      expect(ADMIN_ACTIONS.includes(key)).toBe(false);
      // The ONE destructive organise write is named (D7 Q2), never implied.
      expect(DESTRUCTIVE_ACTIONS.includes(split(key).action)).toBe(
        isOwnOrganiseDestructiveWrite(key)
      );
    }
    expect([...OWN_ORGANISE_DESTRUCTIVE_EVENT_KEYS]).toEqual(["link.delete"]);
    expect(isOwnOrganiseWrite("entity.delete")).toBe(false);
    expect(isOwnOrganiseWrite("track.create")).toBe(false);
  });

  it("the pattern matches NOTHING through a list or glob (only the resolver, with the proof)", () => {
    for (const key of OWN_ORGANISE_EVENT_KEYS) {
      expect(matchesActionPattern(key, [OWN_ORGANISE_CLASS_PATTERN])).toBe(
        false
      );
    }
    expect(
      findMatchingPattern("project.file_entities", ["@own-organise"])
    ).toBe(undefined);
  });
});

describe("the own-organise class — verdicts", () => {
  it("class row + proof ⇒ execute, naming the rule (filing, session filing)", () => {
    for (const key of ["project.file_entities", "focus_session.update"]) {
      expect(
        decideAgentPolicy({
          ...split(key),
          ownWorkOrganise: true,
          ...classAuto,
        })
      ).toEqual({ verdict: "execute", governanceRuleId: "rule-own" });
    }
  });

  it("class row + proof closes its own task (a terminal move a broad rule never widens)", () => {
    expect(
      decideAgentPolicy({
        ...split("entity.transition"),
        lifecycleMove: TERMINAL,
        ownWorkOrganise: true,
        ...classAuto,
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-own" });
  });

  it("NO other auto row widens an organise write — @reversible / glob proposes as before", () => {
    const other = {
      governanceRuleVerdict: "auto" as const,
      governanceRuleIsOwnOrganise: false,
    };
    expect(
      decideAgentPolicy({
        ...split("focus_session.update"),
        ownWorkOrganise: true,
        ...other,
      })
    ).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
      reasonCode: "SCOPE_IDENTITY_CHANGE",
    });
    expect(
      decideAgentPolicy({
        ...split("project.file_entities"),
        ownWorkOrganise: true,
        ...other,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "PROJECT_FILING" });
    expect(
      decideAgentPolicy({
        ...split("entity.transition"),
        lifecycleMove: TERMINAL,
        ownWorkOrganise: true,
        ...other,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "LIFECYCLE_TERMINAL" });
  });

  it("class switched off (no rule) ⇒ the same verdict and reason the floor gave before", () => {
    const before = (key: string) =>
      decideAgentPolicy({ ...split(key), forcePropose: true });
    for (const key of ["project.file_entities", "focus_session.update"]) {
      expect(
        decideAgentPolicy({ ...split(key), ownWorkOrganise: true })
      ).toEqual(before(key));
    }
    expect(
      decideAgentPolicy({
        ...split("entity.transition"),
        lifecycleMove: TERMINAL,
        ownWorkOrganise: true,
      })
    ).toEqual(
      decideAgentPolicy({
        ...split("entity.transition"),
        lifecycleMove: TERMINAL,
      })
    );
  });

  it("a person's `propose` rule outranking the class still tightens", () => {
    expect(
      decideAgentPolicy({
        ...split("project.file_entities"),
        ownWorkOrganise: true,
        governanceRuleVerdict: "propose",
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "GOVERNANCE_RULE" });
  });

  it("the class row WITHOUT the proof never executes an organise write", () => {
    expect(
      decideAgentPolicy({
        ...split("project.file_entities"),
        forcePropose: true,
        ...classAuto,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "PROJECT_FILING" });
  });
});

describe("the own-organise class — safety tripwire (floors still win)", () => {
  it("a proof on any key outside the class fails closed — delete, admin, scope change", () => {
    for (const key of [
      "entity.delete",
      "workspace.update",
      "projectMember.create",
      "relation.expose",
      "track.create",
      "link.create",
      "relation.delete",
    ]) {
      const v = decideAgentPolicy({
        ...split(key),
        ownWorkOrganise: true,
        ...classAuto,
      });
      expect({ key, verdict: v.verdict }).toEqual({ key, verdict: "propose" });
    }
  });

  it("a human-only option, an untrusted origin and the daily ceiling still propose", () => {
    expect(
      decideAgentPolicy({
        ...split("entity.transition"),
        lifecycleMove: { intoTerminal: true, humanOnly: true },
        ownWorkOrganise: true,
        ...classAuto,
      })
    ).toMatchObject({ verdict: "propose", reasonCode: "HUMAN_ONLY_STATUS" });
    expect(
      decideAgentPolicy({
        ...split("project.file_entities"),
        ownWorkOrganise: true,
        originTrust: "untrusted",
        ...classAuto,
      })
    ).toMatchObject({ verdict: "propose" });
    expect(
      decideAgentPolicy({
        ...split("project.file_entities"),
        ownWorkOrganise: true,
        ceilingVerdict: "propose",
        ...classAuto,
      })
    ).toMatchObject({ verdict: "propose" });
  });
});

/**
 * D7 (founder, 2026-10-28): Q2 own `blocked_by` removal, "own renames" (a
 * re-type of its own fresh record) and Q3 relayed decisions. The
 * discriminating inputs: `link.delete` is DESTRUCTIVE (rung 2.5 must let it
 * through only WITH the proof), `entity.update` / `entity.create` are
 * REVERSIBLE (so `@reversible` must not widen them once a door claims the
 * organise lane), and a born-decided decision is a TERMINAL move.
 */
describe("the own-organise class — D7 widenings", () => {
  const reversibleAuto = {
    governanceRuleVerdict: "auto" as const,
    governanceRuleIsOwnOrganise: false,
  };
  const destructiveFloor = {
    verdict: "propose",
    reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
    reasonCode: "DESTRUCTIVE_HARD_FLOOR",
  };

  it("Q2: its own blocked_by removal applies with the class row and the proof", () => {
    expect(
      decideAgentPolicy({
        ...split("link.delete"),
        ownWorkOrganise: true,
        ...classAuto,
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-own" });
  });

  it("Q2: without the proof, or without the row, a link delete stays the destructive floor", () => {
    // The class row alone (no proof) never reaches past 2.5.
    expect(
      decideAgentPolicy({ ...split("link.delete"), ...classAuto })
    ).toEqual(destructiveFloor);
    // The proof alone (class off) proposes with the SAME reason as before.
    expect(
      decideAgentPolicy({ ...split("link.delete"), ownWorkOrganise: true })
    ).toEqual(destructiveFloor);
    // Another auto row (`@reversible`, a glob) never widens it.
    expect(
      decideAgentPolicy({
        ...split("link.delete"),
        ownWorkOrganise: true,
        ...reversibleAuto,
      })
    ).toEqual(destructiveFloor);
    // The carve-out is the key, not the verb: any other delete with a proof.
    for (const key of ["entity.delete", "relation.delete", "document.delete"]) {
      expect(
        decideAgentPolicy({ ...split(key), ownWorkOrganise: true, ...classAuto })
      ).toMatchObject({ verdict: "propose" });
    }
  });

  it("own rename: a re-type of its own fresh record applies with the row; off ⇒ the scope/identity floor as before", () => {
    expect(
      decideAgentPolicy({
        ...split("entity.update"),
        ownWorkOrganise: true,
        ...classAuto,
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-own" });
    const before = decideAgentPolicy({
      ...split("entity.update"),
      forcePropose: true,
    });
    expect(before).toMatchObject({ reasonCode: "SCOPE_IDENTITY_CHANGE" });
    expect(
      decideAgentPolicy({ ...split("entity.update"), ownWorkOrganise: true })
    ).toEqual(before);
    // entity.update IS reversible: @reversible must not widen the claim.
    expect(
      decideAgentPolicy({
        ...split("entity.update"),
        ownWorkOrganise: true,
        ...reversibleAuto,
      })
    ).toEqual(before);
  });

  it("Q3: a relayed decision born decided applies with the row; off ⇒ the terminal floor as before", () => {
    expect(
      decideAgentPolicy({
        ...split("entity.create"),
        lifecycleMove: TERMINAL,
        ownWorkOrganise: true,
        ...classAuto,
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-own" });
    const before = decideAgentPolicy({
      ...split("entity.create"),
      lifecycleMove: TERMINAL,
      ...reversibleAuto,
    });
    expect(before).toMatchObject({ reasonCode: "LIFECYCLE_TERMINAL" });
    expect(
      decideAgentPolicy({
        ...split("entity.create"),
        lifecycleMove: TERMINAL,
        ownWorkOrganise: true,
        ...reversibleAuto,
      })
    ).toEqual(before);
    expect(
      decideAgentPolicy({
        ...split("entity.create"),
        lifecycleMove: TERMINAL,
        ownWorkOrganise: true,
      })
    ).toEqual(
      decideAgentPolicy({ ...split("entity.create"), lifecycleMove: TERMINAL })
    );
  });
});
