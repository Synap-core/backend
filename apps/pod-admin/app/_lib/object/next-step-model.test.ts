import { describe, expect, it } from "vitest";
import { objectNextOf } from "@synap-core/types/units";
import {
  resolveProcessHealthLabel,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { nextStepOf } from "./next-step-model";

const ID = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const rule = { kind: "automation", id: ID };
const thing = { kind: "entity", id: ID };

describe("nextStepOf — the mark and the one act pod admin offers", () => {
  it("nothing next draws nothing; not read draws an unmeasured mark, no act", () => {
    expect(nextStepOf(rule, null, "row")).toBeNull();
    const unread = nextStepOf(rule, undefined, "row");
    expect(unread).toMatchObject({ measured: false, act: null, line: null });
    expect(unread?.pill.label).toBe(resolveStatusLabel("unmeasured"));
  });

  it("a move the status read could not make is unmeasured, never your turn", () => {
    const unknown = objectNextOf("entity", {
      nextMove: {
        kind: "unknown",
        actor: "none",
        label: "Next move unknown",
        reason: "r",
      },
    });
    const step = nextStepOf(thing, unknown, "itsPage");
    expect(step).toMatchObject({ measured: false, act: null });
    expect(step?.pill.label).not.toBe(resolveStatusLabel("needs_you"));
  });

  it("a draft is turned on in a row; on its own page the header holds Turn on", () => {
    const next = { action: "turn_on" as const, reason: "draft" };
    expect(nextStepOf(rule, next, "row")?.act).toEqual({
      kind: "turn_on",
      objectKind: "automation",
      id: ID,
    });
    expect(nextStepOf(rule, next, "row")?.pill.label).toBe(
      resolveProcessHealthLabel({ reason: "draft" })
    );
    expect(nextStepOf(rule, next, "itsPage")?.act).toBeNull();
  });

  it("a request to decide opens its review", () => {
    const next = {
      action: "review" as const,
      reason: "pending_proposal",
      proposalId: PROPOSAL,
    };
    expect(nextStepOf(thing, next, "itsPage")?.act).toEqual({
      kind: "review",
      proposalId: PROPOSAL,
    });
  });

  it("work owed in a session is one door to that session in the app", () => {
    const next = {
      action: "answer" as const,
      reason: "owed_slot",
      sessionId: SESSION,
      label: "Answer: which plan?",
    };
    for (const where of ["row", "itsPage"] as const) {
      expect(nextStepOf(thing, next, where)?.act).toEqual({
        kind: "in_app",
        objectKind: "session",
        id: SESSION,
      });
    }
    expect(nextStepOf(thing, next, "row")).toMatchObject({
      line: "Answer: which plan?",
      measured: true,
    });
  });

  it("any other step opens the object in the app, except on its page (the header does)", () => {
    const next = { action: "see_failure" as const, reason: "latest_failed" };
    expect(nextStepOf(rule, next, "row")?.act).toEqual({
      kind: "in_app",
      objectKind: "automation",
      id: ID,
    });
    expect(nextStepOf(rule, next, "itsPage")?.act).toBeNull();
    expect(nextStepOf(rule, next, "row")?.pill.kind).toBe("down");
  });
});
