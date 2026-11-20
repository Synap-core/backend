/**
 * The runs digest projection (`projectRunsDigest`), on fixtures. Each run
 * rules a wrong rule out:
 *  - R4 vs R5: the stall threshold (8 days stalled, 6 days not);
 *  - R3: a stage entered twice is ONE reach and its stays are summed;
 *  - R2: a stage passed over is skipped; R6 (attached at c) skipped nothing;
 *  - R6: an attached run's first stay has no start: reached, never timed;
 *  - R7: a stage moved with no ledger entry is `unrecorded`, not a reach of
 *    its current stage and not two skips;
 *  - R4/R5: an open stay is never timed (a lower bound is not a duration);
 *  - R8: a stage the playbook does not declare is listed apart;
 *  - b and c: the median of an even count is the mean of the middle two.
 */
import { describe, expect, it } from "vitest";
import {
  projectRunsDigest,
  playbookStageKeys,
  type RunsDigestRun,
} from "./runs-digest.js";

const NOW = new Date("2026-11-20T00:00:00.000Z");
const T0 = new Date("2026-11-01T00:00:00.000Z").getTime();
const H = 60 * 60 * 1000;
const D = 24 * H;
const at = (t: number) => new Date(t).toISOString();
const move = (fromStage: string | null, stageKey: string, t: number) => ({
  stageKey,
  fromStage,
  enteredAt: at(t),
  actor: "u",
  userId: "u",
  via: "advance",
});
const run = (o: Partial<RunsDigestRun> & { id: string }): RunsDigestRun => ({
  status: "closed",
  currentStage: null,
  stageHistory: [],
  startedAt: at(T0),
  closedAt: null,
  updatedAt: at(T0),
  attached: false,
  ...o,
});

const RUNS: RunsDigestRun[] = [
  run({
    id: "R1",
    currentStage: "d",
    stageHistory: [
      move("a", "b", T0 + 2 * H),
      move("b", "c", T0 + 6 * H),
      move("c", "d", T0 + 7 * H),
    ],
    closedAt: at(T0 + 8 * H),
    verdict: "passing",
  }),
  run({
    id: "R2",
    currentStage: "c",
    stageHistory: [move("a", "c", T0 + 4 * H)],
    closedAt: at(T0 + 10 * H),
  }),
  run({
    id: "R3",
    status: "cancelled",
    currentStage: "b",
    stageHistory: [
      move("a", "b", T0 + 1 * H),
      move("b", "a", T0 + 2 * H),
      move("a", "b", T0 + 3 * H),
    ],
    closedAt: at(T0 + 5 * H),
    verdict: "failing",
  }),
  run({
    id: "R4",
    status: "active",
    currentStage: "b",
    startedAt: at(NOW.getTime() - 10 * D),
    stageHistory: [move("a", "b", NOW.getTime() - 8 * D)],
    updatedAt: at(NOW.getTime() - 1 * D),
  }),
  run({
    id: "R5",
    status: "active",
    currentStage: "a",
    startedAt: at(NOW.getTime() - 6 * D),
    updatedAt: at(NOW.getTime() - 2 * H),
  }),
  run({
    id: "R6",
    status: "paused",
    currentStage: "c",
    attached: true,
    startedAt: at(NOW.getTime() - 30 * D),
  }),
  run({
    id: "R7",
    currentStage: "c",
    closedAt: at(T0 + 9 * H),
    verdict: "incomplete",
  }),
  run({
    id: "R8",
    currentStage: "deploy_approved",
    stageHistory: [move("a", "deploy_approved", T0 + 1 * H)],
    closedAt: at(T0 + 3 * H),
  }),
  run({ id: "R9", status: "active" }),
];

const digest = () =>
  projectRunsDigest({
    playbookId: "P",
    name: "Ship",
    stageKeys: ["a", "b", "c", "d"],
    runs: RUNS,
    total: RUNS.length,
    now: NOW,
  });
const stage = (key: string) => digest().stages.find((s) => s.key === key)!;

describe("projectRunsDigest", () => {
  it("counts runs by status and the verdict of the ended ones", () => {
    const d = digest();
    expect(d.runs).toEqual({
      total: 9,
      scanned: 9,
      byStatus: { closed: 4, cancelled: 1, active: 3, paused: 1 },
      attached: 1,
    });
    expect(d.endings).toEqual({
      passing: 1,
      none: 2,
      failing: 1,
      incomplete: 1,
    });
    expect(d.unrecorded).toBe(1);
    expect(d.noStage).toBe(1);
    expect(d.otherStages).toEqual({ deploy_approved: 1 });
  });

  it("per stage: reached, median of finished stays, now, stalled, skipped, ended here", () => {
    expect(stage("a")).toEqual({
      key: "a",
      reached: 6, // R1 R2 R3 R4 R5 R8
      medianHours: 2, // [1, 2, 2, 4, 48]; R5's open stay untimed
      timed: 5,
      now: 1, // R5
      stalled: 0, // R5 is 6 days in: under the threshold
      skipped: 0,
      endedHere: 0,
    });
    expect(stage("b")).toEqual({
      key: "b",
      reached: 3, // R1 R3 R4
      medianHours: 3.5, // R1 4h, R3 1h + 2h
      timed: 2,
      now: 1, // R4
      stalled: 1, // R4 entered b 8 days ago
      skipped: 1, // R2 went a → c
      endedHere: 1, // R3
    });
    expect(stage("c")).toEqual({
      key: "c",
      reached: 3, // R1 R2 R6 (R7 is unrecorded)
      medianHours: 3.5, // R1 1h, R2 6h; R6 attached: no start
      timed: 2,
      now: 1, // R6
      stalled: 0, // R6's stay has no known start
      skipped: 0,
      endedHere: 1, // R2
    });
    expect(stage("d")).toEqual({
      key: "d",
      reached: 1,
      medianHours: 1,
      timed: 1,
      now: 0,
      stalled: 0,
      skipped: 0,
      endedHere: 1,
    });
  });

  it("names the newest runs to drill into, and states its rules", () => {
    const d = digest();
    expect(d.recent.map((r) => r.id)).toEqual(["R5", "R4", "R1", "R2", "R3"]);
    expect(d.recent[0]).toEqual({ id: "R5", status: "active", stage: "a" });
    expect(d.rules).toContain("7+ days");
  });

  it("a playbook with no runs reads zero runs, every stage unmeasured", () => {
    const d = projectRunsDigest({
      playbookId: "P",
      name: null,
      stageKeys: ["a"],
      runs: [],
      total: 0,
      now: NOW,
    });
    expect(d.runs.total).toBe(0);
    expect(d.stages[0]).toMatchObject({
      reached: 0,
      medianHours: null,
      timed: 0,
    });
  });
});

describe("playbookStageKeys", () => {
  it("reads the declared keys in order, skipping malformed entries", () => {
    expect(
      playbookStageKeys([{ key: "a" }, null, { label: "x" }, { key: "b" }])
    ).toEqual(["a", "b"]);
    expect(playbookStageKeys(undefined)).toEqual([]);
  });
});
