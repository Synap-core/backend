/**
 * The lens view-model. Fixture rows are chosen where candidate rules DISAGREE
 * (guards-and-tests.md): a draft inside the needs-you lens (a naive
 * "needs-you ⇒ blocking" rule says blocking), a proposal cluster (a naive
 * "proposals are Proposed" rule says proposed), a system notification (a
 * naive rule makes it a row), an ancestor source (a naive "equal only" rule
 * shows it), a failed blocking read (a naive `?? 0` says All clear).
 */
import { describe, expect, it } from "vitest";
import { needsYouRows } from "../needs-you/index.js";
import { resolveUnitState } from "../units/state.js";
import type { ActivityRow } from "../activity/index.js";
import {
  ATTENTION_CLASSES,
  LENS_CAPS,
  LENS_SECTION_ORDER,
  LENS_SCOPE_FACT_KIND,
  batchHappened,
  capLensRows,
  encodeLensScope,
  happenedAtRest,
  lensHeaderModel,
  lensRowOfHappening,
  lensRowOfNeedsYou,
  lensScopeFactLabel,
  lensSections,
  lensStatusBanner,
  parseLensScope,
  partitionNeedsYou,
  placeSignal,
  STATUS_BANNER_NOTIFICATION_TYPES,
  visibleSource,
  type LensNeedsYouSignal,
  type LensScope,
} from "./index.js";

function sig(
  over: Partial<LensNeedsYouSignal> & { id: string; kind: string }
): LensNeedsYouSignal {
  return {
    title: over.id,
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    occurredAt: "2026-10-04T10:00:00.000Z",
    ...over,
  };
}

describe("placeSignal — the approved Proposed definition", () => {
  it("an agent DRAFT in the needs-you lens is PROPOSED, not blocking", () => {
    expect(placeSignal({ kind: "draft-asks" }, "needs-you")).toBe("proposed");
  });
  it("a pending proposal cluster (an agent paused on it included) is BLOCKING", () => {
    expect(placeSignal({ kind: "proposal-cluster" }, "needs-you")).toBe(
      "blocking"
    );
  });
  it("a system-HEALTH type is the banner; invite / unknown / untyped system rows and governance are blocking", () => {
    expect(STATUS_BANNER_NOTIFICATION_TYPES.size).toBeGreaterThan(0);
    for (const t of STATUS_BANNER_NOTIFICATION_TYPES) {
      expect(
        placeSignal(
          { kind: "notification", category: "system", notificationType: t },
          "needs-you"
        )
      ).toBe("banner");
    }
    for (const notificationType of [
      "workspace.invite",
      "system.issuer_pending_approval",
      "system.some_future_type",
      undefined,
    ]) {
      expect(
        placeSignal(
          { kind: "notification", category: "system", notificationType },
          "needs-you"
        )
      ).toBe("blocking");
    }
    expect(
      placeSignal({ kind: "notification", category: "governance" }, "needs-you")
    ).toBe("blocking");
  });
  it("owed slots and session reviews are blocking; suggestions are proposed", () => {
    expect(placeSignal({ kind: "owed-slot" }, "needs-you")).toBe("blocking");
    expect(placeSignal({ kind: "session-review" }, "needs-you")).toBe(
      "blocking"
    );
    expect(
      placeSignal({ kind: "notification", category: "ai" }, "suggestions")
    ).toBe("proposed");
    expect(placeSignal({ kind: "event" }, "history")).toBe("happened");
  });
  it("partitionNeedsYou is stable and three-way", () => {
    const page = [
      sig({ id: "a", kind: "owed-slot" }),
      sig({ id: "b", kind: "draft-asks" }),
      sig({
        id: "c",
        kind: "notification",
        category: "system",
        notificationType: "system.intelligence_degraded",
      }),
      sig({
        id: "e",
        kind: "notification",
        category: "system",
        notificationType: "workspace.invite",
      }),
      sig({ id: "d", kind: "proposal-cluster" }),
    ];
    const p = partitionNeedsYou(page);
    expect(p.blocking.map((s) => s.id)).toEqual(["a", "e", "d"]);
    expect(p.proposed.map((s) => s.id)).toEqual(["b"]);
    expect(p.banners.map((s) => s.id)).toEqual(["c"]);
  });
});

