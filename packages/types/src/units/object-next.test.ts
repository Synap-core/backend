import { describe, expect, it } from "vitest";
import { deriveProcessHealth } from "../processes/health.js";
import { ACTION_VERBS } from "../vocabulary/index.js";
import { OBJECT_NEXT_ACTIONS, objectNextOf } from "./object-next.js";

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
  it("a draft automation's next step is the person's Turn on", () => {
    expect(objectNextOf("automation", { health: health("draft") })).toEqual({
      action: "turn_on",
      reason: "draft",
      personOnly: true,
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
    ).toMatchObject({ action: "see_failure", personOnly: true });
  });

  it("a live playbook with skills off needs them enabled; a draft is turned on first", () => {
    expect(
      objectNextOf("playbook", { health: health("active"), skillsOff: 2 })
    ).toEqual({ action: "enable", reason: "skills_off", personOnly: true });
    expect(
      objectNextOf("playbook", { health: health("draft"), skillsOff: 2 })
    ).toMatchObject({ action: "turn_on" });
  });

  it("no health read: no next step", () => {
    expect(objectNextOf("automation", {})).toBeNull();
  });
});

describe("objectNextOf — a thing or a session reads its next move", () => {
  it("an owed slot is the person's to answer, in its session", () => {
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
      personOnly: true,
      label: "Answer: which account?",
      sessionId: "s1",
    });
  });

  it("a step the person may take is not theirs alone", () => {
    expect(
      objectNextOf("entity", {
        nextMove: { kind: "step", actor: "user", label: "Next: Qualified", reason: "r" },
      })
    ).toMatchObject({ action: "open", personOnly: false });
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
