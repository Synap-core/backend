import { describe, expect, it } from "vitest";
import { deriveProcessHealth } from "../processes/health.js";
import { ACTION_VERBS } from "../vocabulary/index.js";
import {
  OBJECT_NEXT_ACTIONS,
  objectNextMark,
  objectNextOf,
} from "./object-next.js";

const health = (definitionStatus: string, latestStatus?: string) =>
  deriveProcessHealth({
    definitionStatus,
    runGroup: latestStatus
      ? {
          runCount: 1,
          latestRunId: "r1",
          latestStatus,
          latestStartedAt: "2026-11-20T10:00:00.000Z",
          hasRunning: false,
        }
      : null,
    recentRuns: [],
    exactRunCount: latestStatus ? 1 : 0,
  });

describe("objectNextOf — a process reads its health", () => {
  it("a draft automation's next step is Turn on", () => {
    expect(objectNextOf("automation", { health: health("draft") })).toEqual({
      action: "turn_on",
      reason: "draft",
    });
  });

  it("a live process that ran fine needs nothing", () => {
    expect(
      objectNextOf("automation", { health: health("active", "completed") })
    ).toBeNull();
    expect(objectNextOf("playbook", { health: health("active") })).toBeNull();
  });

  it("a failed run asks the person to see what failed", () => {
    expect(
      objectNextOf("automation", { health: health("active", "failed") })
    ).toMatchObject({ action: "see_failure" });
  });

  it("a live playbook with skills off needs them enabled; a draft is turned on first", () => {
    expect(
      objectNextOf("playbook", { health: health("active"), skillsOff: 2 })
    ).toEqual({ action: "enable", reason: "skills_off" });
    expect(
      objectNextOf("playbook", { health: health("draft"), skillsOff: 2 })
    ).toMatchObject({ action: "turn_on" });
  });

  it("no health read: no next step", () => {
    expect(objectNextOf("automation", {})).toBeNull();
  });
});

describe("objectNextOf — a thing or a session reads its next move", () => {
  it("an owed slot is answered in its session", () => {
    expect(
      objectNextOf("session", {
        nextMove: {
          kind: "owed_slot",
          actor: "user",
          label: "Answer: which account?",
          reason: "r",
          sessionId: "s1",
        },
      })
    ).toEqual({
      action: "answer",
      reason: "owed_slot",
      label: "Answer: which account?",
      sessionId: "s1",
    });
  });

  it("a step the person may take opens the object, in its own words", () => {
    expect(
      objectNextOf("entity", {
        nextMove: {
          kind: "step",
          actor: "user",
          label: "Next: Qualified",
          reason: "r",
        },
      })
    ).toMatchObject({ action: "open", label: "Next: Qualified" });
  });

  it("the AI's or nobody's move needs nothing from the person", () => {
    expect(
      objectNextOf("session", {
        nextMove: { kind: "agent_slot", actor: "ai", label: "l", reason: "r" },
      })
    ).toBeNull();
    expect(
      objectNextOf("entity", {
        nextMove: { kind: "none", actor: "none", label: "l", reason: "r" },
      })
    ).toBeNull();
  });
});

describe("every next-step action is a vocabulary verb", () => {
  it("is declared in the vocabulary's verb table", () => {
    for (const action of OBJECT_NEXT_ACTIONS) {
      expect(Object.hasOwn(ACTION_VERBS, action), action).toBe(true);
    }
  });
});

describe("objectNextOf — a request waiting on the person carries its id", () => {
  it("a pending proposal is reviewed where it waits", () => {
    expect(
      objectNextOf("entity", {
        nextMove: {
          kind: "pending_proposal",
          actor: "user",
          label: "Review: rename",
          reason: "r",
          proposalId: "p1",
        },
      })
    ).toMatchObject({ action: "review", proposalId: "p1" });
  });
});

describe("objectNextMark — the step's mark, as tokens", () => {
  it("nothing next has no mark; not read and unknown are unmeasured, never your turn", () => {
    expect(objectNextMark(null)).toBeNull();
    expect(objectNextMark(undefined)?.state).toBe("unmeasured");
    const unknown = objectNextOf("entity", {
      nextMove: {
        kind: "unknown",
        actor: "none",
        label: "Next move unknown",
        reason: "r",
      },
    });
    expect(unknown?.action).toBe("open");
    expect(objectNextMark(unknown)?.state).toBe("unmeasured");
  });

  it("a draft is not started and named by its health; a broken one failed", () => {
    const draft = objectNextOf("automation", { health: health("draft") });
    expect(objectNextMark(draft)).toMatchObject({
      state: "not_started",
      healthReason: "draft",
    });
    const broken = objectNextOf("automation", { health: health("error") });
    expect(objectNextMark(broken)?.state).toBe("failed");
  });

  it("an answer owed is your turn, a request to decide needs review", () => {
    expect(
      objectNextMark({ action: "answer", reason: "owed_slot" })
    ).toMatchObject({ state: "needs_you" });
    expect(
      objectNextMark({ action: "review", reason: "pending_proposal" })?.state
    ).toBe("needs_review");
    expect(
      objectNextMark({ action: "answer", reason: "owed_slot" })?.healthReason
    ).toBeUndefined();
  });
});