describe("sections and caps", () => {
  it("order is fixed: produced above happened, proposed below the work", () => {
    expect(LENS_SECTION_ORDER.indexOf("produced")).toBeLessThan(
      LENS_SECTION_ORDER.indexOf("happened")
    );
    expect(LENS_SECTION_ORDER.indexOf("structure")).toBeLessThan(
      LENS_SECTION_ORDER.indexOf("proposed")
    );
    expect(LENS_SECTION_ORDER[0]).toBe("blocking");
  });
  it("structure exists on project/track only; data only when the scope owns it", () => {
    expect(lensSections("session")).not.toContain("structure");
    expect(lensSections("pod")).not.toContain("structure");
    expect(lensSections("track")).toContain("structure");
    expect(lensSections("project", { ownsData: true })).toContain("data");
    expect(lensSections("project")).not.toContain("data");
  });
  it("every class has a cap", () => {
    for (const c of ATTENTION_CLASSES) expect(LENS_CAPS[c]).toBeGreaterThan(0);
  });
  it("capLensRows counts hidden ITEMS in row units (a session card counts its items)", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i, count: 1 }));
    rows.push({ id: 5, count: 3 }); // the 6th row: a session card owing 3
    const c = capLensRows(rows, "blocking");
    expect(c.shown).toHaveLength(5);
    expect(c.hiddenRows).toBe(1);
    expect(c.hiddenItems).toBe(3);
    expect(c.total).toBe(8);
  });
});

describe("visibleSource — shown only when it adds something", () => {
  const session = { kind: "session" as const, id: "s1", label: "Backup run" };
  const project = { kind: "project" as const, id: "p1", label: "Synap" };
  it("hidden when the source IS the scope", () => {
    expect(
      visibleSource({ source: session }, { kind: "session", sessionId: "s1" })
    ).toBeNull();
  });
  it("hidden when the scope sits INSIDE the source (its own project, on a session page)", () => {
    const scope: LensScope = {
      kind: "session",
      sessionId: "s1",
      projectId: "p1",
    };
    expect(visibleSource({ source: project }, scope)).toBeNull();
  });
  it("shown when MORE specific than the scope, and everywhere on Home", () => {
    expect(
      visibleSource({ source: session }, { kind: "project", projectId: "p1" })
    ).toBe(session);
    expect(visibleSource({ source: project }, { kind: "pod" })).toBe(project);
  });
  it("a different session on a session page is shown", () => {
    expect(
      visibleSource({ source: session }, { kind: "session", sessionId: "s2" })
    ).toBe(session);
  });
});

describe("scope address", () => {
  it("round-trips every kind; pod/workspace/project spelled by the activity door", () => {
    const scopes: LensScope[] = [
      { kind: "pod" },
      { kind: "workspace", workspaceId: "w" },
      { kind: "project", projectId: "p" },
      { kind: "track", trackId: "t" },
      { kind: "session", sessionId: "s" },
    ];
    for (const s of scopes)
      expect(parseLensScope(encodeLensScope(s))).toEqual(s);
    expect(encodeLensScope({ kind: "project", projectId: "p" })).toBe(
      "project:p"
    );
    expect(parseLensScope("nonsense:")).toBeUndefined();
  });
});

