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
  trackStatusVerb,
  trackUnitInput,
  trackPausedBy,
  trackPausedByLabel,
  TRACK_STAGE_POSITIONS,
  TRACK_STATUS_TRANSITIONS,
  TRACK_STATUSES,
  trackStagePath,
  TRACK_LIFECYCLE,
  TRACK_VERDICTS,
  LIVE_TRACK_STATUSES,
  checkTrackClose,
  trackStatusCategory,
  trackVerdictsFor,
} from "./track.js";
import { resolveUnitState } from "./state.js";
import {
  ACTION_VERBS,
  resolveTrackStatusLabel,
  resolveTrackVerdictLabel,
  TRACK_STATUS_LABELS,
  TRACK_VERDICT_LABELS,
} from "../vocabulary/index.js";

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
  it("covers every status; done and lost are FINAL, every other status moves anywhere", () => {
    expect(Object.keys(TRACK_STATUS_TRANSITIONS).sort()).toEqual(
      [...TRACK_STATUSES].sort()
    );
    expect(TRACK_STATUS_TRANSITIONS.archived).toEqual([]);
    // Reopen-in-place is gone: a closed goal reopens as a NEW version.
    expect(TRACK_STATUS_TRANSITIONS.completed).toEqual([]);
    expect(canTransitionTrack("completed", "active")).toBe(false);
    expect(canTransitionTrack("archived", "active")).toBe(false);
    expect(canTransitionTrack("paused", "active")).toBe(true);
    expect(canTransitionTrack("proposed", "agreed")).toBe(true);
    expect(canTransitionTrack("active", "completed")).toBe(true);
    expect(canTransitionTrack("active", "active")).toBe(false);
    expect(canTransitionTrack("nope", "active")).toBe(false);
    // Derived from the categories, never hand-listed.
    for (const from of TRACK_STATUSES) {
      const terminal = ["done", "lost"].includes(trackStatusCategory(from)!);
      expect(TRACK_STATUS_TRANSITIONS[from]).toEqual(
        terminal ? [] : TRACK_STATUSES.filter((to) => to !== from)
      );
    }
  });

  it("names the move by where it comes FROM: resume a pause, start a ready goal", () => {
    expect(trackStatusVerb("paused", "active")).toBe("resume");
    expect(trackStatusVerb("ready", "active")).toBe("start");
    expect(trackStatusVerb("proposed", "agreed")).toBe("move");
    expect(trackStatusVerb("active", "paused")).toBe("pause");
    expect(trackStatusVerb("active", "completed")).toBe("close");
    expect(trackStatusVerb("paused", "archived")).toBe("drop");
  });

  it("a goal CAN finish: completion is offered from every open, active and paused status", () => {
    // Inverted from W1 ("a lasting track is never offered completion").
    for (const s of TRACK_STATUSES) {
      const offered = trackStatusMoves(s).map((m) => m.to);
      const open = !isTrackClosed({ status: s });
      expect(offered.includes("completed")).toBe(open);
    }
    expect(
      trackStatusMoves("active").find((m) => m.to === "completed")
    ).toEqual({ to: "completed", verb: "close" });
    // A reopen that HAPPENED in place (before 2026-10-23) is still named.
    expect(trackStatusVerb("completed", "active")).toBe("reopen");
    expect(trackStatusVerb("archived", "bogus")).toBeNull();
  });

  it("offers drop only when asked, and nothing from a closed/unknown status", () => {
    expect(trackStatusMoves("active").map((m) => m.to)).toEqual([
      "proposed",
      "agreed",
      "ready",
      "paused",
      "completed",
    ]);
    expect(
      trackStatusMoves("active", { includeArchive: true }).map((m) => m.to)
    ).toContain("archived");
    expect(trackStatusMoves("completed", { includeArchive: true })).toEqual([]);
    expect(trackStatusMoves("archived", { includeArchive: true })).toEqual([]);
    expect(trackStatusMoves("bogus")).toEqual([]);
  });

  it("every verb resolves through ACTION_VERBS (never the humanize fallback)", () => {
    for (const status of TRACK_STATUSES) {
      for (const to of TRACK_STATUSES) {
        const verb = trackStatusVerb(status, to);
        if (status === to) expect(verb).toBeNull();
        else expect(ACTION_VERBS[verb!]).toBeDefined();
      }
    }
  });
});

