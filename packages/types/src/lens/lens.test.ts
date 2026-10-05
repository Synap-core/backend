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
  LENS_SCOPE_HAS_PULSE,
  LENS_SECTION_LABELS,
  LENS_SECTION_ORDER,
  LENS_SCOPE_FACT_KIND,
  batchHappened,
  capLensRows,
  encodeLensScope,
  happenedAtRest,
  lensHeaderModel,
  lensRowOfHappening,
  lensRowExpiry,
  lensRowsChangeMessage,
  lensRowOfNeedsYou,
  LENS_EXPIRY_URGENT_MS,
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
  it("a space filtered by its project hides that project's source (it says nothing new)", () => {
    const scope: LensScope = {
      kind: "workspace",
      workspaceId: "w",
      projectId: "p1",
    };
    expect(visibleSource({ source: project }, scope)).toBeNull();
    expect(
      visibleSource(
        { source: project },
        { kind: "workspace", workspaceId: "w" }
      )
    ).toBe(project);
    expect(visibleSource({ source: session }, scope)).toBe(session);
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
    // A space × project scope addresses the SPACE (the project rides on the
    // surface lens, not in the token).
    expect(
      encodeLensScope({ kind: "workspace", workspaceId: "w", projectId: "p" })
    ).toBe("workspace:w");
    expect(parseLensScope("nonsense:")).toBeUndefined();
  });
});