describe("lensRowOfNeedsYou — one item = one row, through needsYouRows", () => {
  it("an owed slot names the EXACT ask (why), not the generic reason label", () => {
    const { recent } = needsYouRows([
      sig({
        id: "o",
        kind: "owed-slot",
        why: "Backup target bucket",
        blockedReason: "decision",
      }),
    ]);
    const row = lensRowOfNeedsYou(recent[0]!, "blocking");
    expect(row.reason).toBe("Backup target bucket");
    expect(row.verb).toEqual({ action: "answer", label: "Answer" });
    expect(resolveUnitState(row.state).state).toBe("needs_you");
  });
  it("falls back to the reason label only when there is no why", () => {
    const { recent } = needsYouRows([
      sig({ id: "o", kind: "owed-slot", blockedReason: "credential" }),
    ]);
    expect(lensRowOfNeedsYou(recent[0]!, "blocking").reason).toBe(
      "Credential missing"
    );
  });
  it("a session owing three things is ONE row counting 3, opening the session", () => {
    const g = "session:s1";
    const { recent } = needsYouRows([
      sig({ id: "a", kind: "owed-slot", groupKey: g, sessionTitle: "Ship it" }),
      sig({ id: "b", kind: "owed-slot", groupKey: g }),
      sig({ id: "c", kind: "proposal-cluster", groupKey: g }),
    ]);
    expect(recent).toHaveLength(1);
    const row = lensRowOfNeedsYou(recent[0]!, "blocking");
    expect(row.count).toBe(3);
    expect(row.title).toBe("Ship it");
    expect(row.door).toEqual({ kind: "session", id: "s1" });
    expect(row.verb).toBeNull();
    expect(row.source).toBeNull();
  });
  it("a single session item carries its session as the source door", () => {
    const { recent } = needsYouRows([
      sig({
        id: "a",
        kind: "proposal-cluster",
        groupKey: "session:s9",
        sessionTitle: "Research",
      }),
    ]);
    const row = lensRowOfNeedsYou(recent[0]!, "blocking");
    expect(row.source).toEqual({
      kind: "session",
      id: "s9",
      label: "Research",
    });
    expect(row.verb?.action).toBe("approve");
    expect(resolveUnitState(row.state).state).toBe("needs_review");
  });
  it("a draft row is never marked working", () => {
    const { recent } = needsYouRows([
      sig({ id: "d", kind: "draft-asks", count: 2 }),
    ]);
    const row = lensRowOfNeedsYou(recent[0]!, "proposed");
    expect(resolveUnitState(row.state).state).toBe("not_started");
    expect(row.reason).toBe("2 asks");
  });
  it("happening rows are live and verb-less", () => {
    const row = lensRowOfHappening({
      id: "h",
      title: "Drafting",
      objectKind: "session",
      door: { kind: "session", id: "h" },
      source: null,
      startedAt: "2026-10-04T09:00:00Z",
      nowLine: "Reading the brief",
    });
    expect(resolveUnitState(row.state).state).toBe("working");
    expect(row.verb).toBeNull();
    expect(row.reason).toBe("Reading the brief");
  });
});

function act(id: string, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id,
    source: "proposal",
    occurredAt: "2026-10-04T10:00:00.000Z",
    actor: { kind: "agent", id: "ag1", name: "Scout" },
    action: "update",
    verb: "Updated",
    title: id,
    object: { kind: "entity", id, name: id },
    proposalId: null,
    project: null,
    session: null,
    outcome: "succeeded",
    undo: null,
    error: null,
    ...over,
  };
}

describe("batchHappened — day-grouped, consecutive runs only", () => {
  const now = new Date("2026-10-04T18:00:00Z");
  it("batches consecutive same actor × act × kind; an act in between splits it", () => {
    const days = batchHappened(
      [
        act("a"),
        act("b"),
        act("c", { action: "create" }),
        act("d"),
        act("e", { occurredAt: "2026-10-03T10:00:00.000Z" }),
      ],
      { timeZone: "UTC", now }
    );
    expect(days.map((d) => d.day)).toEqual(["2026-10-04", "2026-10-03"]);
    expect(days[0]!.isToday).toBe(true);
    expect(days[0]!.lines.map((l) => l.count)).toEqual([2, 1, 1]);
  });
  it("a different actor never batches, and a failed act stands alone", () => {
    const days = batchHappened(
      [
        act("a"),
        act("b", { actor: { kind: "agent", id: "ag2", name: "Other" } }),
        act("c", {
          actor: { kind: "agent", id: "ag2", name: "Other" },
          outcome: "failed",
        }),
      ],
      { timeZone: "UTC", now }
    );
    expect(days[0]!.lines.map((l) => l.count)).toEqual([1, 1, 1]);
  });
  it("at rest = today only, capped", () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      act(`r${i}`, { actor: { kind: "agent", id: `ag${i}`, name: null } })
    );
    rows.push(act("old", { occurredAt: "2026-09-30T10:00:00.000Z" }));
    const rest = happenedAtRest(
      batchHappened(rows, { timeZone: "UTC", now }),
      LENS_CAPS.happened
    );
    expect(rest.today).toHaveLength(10);
    expect(rest.hiddenLines).toBe(4);
  });
});