describe("TRACK_LIFECYCLE — the track's system lifecycle", () => {
  it("declares every status once, with its category; only completed is human-only", () => {
    expect(TRACK_LIFECYCLE.options.map((o) => o.key)).toEqual([
      ...TRACK_STATUSES,
    ]);
    expect(
      Object.fromEntries(
        TRACK_LIFECYCLE.options.map((o) => [o.key, o.category])
      )
    ).toEqual({
      proposed: "open",
      agreed: "open",
      ready: "open",
      active: "active",
      paused: "paused",
      completed: "done",
      archived: "lost",
    });
    expect(
      TRACK_LIFECYCLE.options.filter((o) => o.humanOnly).map((o) => o.key)
    ).toEqual(["completed"]);
  });

  it("reads its words from the vocabulary: completed is Closed, archived is Dropped", () => {
    const label = (k: string) =>
      TRACK_LIFECYCLE.options.find((o) => o.key === k)!.label;
    expect(label("completed")).toBe("Closed");
    expect(label("archived")).toBe("Dropped");
    expect(label("proposed")).toBe("Proposed");
    for (const s of TRACK_STATUSES) {
      expect(resolveTrackStatusLabel(s)).toBe(TRACK_STATUS_LABELS[s]);
    }
    expect(resolveTrackStatusLabel("bogus_state")).toBe("Bogus state");
    for (const v of TRACK_VERDICTS) {
      expect(resolveTrackVerdictLabel(v)).toBe(TRACK_VERDICT_LABELS[v]);
    }
  });

  it("live and closed partition the statuses by category", () => {
    expect([...LIVE_TRACK_STATUSES, ...CLOSED_TRACK_STATUSES].sort()).toEqual(
      [...TRACK_STATUSES].sort()
    );
    for (const s of LIVE_TRACK_STATUSES) {
      expect(["open", "active", "paused"]).toContain(trackStatusCategory(s));
    }
    expect(trackStatusCategory("bogus")).toBeNull();
  });
});

describe("checkTrackClose — the verdict rule (R1)", () => {
  it("a close without a verdict is refused; a done verdict closes", () => {
    expect(checkTrackClose("completed", {})).toMatch(/needs a verdict/);
    for (const v of ["met", "partly_met", "not_met"]) {
      expect(checkTrackClose("completed", { verdict: v })).toBeNull();
    }
  });

  it("a done close with a LOST verdict is refused, and the reverse", () => {
    expect(
      checkTrackClose("completed", { verdict: "no_longer_needed" })
    ).toMatch(/not a verdict for closing/);
    expect(checkTrackClose("archived", { verdict: "met" })).toMatch(
      /not a verdict for dropping/
    );
    expect(
      checkTrackClose("archived", { verdict: "no_longer_needed" })
    ).toBeNull();
  });

  it("a DROP without a verdict is accepted (shipped clients), a CLOSE without one is not", () => {
    // Back-compat: browser Archive, the released CLI and the IS drop with no
    // verdict; the track then reads like one dropped before 0344.
    expect(checkTrackClose("archived", {})).toBeNull();
    expect(checkTrackClose("archived", { verdict: null })).toBeNull();
    expect(checkTrackClose("completed", {})).toMatch(/needs a verdict/);
    // A reason with no verdict says nothing about how it ended: refused.
    expect(
      checkTrackClose("archived", { verdictReason: "the market moved" })
    ).toMatch(/needs its verdict/);
  });

  it("impossible and replaced need a reason in words", () => {
    for (const v of ["impossible", "replaced"]) {
      expect(checkTrackClose("archived", { verdict: v })).toMatch(
        /needs a verdictReason/
      );
      expect(
        checkTrackClose("archived", { verdict: v, verdictReason: "  " })
      ).toMatch(/needs a verdictReason/);
      expect(
        checkTrackClose("archived", { verdict: v, verdictReason: "why" })
      ).toBeNull();
    }
  });

  it("a move that ends nothing carries no verdict", () => {
    expect(checkTrackClose("paused", {})).toBeNull();
    expect(checkTrackClose("paused", { verdict: "met" })).toMatch(
      /only when a goal is closed/
    );
  });

  it("every verdict belongs to exactly the ending its category names", () => {
    expect([...trackVerdictsFor("completed")]).toEqual([
      "met",
      "partly_met",
      "not_met",
    ]);
    expect([...trackVerdictsFor("archived")]).toEqual([
      "no_longer_needed",
      "impossible",
      "replaced",
      "mistake",
    ]);
    expect(trackVerdictsFor("active")).toEqual([]);
  });
});

