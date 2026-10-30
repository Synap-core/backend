import { describe, expect, it } from "vitest";
import {
  defaultGoalProjectId,
  emptyNewGoal,
  NEW_GOAL_REFUSAL,
  newGoalRefusal,
  newGoalStartInput,
  projectMayHoldGoal,
  type NewGoalDraft,
} from "./new-goal.js";

const draft = (over: Partial<NewGoalDraft> = {}): NewGoalDraft => ({
  ...emptyNewGoal({ name: "Ship the beta", projectId: "p1" }),
  ...over,
});

describe("New goal draft — one for desk and phone", () => {
  it("refuses in one set of words: name first, then the project", () => {
    expect(newGoalRefusal(draft({ name: "  " }))).toBe(NEW_GOAL_REFUSAL.name);
    expect(newGoalRefusal(draft({ projectId: null }))).toBe(
      NEW_GOAL_REFUSAL.project
    );
    expect(newGoalRefusal(draft())).toBeNull();
  });

  it("a lasting goal (no criteria) starts; one criterion is refused by the pod’s own count", () => {
    expect(newGoalRefusal(draft({ criteria: [] }))).toBeNull();
    expect(
      newGoalRefusal(
        draft({ criteria: [{ statement: "One", meaning: "judged" }] })
      )
    ).not.toBeNull();
  });

  it("blank criterion rows are not criteria", () => {
    const d = draft({
      criteria: [
        { statement: "A", meaning: "judged" },
        { statement: "  ", meaning: "judged" },
        { statement: "B", meaning: "measured" },
      ],
    });
    expect(newGoalRefusal(d)).toBeNull();
    expect(newGoalStartInput(d).criteria?.map((c) => c.key)).toEqual([
      "a",
      "b",
    ]);
  });

  it("sends the project, leaves unsaid fields out, and confirms a kind a person picked", () => {
    expect(newGoalStartInput(draft())).toEqual({
      projectId: "p1",
      name: "Ship the beta",
    });
    const input = newGoalStartInput(
      draft({
        endState: " Beta in 20 hands ",
        workKind: "project",
        dropConditions: [" ", "Funding stops"],
      })
    );
    expect(input).toEqual({
      projectId: "p1",
      name: "Ship the beta",
      endState: "Beta in 20 hands",
      dropConditions: ["Funding stops"],
      workKind: "project",
      confirmKind: true,
    });
  });
});

describe("which projects may hold a goal", () => {
  it("any project that has not ended — a missing status reads as active", () => {
    expect(projectMayHoldGoal({ status: "active" })).toBe(true);
    expect(projectMayHoldGoal({})).toBe(true);
    expect(projectMayHoldGoal({ status: "completed" })).toBe(false);
    expect(projectMayHoldGoal({ status: "archived" })).toBe(false);
  });

  it("opens on the current project, else the most recently active open one", () => {
    const projects = [
      { id: "old", status: "active", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "new", status: "active", updatedAt: "2026-10-20T00:00:00Z" },
      { id: "done", status: "completed", updatedAt: "2026-10-23T00:00:00Z" },
    ];
    expect(defaultGoalProjectId(projects, "old")).toBe("old");
    expect(defaultGoalProjectId(projects, "done")).toBe("new");
    expect(defaultGoalProjectId(projects)).toBe("new");
    expect(defaultGoalProjectId([{ id: "x", status: "archived" }])).toBeNull();
  });
});