describe("lensHeaderModel", () => {
  it("a FAILED blocking read is never All clear and never says 0", () => {
    const m = lensHeaderModel({
      scopeKind: "project",
      state: { owedFromYou: null },
      counts: { blocking: null, happening: 0, produced: 3 },
    });
    expect(m.allClear).toBe(false);
    expect(m.doors.find((d) => d.section === "blocking")!.count).toBeNull();
    expect(m.narrative.map((p) => p.key)).toEqual(["produced"]);
    expect(m.state.state).toBe("unmeasured");
  });
  it("a read zero IS All clear; the narrative reads in the founder's words", () => {
    const m = lensHeaderModel({
      scopeKind: "session",
      state: { running: true },
      counts: { blocking: 1, happening: 1, produced: 3 },
      lastActivityAt: "2026-10-04T10:00:00Z",
      fact: { kind: "criteria", met: 2, total: 4 },
    });
    expect(m.narrative).toEqual([
      { key: "produced", text: "3 delivered" },
      { key: "blocking", text: "1 waiting on you" },
      { key: "happening", text: "1 in progress" },
      { key: "last-activity", at: "2026-10-04T10:00:00.000Z" },
    ]);
    expect(m.doors.map((d) => d.label)).toEqual([
      "Needs you",
      "Happening",
      "Produced",
    ]);
    expect(
      lensHeaderModel({
        scopeKind: "track",
        state: {},
        counts: { blocking: 0, happening: 0, produced: 0 },
      }).allClear
    ).toBe(true);
  });
  it("a lead names the exact ask FIRST and replaces its own count clause", () => {
    const m = lensHeaderModel({
      scopeKind: "session",
      state: { owedFromYou: 2 },
      counts: { blocking: 2, happening: 1, produced: 3 },
      lead: { section: "blocking", text: "Waiting on you: Approve the brief" },
    });
    expect(m.narrative).toEqual([
      { key: "blocking", text: "Waiting on you: Approve the brief" },
      { key: "produced", text: "3 delivered" },
      { key: "happening", text: "1 in progress" },
    ]);
    // A happening lead swaps only the happening clause.
    const h = lensHeaderModel({
      scopeKind: "session",
      state: { running: true },
      counts: { blocking: 1, happening: 1, produced: 0 },
      lead: { section: "happening", text: "Drafting the outline" },
    });
    expect(h.narrative.map((p) => ("text" in p ? p.text : p.key))).toEqual([
      "Drafting the outline",
      "1 waiting on you",
    ]);
    // A blank lead is no lead.
    const b = lensHeaderModel({
      scopeKind: "session",
      state: {},
      counts: { blocking: 1, happening: 0, produced: 0 },
      lead: { section: "blocking", text: "  " },
    });
    expect(b.narrative).toEqual([
      { key: "blocking", text: "1 waiting on you" },
    ]);
  });
  it("ONE scope fact per kind", () => {
    expect(LENS_SCOPE_FACT_KIND).toEqual({
      pod: null,
      workspace: null,
      project: "target-date",
      track: "step",
      session: "criteria",
    });
    expect(lensScopeFactLabel({ kind: "step", index: 3, total: 5 })).toBe(
      "Step 3 of 5"
    );
    expect(lensScopeFactLabel({ kind: "criteria", met: 2, total: 4 })).toBe(
      "2 of 4 met"
    );
    expect(lensScopeFactLabel({ kind: "target-date", at: null })).toBeNull();
  });
});

describe("lensStatusBanner — ONE, deduplicated", () => {
  it("dedupes by key and leads with the worst tone", () => {
    const b = lensStatusBanner([
      {
        key: "hub",
        tone: "info",
        title: "Hub slow",
        occurredAt: "2026-10-04T09:00:00Z",
      },
      {
        key: "hub",
        tone: "info",
        title: "Hub slow (again)",
        occurredAt: "2026-10-04T10:00:00Z",
      },
      { key: "pod", tone: "error", title: "Pod unreachable" },
    ]);
    expect(b).toEqual({
      key: "pod",
      tone: "error",
      title: "Pod unreachable",
      more: 1,
    });
    expect(lensStatusBanner([])).toBeNull();
  });
});
