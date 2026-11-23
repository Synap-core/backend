import { describe, expect, it } from "vitest";
import { deriveProcessHealth } from "@synap-core/types/processes";
import { objectNextOf } from "@synap-core/types/units";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { nextStepOf } from "./next-step-model";

const ID = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

function healthOf(status: string) {
  return deriveProcessHealth({
    definitionStatus: status,
    runGroup: null,
    recentRuns: [],
    exactRunCount: 0,
  });
}

describe("nextStepOf — the one act an object's next step offers", () => {
  it("a draft automation or playbook is turned on in place", () => {
    for (const kind of ["automation", "playbook"] as const) {
      const next = objectNextOf(kind, { health: healthOf("draft") });
      expect(nextStepOf({ kind, id: ID }, next, "itsPage")?.act).toEqual({
        kind: "turn_on",
        objectKind: kind,
        id: ID,
      });
    }
  });

  it("an object that needs nothing, or whose next step was not read, offers nothing", () => {
    const active = objectNextOf("automation", { health: healthOf("active") });
    expect(nextStepOf({ kind: "automation", id: ID }, active, "itsPage")).toBe(
      null
    );
    expect(
      nextStepOf({ kind: "automation", id: ID }, undefined, "elsewhere")
    ).toBeNull();
  });

  it("a step owed in a session opens that session, wherever it is drawn", () => {
    const next = {
      action: "answer" as const,
      reason: "owed_slot",
      sessionId: SESSION,
      label: "Answer: which plan?",
    };
    for (const where of ["itsPage", "elsewhere"] as const) {
      expect(nextStepOf({ kind: "entity", id: ID }, next, where)?.act).toEqual(
        {
          kind: "door",
          exit: { kind: "object", objectKind: "session", id: SESSION },
        }
      );
    }
    expect(
      nextStepOf({ kind: "entity", id: ID }, next, "elsewhere")?.pill.label
    ).toBe(resolveStatusLabel("needs_you"));
  });

  it("any other step opens the object, or on its own page the app where it is worked", () => {
    const next = { action: "see_failure" as const, reason: "latest_failed" };
    const object = { kind: "playbook", id: ID };
    expect(nextStepOf(object, next, "elsewhere")?.act).toEqual({
      kind: "door",
      exit: { kind: "object", objectKind: "playbook", id: ID },
    });
    expect(nextStepOf(object, next, "itsPage")?.act).toEqual({
      kind: "door",
      exit: { kind: "objectInApp", objectKind: "playbook", id: ID },
    });
    expect(nextStepOf(object, next, "itsPage")?.pill.kind).toBe("down");
  });

  it("a broken definition is marked as failed, not as your turn", () => {
    const next = objectNextOf("automation", { health: healthOf("error") });
    expect(next?.action).toBe("open");
    expect(
      nextStepOf({ kind: "automation", id: ID }, next, "itsPage")?.pill.kind
    ).toBe("down");
  });
});