describe("lensRowOfNeedsYou — one item = one row, through needsYouRows", () => {
  // Dogfood 2026-10-05 (real pod): the reason slot drew the agent's `why` —
  // "Founder wants cost/trade-off data before choosing HDD…" — as long grey
  // prose beside the title. The title IS the ask (the slot label); `why` is
  // the description and goes to `detail`; "Human decision" is never a chip.
  it("an owed slot: the label is the ask, `why` is the detail, no generic chip", () => {
    const { recent } = needsYouRows([
      sig({
        id: "o",
        kind: "owed-slot",
        title: "B1 — off-host backup target (needs cost data)",
        why: "Founder wants cost/trade-off data before choosing HDD vs B2",
        blockedReason: "decision",
      }),
    ]);
    const row = lensRowOfNeedsYou(recent[0]!, "blocking");
    expect(row.title).toBe("B1 — off-host backup target (needs cost data)");
    expect(row.reason).toBeNull();
    expect(row.detail).toBe(
      "Founder wants cost/trade-off data before choosing HDD vs B2"
    );
    expect(row.verb).toEqual({ action: "answer", label: "Answer" });
    expect(resolveUnitState(row.state).state).toBe("needs_you");
  });
  it("a SPECIFIC obstacle is the chip, why or not", () => {
    const { recent } = needsYouRows([
      sig({
        id: "o",
        kind: "owed-slot",
        why: "Needs the B2 key",
        blockedReason: "credential",
      }),
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
    // Dogfood 2026-10-05: the grouped "Production readiness" card had no
    // verb. A card opens its session, so its one verb is "Review N".
    expect(row.verb).toEqual({ action: "review", label: "Review 3" });
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
  it("an agent-raised ask carries byAgent; a governance one does not", () => {
    // Discriminating pair: same kind, the category alone decides.
    const { recent } = needsYouRows([
      sig({ id: "o", kind: "owed-slot", category: "ai" }),
      sig({
        id: "p",
        kind: "owed-slot",
        category: "governance",
        occurredAt: "2026-10-04T09:00:00.000Z",
      }),
    ]);
    const rows = recent.map((r) => lensRowOfNeedsYou(r, "blocking"));
    expect(rows.find((r) => r.key === "o")?.byAgent).toBe(true);
    expect(rows.find((r) => r.key === "p")?.byAgent).toBe(false);
  });
  it("expiresAt = occurredAt + the server's lifetime; none without one", () => {
    const { recent } = needsYouRows([
      sig({ id: "e", kind: "proposal-cluster", lifetimeHours: 4 }),
      sig({
        id: "n",
        kind: "proposal-cluster",
        lifetimeHours: null,
        occurredAt: "2026-10-04T09:00:00.000Z",
      }),
    ]);
    const rows = recent.map((r) => lensRowOfNeedsYou(r, "blocking"));
    expect(rows.find((r) => r.key === "e")?.expiresAt).toBe(
      "2026-10-04T14:00:00.000Z"
    );
    expect(rows.find((r) => r.key === "n")?.expiresAt).toBeNull();
  });
  it("lensRowExpiry: words + urgency at the boundary, Expired after", () => {
    const end = Date.parse("2026-10-04T14:00:00.000Z");
    const row = { expiresAt: "2026-10-04T14:00:00.000Z" };
    expect(lensRowExpiry(row, end - 2 * 3_600_000)).toEqual({
      label: "Expires in 2h",
      urgent: false,
      expired: false,
    });
    expect(lensRowExpiry(row, end - LENS_EXPIRY_URGENT_MS)).toEqual({
      label: "Expires in 1h",
      urgent: true,
      expired: false,
    });
    expect(
      lensRowExpiry(row, end - LENS_EXPIRY_URGENT_MS - 60_000)?.urgent
    ).toBe(false);
    expect(lensRowExpiry(row, end - 22 * 60_000)?.label).toBe("Expires in 22m");
    expect(lensRowExpiry(row, end)).toEqual({
      label: "Expired",
      urgent: true,
      expired: true,
    });
    expect(lensRowExpiry({ expiresAt: null }, end)).toBeNull();
    expect(lensRowExpiry({}, end)).toBeNull();
  });
  it("lensRowsChangeMessage: counts only, null on a no-op", () => {
    expect(lensRowsChangeMessage("Needs you", { added: 2, removed: 1 })).toBe(
      "Needs you: 2 new, 1 cleared"
    );
    expect(lensRowsChangeMessage("Needs you", { added: 0, removed: 3 })).toBe(
      "Needs you: 3 cleared"
    );
    expect(lensRowsChangeMessage("Produced", { added: 1, removed: 0 })).toBe(
      "Produced: 1 new"
    );
    expect(
      lensRowsChangeMessage("Produced", { added: 0, removed: 0 })
    ).toBeNull();
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
    // An unknown count is named without a number — never "0 need you".
    expect(m.doors.find((d) => d.section === "blocking")!.text).toBe(
      "Needs you"
    );
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
    // v2: the strip reads Needs you · Produced · Happening, each count said
    // once, in words.
    expect(m.doors.map((d) => d.label)).toEqual([
      "Needs you",
      "Produced",
      "Happening",
    ]);
    expect(m.doors.map((d) => d.text)).toEqual([
      "1 needs you",
      "3 delivered",
      "1 running",
    ]);
    expect(m.lastActivityAt).toBe("2026-10-04T10:00:00.000Z");
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
  it("the NEXT MOVE is the row's exact ask with the row's OWN verb — never Open for an ask", () => {
    const owed = lensRowOfNeedsYou(
      {
        kind: "item",
        key: "o1",
        signal: sig({
          id: "o1",
          kind: "owed-slot",
          title: "Mint CROSS_REPO_TOKEN",
          target: { kind: "session", id: "s-o1" },
        }),
        session: null,
      },
      "blocking"
    );
    const m = lensHeaderModel({
      scopeKind: "project",
      state: { owedFromYou: 9 },
      counts: { blocking: 9, happening: 1, produced: 57 },
      nextMove: owed,
    });
    expect(m.nextMove).toMatchObject({
      section: "blocking",
      reason: "Waiting on you",
      text: "Mint CROSS_REPO_TOKEN",
      verb: { action: "answer", label: "Answer" },
      door: { kind: "session", id: "s-o1" },
    });
    expect(m.nextMove!.state.state).toBe("needs_you");
    // A Blocking notification has no verb of its own: still an ask ⇒ Review.
    const note = lensRowOfNeedsYou(
      {
        kind: "item",
        key: "n1",
        signal: sig({
          id: "n1",
          kind: "notification",
          title: "Check the brief",
        }),
        session: null,
      },
      "blocking"
    );
    expect(note.verb).toBeNull();
    expect(
      lensHeaderModel({
        scopeKind: "project",
        state: {},
        counts: { blocking: 1, happening: 0, produced: 0 },
        nextMove: note,
      }).nextMove!.verb.label
    ).toBe("Review");
    // Work in flight: the now-line, "Working", and Open (it can only be watched).
    const live = lensRowOfHappening({
      id: "s1",
      title: "Session title",
      objectKind: "session",
      door: { kind: "session", id: "s1" },
      source: null,
      startedAt: null,
      nowLine: "Drafting the outline",
    });
    expect(
      lensHeaderModel({
        scopeKind: "track",
        state: { running: true },
        counts: { blocking: 0, happening: 1, produced: 0 },
        nextMove: live,
      }).nextMove
    ).toMatchObject({
      section: "happening",
      reason: "Working",
      text: "Drafting the outline",
      verb: { action: "open" },
    });
    // A Blocking move with a counted ZERO (a session's own grade the pod's
    // union does not carry) is never "All clear" — the two would contradict.
    expect(
      lensHeaderModel({
        scopeKind: "session",
        state: {},
        counts: { blocking: 0, happening: 0, produced: 1 },
        nextMove: owed,
      }).allClear
    ).toBe(false);
    // No row ⇒ no move (the host's "Start work" takes the slot).
    expect(
      lensHeaderModel({
        scopeKind: "track",
        state: {},
        counts: { blocking: 0, happening: 0, produced: 0 },
      }).nextMove
    ).toBeNull();
  });
  it("ONE scope fact per kind", () => {
    expect(LENS_SCOPE_FACT_KIND).toEqual({
      pod: null,
      workspace: null,
      project: "target-date",
      track: ["kpi", "step"],
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

describe("header doors point only at sections that are on the page", () => {
  it("a READ zero omits its door; an unknown (null) keeps it, numberless", () => {
    // Disagreeing rules: "always three doors" draws Happening 0 (a door to an
    // omitted section); "omit falsy" also drops the null door — but a failed
    // section still draws (with its retry), so its door must stay.
    const m = lensHeaderModel({
      scopeKind: "project",
      state: {},
      counts: { blocking: null, happening: 0, produced: 2 },
    });
    expect(m.doors).toEqual([
      {
        section: "blocking",
        label: "Needs you",
        count: null,
        text: "Needs you",
      },
      { section: "produced", label: "Produced", count: 2, text: "2 delivered" },
    ]);
  });
  it("the model carries its scope kind; a session lens has NO pulse", () => {
    expect(
      lensHeaderModel({
        scopeKind: "session",
        state: {},
        counts: { blocking: 0, happening: 0, produced: 0 },
      }).scopeKind
    ).toBe("session");
    expect(LENS_SCOPE_HAS_PULSE.session).toBe(false);
    expect(LENS_SCOPE_HAS_PULSE.project).toBe(true);
    expect(LENS_SCOPE_HAS_PULSE.track).toBe(true);
  });
  it("the work-structure slot is named Plan (not Work, which names the app)", () => {
    expect(LENS_SECTION_LABELS.structure).toBe("Plan");
  });
});

describe("lensStatusBanner — ONE, deduplicated", () => {
  it("carries the lead's door and EVERY folded condition's notifications", () => {
    const b = lensStatusBanner([
      {
        key: "hub",
        tone: "error",
        title: "Hub degraded",
        target: { kind: "app", id: "settings" },
        notificationIds: ["n1", "n2"],
      },
      {
        key: "disk",
        tone: "info",
        title: "Disk",
        notificationIds: ["n3", "n1"],
      },
    ]);
    expect(b!.target).toEqual({ kind: "app", id: "settings" });
    expect(b!.notificationIds).toEqual(["n1", "n2", "n3"]);
  });
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
      target: null,
      notificationIds: [],
    });
    expect(lensStatusBanner([])).toBeNull();
  });
});
