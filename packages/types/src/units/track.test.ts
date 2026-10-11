import { describe, it, expect } from "vitest";
import {
  canTransitionTrack,
  CLOSED_TRACK_STATUSES,
  deriveTrackStages,
  filedStageKey,
  isTrackClosed,
  NOT_FILED_AT_A_STAGE,
  partitionSessionsByTrack,
  readTrackStage,
  readTrackStageHistory,
  trackStageTone,
  trackStatusMoves,
  trackUnitInput,
  trackPausedBy,
  TRACK_STAGE_POSITIONS,
  TRACK_STATUS_TRANSITIONS,
  TRACK_STATUSES,
  trackStagePath,
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

  it("projects the stage's domain (a workspace template slug), trimmed; blank is not declared (W2a)", () => {
    const [a, b, c] = deriveTrackStages(
      [
        { key: "a", domain: " crm " },
        { key: "b", domain: "   " },
        { key: "c", domain: 42 },
      ],
      "a"
    );
    expect(a!.domain).toBe("crm");
    expect("domain" in b!).toBe(false);
    expect("domain" in c!).toBe(false);
    expect(readTrackStage([{ key: "x", domain: "finance" }], "x")?.domain).toBe(
      "finance"
    );
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

describe("filedStageKey — THE stage-placement rule", () => {
  const stages = [{ key: "draft" }, { key: "review" }];
  it("a stamp naming a pinned stage places it there", () => {
    expect(filedStageKey("review", stages)).toBe("review");
  });
  it("no stamp is NOT FILED — never the track's current stage as a stand-in", () => {
    // Rules out the Stages/Zoom stand-in, which drew an unstamped session in
    // the current column while the track pages listed it apart.
    expect(filedStageKey(null, stages)).toBeNull();
    expect(filedStageKey(undefined, stages)).toBeNull();
    expect(filedStageKey("", stages)).toBeNull();
  });
  it("a stamp naming no pinned stage is not filed either, never dropped", () => {
    expect(filedStageKey("gone", stages)).toBeNull();
  });
  it("the group's heading uses the user word for a stage", () => {
    expect(NOT_FILED_AT_A_STAGE).toBe("Not filed at a step");
  });
});

describe("TRACK_STAGE_POSITIONS", () => {
  it("is every position deriveTrackStages can emit, in path order", () => {
    expect([...TRACK_STAGE_POSITIONS]).toEqual([
      "done",
      "active",
      "not_started",
    ]);
    const emitted = new Set(
      deriveTrackStages(STAGES, "build").map((s) => s.position)
    );
    expect([...emitted].sort()).toEqual([...TRACK_STAGE_POSITIONS].sort());
  });
});

describe("isTrackClosed", () => {
  it("completed and archived are closed; active and paused are open", () => {
    // Rule ruled out: `isTrackRetired` (archived only) — a COMPLETED track
    // still offered stage starts on the phone.
    expect(isTrackClosed({ status: "completed" })).toBe(true);
    expect(isTrackClosed({ status: "archived" })).toBe(true);
    // Rule ruled out: "not active" — a paused track resumes where it stands.
    expect(isTrackClosed({ status: "paused" })).toBe(false);
    expect(isTrackClosed({ status: "active" })).toBe(false);
  });

  it("reads CLOSED_TRACK_STATUSES — every status is closed iff it is listed", () => {
    for (const status of TRACK_STATUSES) {
      expect(isTrackClosed({ status })).toBe(
        (CLOSED_TRACK_STATUSES as readonly string[]).includes(status)
      );
    }
  });
});

describe("trackStagePath — THE stage path of a track page", () => {
  const stages = deriveTrackStages(STAGES, "build");
  const row = (id: string, trackStage: string | null) => ({ id, trackStage });

  it("files each session at ITS stage; a missing / undeclared stage ⇒ unfiled", () => {
    const path = trackStagePath(
      stages,
      [],
      [
        row("a", "build"),
        row("b", "discover"),
        row("c", null),
        row("d", "retired-stage"),
      ]
    );
    expect(path.steps.map((s) => s.sessions.map((r) => r.id))).toEqual([
      ["b"],
      ["a"],
      [],
    ]);
    // Rule ruled out: dropping a session whose stage the method no longer declares.
    expect(path.unfiled.map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("tone is the shared stage tone; currentKey is the active stage", () => {
    const path = trackStagePath(stages, [], []);
    expect(path.steps.map((s) => s.tone)).toEqual([
      "success",
      "primary",
      "textMuted",
    ]);
    expect(path.currentKey).toBe("build");
    expect(
      trackStagePath(deriveTrackStages(STAGES, null), [], []).currentKey
    ).toBe(null);
  });

  it("entered = the LAST entry per stage; a stage not reached has no date", () => {
    const path = trackStagePath(
      stages,
      [
        { stageKey: "discover", enteredAt: "2026-09-01" },
        { stageKey: "build", enteredAt: "2026-09-05" },
        { stageKey: "ship", enteredAt: "2026-09-08" },
        { stageKey: "discover", enteredAt: "2026-09-10" },
        { stageKey: "build", enteredAt: "2026-09-12" },
      ],
      []
    );
    // Rules ruled out: first entry wins (09-01 / 09-05), and a stage the
    // track moved back from keeping its stale date (ship 09-08).
    expect(path.steps.map((s) => s.enteredAt)).toEqual([
      "2026-09-10",
      "2026-09-12",
      null,
    ]);
  });
});
