import { describe, it, expect } from "vitest";
import {
  canTransitionTrack,
  deriveTrackStages,
  partitionSessionsByTrack,
  readTrackStageHistory,
  trackStageTone,
  trackStatusMoves,
  trackUnitInput,
  trackPausedBy,
  TRACK_STATUS_TRANSITIONS,
  TRACK_STATUSES,
} from "./track.js";
import { resolveUnitState } from "./state.js";
import { ACTION_VERBS } from "../vocabulary/index.js";

const STAGES = [
  { key: "discover", name: "Discover", category: "planned" },
  { key: "build", name: "Build", category: "started" },
  { key: "ship", name: "Ship", category: "completed" },
];

describe("deriveTrackStages", () => {
  it("marks stages before the current one done, after it not started", () => {
    expect(deriveTrackStages(STAGES, "build").map((s) => s.position)).toEqual([
      "done",
      "active",
      "not_started",
    ]);
  });

  it("is re-enterable: moving BACK re-opens the later stages", () => {
    // Position is where the track stands NOW — not a visited history.
    expect(
      deriveTrackStages(STAGES, "discover").map((s) => s.position)
    ).toEqual(["active", "not_started", "not_started"]);
  });

  it("an unknown or absent current stage guesses nothing", () => {
    for (const current of [null, undefined, "nope"]) {
      expect(
        deriveTrackStages(STAGES, current).every(
          (s) => s.position === "not_started"
        )
      ).toBe(true);
    }
  });

  it("attaches per-stage session counts only when given, zero-filled", () => {
    const withCounts = deriveTrackStages(STAGES, "build", { build: 2 });
    expect(withCounts.map((s) => s.sessionCount)).toEqual([0, 2, 0]);
    expect("sessionCount" in deriveTrackStages(STAGES, "build")[0]!).toBe(
      false
    );
  });

  it("skips malformed jsonb entries and tolerates a non-array snapshot", () => {
    expect(deriveTrackStages({ stages: STAGES }, "build")).toEqual([]);
    const out = deriveTrackStages(
      [null, { name: "no key" }, STAGES[1]],
      "build"
    );
    expect(out).toEqual([
      { key: "build", name: "Build", category: "started", position: "active" },
    ]);
  });
});

describe("deriveTrackStages — what the pinned stage declares (0274)", () => {
  it("projects goal, description, tasks, outputs, criteria, gate and indefinite when declared", () => {
    const [stage] = deriveTrackStages(
      [
        {
          key: "audit",
          name: "Audit",
          goal: "Check it",
          description: "Last look",
          suggestedTasks: ["Read", 3, ""],
          expectedOutputs: [{ label: "Report" }, "junk"],
          criteria: [{ key: "ok", statement: "Fine" }, { statement: "no key" }],
          gate: { kind: "check" },
          indefinite: true,
        },
      ],
      "audit",
      { audit: 2 }
    );
    expect(stage).toEqual({
      key: "audit",
      name: "Audit",
      category: null,
      position: "active",
      sessionCount: 2,
      goal: "Check it",
      description: "Last look",
      suggestedTasks: ["Read"],
      expectedOutputs: [{ label: "Report" }],
      criteria: [{ key: "ok", statement: "Fine" }],
      gate: "check",
      indefinite: true,
    });
  });

  it("an unknown gate kind is not projected (never guessed)", () => {
    const [stage] = deriveTrackStages(
      [{ key: "a", gate: { kind: "robot" } }],
      "a"
    );
    expect("gate" in stage!).toBe(false);
  });
});

describe("readTrackStageHistory", () => {
  it("keeps well-formed entries in order, re-entries included, and skips junk", () => {
    expect(
      readTrackStageHistory([
        { stageKey: "a", fromStage: null, enteredAt: "t1", actor: "u" },
        { stageKey: "b", fromStage: "a", enteredAt: "t2", actor: "u" },
        { stageKey: "a", fromStage: "b", enteredAt: "t3" },
        { fromStage: "a", enteredAt: "t4" },
        "junk",
      ])
    ).toEqual([
      { stageKey: "a", fromStage: null, enteredAt: "t1", actor: "u" },
      { stageKey: "b", fromStage: "a", enteredAt: "t2", actor: "u" },
      { stageKey: "a", fromStage: "b", enteredAt: "t3", actor: "" },
    ]);
    expect(readTrackStageHistory({})).toEqual([]);
  });
});