describe("R6 — an operation closes retired, and only an operation does", () => {
  it("an operation is never met, partly met or not met: it closes retired", () => {
    for (const v of ["met", "partly_met", "not_met"]) {
      expect(
        checkTrackClose("completed", { verdict: v }, undefined, "operation")
      ).toMatch(/operation is never/);
    }
    expect(
      checkTrackClose(
        "completed",
        { verdict: "retired" },
        undefined,
        "operation"
      )
    ).toBeNull();
    expect([...trackVerdictsFor("completed", "operation")]).toEqual([
      "retired",
    ]);
  });

  it("retired is refused for every other kind of work, and for a goal with no kind", () => {
    for (const kind of [
      null,
      undefined,
      "project",
      "flow",
      "investigation",
      "incident",
      "commission",
      "pathway",
    ]) {
      expect(
        checkTrackClose("completed", { verdict: "retired" }, undefined, kind)
      ).toMatch(/Only an operation closes as retired/);
      expect([...trackVerdictsFor("completed", kind)]).toEqual([
        "met",
        "partly_met",
        "not_met",
      ]);
    }
  });

  it("an operation is dropped like any goal; retired is never a drop", () => {
    expect([...trackVerdictsFor("archived", "operation")]).toEqual([
      "no_longer_needed",
      "impossible",
      "replaced",
      "mistake",
    ]);
    expect(
      checkTrackClose(
        "archived",
        { verdict: "no_longer_needed" },
        undefined,
        "operation"
      )
    ).toBeNull();
    expect(
      checkTrackClose(
        "archived",
        { verdict: "retired" },
        undefined,
        "operation"
      )
    ).toMatch(/not a verdict for dropping/);
  });

  it("retired reads Retired, and belongs to the done ending", () => {
    expect(resolveTrackVerdictLabel("retired")).toBe("Retired");
    expect(TRACK_VERDICTS).toContain("retired");
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
  it("a goal being shaped (open category) aggregates its sessions like an active one", () => {
    for (const status of ["proposed", "agreed", "ready"]) {
      expect(resolveUnitState(trackUnitInput({ status }, needsYou)).state).toBe(
        "needs_you"
      );
    }
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

describe("trackPausedByLabel", () => {
  it("names the holder of a paused track, through the paused status word", () => {
    expect(trackPausedByLabel("check")).toBe("Paused \u00b7 by a check");
    expect(trackPausedByLabel("human")).toBe("Paused \u00b7 by a person");
  });
  it("says nothing for a track that is not paused", () => {
    expect(trackPausedByLabel(null)).toBeNull();
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
  it("completed and archived are closed; open, active and paused are not", () => {
    // Rule ruled out: `isTrackRetired` (archived only) — a COMPLETED track
    // still offered stage starts on the phone.
    expect(isTrackClosed({ status: "completed" })).toBe(true);
    expect(isTrackClosed({ status: "archived" })).toBe(true);
    // Rule ruled out: "not active" — a paused track resumes where it stands.
    expect(isTrackClosed({ status: "paused" })).toBe(false);
    expect(isTrackClosed({ status: "active" })).toBe(false);
    // A goal being shaped is live, never closed.
    expect(isTrackClosed({ status: "proposed" })).toBe(false);
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
