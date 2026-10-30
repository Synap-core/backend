import { describe, expect, it } from "vitest";
import type { NeedsYouConvertibleGoals } from "../needs-you/index.js";
import {
  MAKE_THEM_GOALS_COPY,
  defaultBatchProjectId,
  makeThemGoalsPreselection,
  makeThemGoalsRows,
  makeThemGoalsSummary,
  makeThemGoalsTargets,
  runMakeThemGoals,
  type ConvertOne,
} from "./make-them-goals.js";

const card: NeedsYouConvertibleGoals = {
  entities: [
    {
      entityId: "e1",
      title: "Run a marathon",
      kind: "goal",
      spaceName: "Life OS",
      projectIds: ["health"],
    },
    {
      entityId: "e2",
      title: "  ",
      kind: "objective",
      spaceName: "Enterprise OS",
      projectIds: [],
    },
    // Filed only in an ended project: it has no project of its own.
    {
      entityId: "e3",
      title: "Ship v2",
      kind: "okr",
      spaceName: null,
      projectIds: ["old"],
    },
  ],
  truncated: false,
};
const projects = [
  { id: "health", status: "active", updatedAt: "2026-10-01" },
  { id: "old", status: "completed", updatedAt: "2026-10-20" },
  { id: "work", status: "active", updatedAt: "2026-10-25" },
];

describe("Make them goals — the review rows (D-3)", () => {
  it("one row per entity, in the pod order, named; a blank title is its kind", () => {
    const rows = makeThemGoalsRows(card);
    expect(rows.map((r) => [r.entityId, r.title, r.kindLabel])).toEqual([
      ["e1", "Run a marathon", "Goal"],
      ["e2", "Objective", "Objective"],
      ["e3", "Ship v2", "OKR"],
    ]);
    expect(makeThemGoalsRows(null)).toEqual([]);
  });

  it("every row is chosen when the review opens", () => {
    expect([...makeThemGoalsPreselection(makeThemGoalsRows(card))]).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
  });
});

describe("Make them goals — the project, asked once for the batch", () => {
  const rows = makeThemGoalsRows(card);

  it("a row goes to its own project that may hold a goal, the rest to the batch's", () => {
    const t = makeThemGoalsTargets({
      rows,
      chosen: new Set(["e1", "e2", "e3"]),
      projects,
      batchProjectId: "work",
    });
    expect(t.refusal).toBeNull();
    expect(t.asksProject).toBe(true);
    expect(t.items).toEqual([
      { entityId: "e1", projectId: "health" },
      { entityId: "e2", projectId: "work" },
      // Its own project ended: the batch's, as the single convert's picker would offer.
      { entityId: "e3", projectId: "work" },
    ]);
  });

  it("the batch opens on the single convert default (most recently active open project)", () => {
    expect(defaultBatchProjectId(projects)).toBe("work");
  });

  it("asks no project when every chosen row has its own", () => {
    const t = makeThemGoalsTargets({
      rows,
      chosen: new Set(["e1"]),
      projects,
      batchProjectId: null,
    });
    expect(t).toEqual({
      items: [{ entityId: "e1", projectId: "health" }],
      asksProject: false,
      refusal: null,
    });
  });

  it("refuses in words: nothing chosen, or no project for the ones in none", () => {
    expect(
      makeThemGoalsTargets({
        rows,
        chosen: new Set(),
        projects,
        batchProjectId: "work",
      }).refusal
    ).toBe(MAKE_THEM_GOALS_COPY.nothingChosen);
    const t = makeThemGoalsTargets({
      rows,
      chosen: new Set(["e2"]),
      projects,
      batchProjectId: null,
    });
    expect(t.refusal).toBe(MAKE_THEM_GOALS_COPY.noProject);
    expect(t.items).toEqual([]);
  });
});

describe("Make them goals — the batch run", () => {
  const items = [
    { entityId: "e1", projectId: "health" },
    { entityId: "e2", projectId: "work" },
    { entityId: "e3", projectId: "work" },
    { entityId: "e4", projectId: "work" },
  ];

  it("converts each row through the door, in order, one at a time; a failure fails that row only", async () => {
    const calls: string[] = [];
    let inFlight = 0;
    const convert: ConvertOne = async (entityId, projectId) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      calls.push(`${entityId}@${projectId}`);
      await Promise.resolve();
      inFlight -= 1;
      if (entityId === "e2")
        throw new Error("CONFLICT: a live goal already holds this name");
      if (entityId === "e3")
        return { outcome: "proposed", proposalId: "p3", goalId: null };
      if (entityId === "e4") return { outcome: "failed" };
      return { outcome: "updated", proposalId: null, goalId: "g1" };
    };
    const results = await runMakeThemGoals(items, convert);
    expect(calls).toEqual(["e1@health", "e2@work", "e3@work", "e4@work"]);
    expect(results).toEqual([
      { entityId: "e1", outcome: "made", goalId: "g1" },
      { entityId: "e2", outcome: "failed" },
      { entityId: "e3", outcome: "proposed", proposalId: "p3" },
      { entityId: "e4", outcome: "failed" },
    ]);
  });

  it("a partial failure is never said as done: the made, the failed and the held are each named", () => {
    const s = makeThemGoalsSummary([
      { entityId: "e1", outcome: "made", goalId: "g1" },
      { entityId: "e2", outcome: "failed" },
      { entityId: "e3", outcome: "proposed", proposalId: "p3" },
    ]);
    expect(s).toEqual({
      title: "Made 1 goal. 1 couldn't be made",
      detail: "1 is waiting for review.",
      tone: "warning",
      failed: ["e2"],
    });
  });

  it("all made is a success; all failed is an error; all held says so", () => {
    expect(
      makeThemGoalsSummary([
        { entityId: "a", outcome: "made", goalId: null },
        { entityId: "b", outcome: "made", goalId: null },
      ])
    ).toMatchObject({
      title: "Made 2 goals",
      detail: null,
      tone: "success",
      failed: [],
    });
    expect(
      makeThemGoalsSummary([{ entityId: "a", outcome: "failed" }])
    ).toMatchObject({
      title: "1 couldn't be made",
      tone: "error",
      failed: ["a"],
    });
    expect(
      makeThemGoalsSummary([
        { entityId: "a", outcome: "proposed", proposalId: null },
        { entityId: "b", outcome: "proposed", proposalId: null },
      ])
    ).toMatchObject({
      title: "2 are waiting for review",
      detail: null,
      tone: "success",
    });
  });
});