describe("TRACK_STATUS_TRANSITIONS / trackStatusMoves", () => {
  it("covers every status, and archived is final", () => {
    expect(Object.keys(TRACK_STATUS_TRANSITIONS).sort()).toEqual(
      [...TRACK_STATUSES].sort()
    );
    expect(TRACK_STATUS_TRANSITIONS.archived).toEqual([]);
    expect(canTransitionTrack("archived", "active")).toBe(false);
    expect(canTransitionTrack("completed", "paused")).toBe(false);
    expect(canTransitionTrack("paused", "active")).toBe(true);
    expect(canTransitionTrack("nope", "active")).toBe(false);
  });

  it("names the move by where it comes FROM: resume a pause, reopen a completion", () => {
    expect(trackStatusMoves("paused")).toEqual([
      { to: "active", verb: "resume" },
      { to: "completed", verb: "complete" },
    ]);
    expect(trackStatusMoves("completed")).toEqual([
      { to: "active", verb: "reopen" },
    ]);
    expect(trackStatusMoves("active")).toEqual([
      { to: "paused", verb: "pause" },
      { to: "completed", verb: "complete" },
    ]);
  });

  it("offers archive only when asked, and nothing from archived/unknown", () => {
    expect(
      trackStatusMoves("active", { includeArchive: true }).map((m) => m.to)
    ).toEqual(["paused", "completed", "archived"]);
    expect(trackStatusMoves("completed", { includeArchive: true })).toEqual([
      { to: "active", verb: "reopen" },
      { to: "archived", verb: "archive" },
    ]);
    expect(trackStatusMoves("archived", { includeArchive: true })).toEqual([]);
    expect(trackStatusMoves("bogus")).toEqual([]);
  });

  it("every verb resolves through ACTION_VERBS (never the humanize fallback)", () => {
    for (const status of TRACK_STATUSES) {
      for (const move of trackStatusMoves(status, { includeArchive: true })) {
        expect(ACTION_VERBS[move.verb]).toBeDefined();
      }
    }
  });
});

describe("trackStageTone", () => {
  it("active = the one accent (never ai), done = success, upcoming = muted", () => {
    expect(trackStageTone("active")).toBe("primary");
    expect(trackStageTone("done")).toBe("success");
    expect(trackStageTone("not_started")).toBe("textMuted");
    for (const p of ["active", "done", "not_started"] as const) {
      expect(trackStageTone(p)).not.toBe("ai");
    }
  });
});

describe("trackUnitInput", () => {
  const needsYou = [{ status: "active", nextMoveActor: "user" as const }];
  it("a completed or archived track is done whatever its sessions say", () => {
    for (const status of ["completed", "archived"]) {
      expect(resolveUnitState(trackUnitInput({ status }, needsYou)).state).toBe(
        "done"
      );
    }
  });
  it("a paused track reads paused", () => {
    expect(
      resolveUnitState(trackUnitInput({ status: "paused" }, needsYou)).state
    ).toBe("paused");
  });
  it("an active track aggregates its sessions", () => {
    expect(
      resolveUnitState(trackUnitInput({ status: "active" }, needsYou)).state
    ).toBe("needs_you");
  });
});

describe("partitionSessionsByTrack", () => {
  const tracks = [
    { id: "t1", status: "active" },
    { id: "t2", status: "archived" },
    { id: "t3", status: "paused" },
    { id: "t1", status: "archived" }, // duplicate: first sighting wins
  ];
  const sessions = [
    { id: "a", trackId: "t1" },
    { id: "b", trackId: "t2" }, // archived → remainder
    { id: "c", trackId: null }, // trackless → remainder
    { id: "d", trackId: "ghost" }, // unlisted → remainder
    { id: "e", trackId: "t1" },
  ];

  it("every session lands in exactly one place; unknown/archived fall back", () => {
    const out = partitionSessionsByTrack(sessions, tracks);
    expect(out.groups.map((g) => g.track.id)).toEqual(["t1", "t3"]);
    expect(out.groups[0]!.sessions.map((s) => s.id)).toEqual(["a", "e"]);
    expect(out.groups[1]!.sessions).toEqual([]); // empty live track KEPT
    expect(out.remainder.map((s) => s.id)).toEqual(["b", "c", "d"]);
    const placed =
      out.remainder.length +
      out.groups.reduce((n, g) => n + g.sessions.length, 0);
    expect(placed).toBe(sessions.length);
  });

  it("reads the track id through `trackIdOf` when given", () => {
    const index = new Map([["x", "t3"]]);
    const out = partitionSessionsByTrack([{ id: "x" }], tracks, (s) =>
      index.get(s.id)
    );
    expect(out.groups[1]!.sessions.map((s) => s.id)).toEqual(["x"]);
    expect(out.remainder).toEqual([]);
  });
});

describe("trackPausedBy", () => {
  it("check when the gate marker is set, human otherwise, null unless paused", () => {
    expect(
      trackPausedBy({
        status: "paused",
        metadata: { checkGate: { stageKey: "x" } },
      })
    ).toBe("check");
    expect(trackPausedBy({ status: "paused", metadata: {} })).toBe("human");
    expect(trackPausedBy({ status: "paused", metadata: null })).toBe("human");
    // A stale marker never leaks onto a track that is not paused.
    expect(
      trackPausedBy({
        status: "active",
        metadata: { checkGate: { stageKey: "x" } },
      })
    ).toBeNull();
  });
});
