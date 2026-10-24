import { describe, it, expect } from "vitest";
import {
  HELD_DRAFT_EVENT_KEYS,
  PROPOSE_REASON,
  decideAgentPolicy,
  isHeldDraftWrite,
} from "./index.js";

/**
 * FB1020 B6 — an agent's direct playbook run "waits as a draft for you to
 * accept" (founder). The run door holds it on the person's draft session;
 * their accept starts it. Live (dogfood e3c39721 §5), the gate PROPOSED the
 * run first under default rules, so the draft was unreachable for an agent.
 *
 * The engine half pinned here:
 *  - `playbook.run` held as a draft: the plain default (rung 9) yields →
 *    execute (the door then holds it); not held → propose, as before;
 *  - the yield is a closed list: the flag on any other key changes nothing;
 *  - every floor and rule ABOVE the default still proposes with its reason
 *    (rules out "a held draft skips governance").
 */
const RUN = { subjectType: "playbook", action: "run" } as const;

describe("held draft — the default ask yields to the person's accept", () => {
  it("an agent's run held as a draft executes into the hold; not held, it proposes", () => {
    expect(decideAgentPolicy({ ...RUN, heldAsDraft: true })).toEqual({
      verdict: "execute",
    });
    expect(decideAgentPolicy({ ...RUN })).toEqual({ verdict: "propose" });
  });

  it("the list is closed: the flag on another write changes nothing", () => {
    expect(HELD_DRAFT_EVENT_KEYS).toEqual(["playbook.run"]);
    expect(isHeldDraftWrite("playbook.update")).toBe(false);
    for (const write of [
      { subjectType: "playbook", action: "update" },
      { subjectType: "project", action: "create" },
    ]) {
      expect(decideAgentPolicy({ ...write, heldAsDraft: true })).toEqual(
        decideAgentPolicy(write)
      );
    }
  });

  it("every floor and rule above the default still proposes a held run", () => {
    const cases = [
      [{ writesRequireProposal: true }, "WRITES_REQUIRE_PROPOSAL"],
      [{ governanceRuleVerdict: "propose" as const }, "GOVERNANCE_RULE"],
      [{ originTrust: "untrusted" as const }, "UNTRUSTED_ORIGIN"],
      [{ ceilingVerdict: "propose" as const }, "DAILY_WRITE_CEILING"],
      [{ forcePropose: true }, undefined],
    ] as const;
    for (const [extra, code] of cases) {
      const decided = decideAgentPolicy({
        ...RUN,
        ...extra,
        heldAsDraft: true,
      });
      expect(decided.verdict, JSON.stringify(extra)).toBe("propose");
      if (code) {
        expect(
          decided.verdict === "propose" ? decided.reasonCode : undefined
        ).toBe(code);
        expect(PROPOSE_REASON).toHaveProperty(code);
      }
    }
  });
});
