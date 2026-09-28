import { describe, expect, it } from "vitest";
import {
  LANDED_DECISION_STATES,
  LANDED_SESSION_STATUSES,
  LANDED_SINCE_MAX,
  landedSince,
  matchesLandedActor,
  resolveLandedDecision,
  resolveLandedDecisionView,
  resolveLandedSessionState,
  summarizeSessionOutputs,
  type LandedActor,
} from "./index.js";
import { STATUS_LABELS } from "../vocabulary/index.js";
import { TERMINAL_SESSION_STATUSES } from "../focus-sessions/statuses.js";

const at = (iso: string) => new Date(iso);

describe("landedSince — THE selection both apps use", () => {
  const since = "2026-09-28T08:00:00.000Z";
  const rows = [
    { id: "closed-after", status: "closed", closedAt: at("2026-09-28T09:00:00Z"), updatedAt: at("2026-09-28T09:00:00Z") },
    { id: "failed-after", status: "failed", closedAt: null, updatedAt: "2026-09-28T10:00:00Z" },
    { id: "cancelled-after", status: "cancelled", closedAt: "2026-09-28T08:30:00Z", updatedAt: "2026-09-28T08:30:00Z" },
    // Settled BEFORE `since`, touched after: the clock is closed_at, not updated_at.
    { id: "closed-before-touched-after", status: "closed", closedAt: "2026-09-28T07:00:00Z", updatedAt: "2026-09-28T11:00:00Z" },
    { id: "active-after", status: "active", closedAt: null, updatedAt: "2026-09-28T11:30:00Z" },
    { id: "stale-after", status: "stale", closedAt: null, updatedAt: "2026-09-28T11:30:00Z" },
    { id: "exactly-since", status: "closed", closedAt: since, updatedAt: since },
  ];

  it("keeps settled sessions (failures included) at or after since, newest first", () => {
    expect(landedSince(rows, since).map((r) => r.id)).toEqual([
      "failed-after",
      "closed-after",
      "cancelled-after",
      "exactly-since",
    ]);
  });

  it("the settle clock is coalesce(closedAt, updatedAt)", () => {
    const ids = landedSince(rows, since).map((r) => r.id);
    expect(ids).not.toContain("closed-before-touched-after");
    expect(ids).toContain("failed-after"); // no closedAt → updatedAt
  });

  it("caps at LANDED_SINCE_MAX by default, and at an explicit limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      status: "closed",
      closedAt: new Date(Date.parse(since) + i * 60_000),
      updatedAt: new Date(Date.parse(since) + i * 60_000),
      i,
    }));
    expect(landedSince(many, since)).toHaveLength(LANDED_SINCE_MAX);
    expect(landedSince(many, since)[0]!.i).toBe(14);
    expect(landedSince(many, since, { limit: 3 }).map((r) => r.i)).toEqual([14, 13, 12]);
  });

  it("an unreadable since throws rather than answering 'nothing landed'", () => {
    expect(() => landedSince(rows, "not a date")).toThrow(RangeError);
  });

  it("the landed statuses ARE the terminal statuses (one lifecycle, not a copy)", () => {
    expect([...LANDED_SESSION_STATUSES]).toEqual([...TERMINAL_SESSION_STATUSES]);
  });

  it("a failed session wears the failure tone; other exits read done", () => {
    expect(resolveLandedSessionState("failed")).toMatchObject({ state: "failed", tone: "error" });
    expect(resolveLandedSessionState("closed")).toMatchObject({ state: "done", glyph: "check" });
    expect(resolveLandedSessionState("cancelled").state).toBe("done");
  });
});

describe("decision state", () => {
  it("maps the creating proposal's status", () => {
    expect(resolveLandedDecision(null)).toBe("applied");
    expect(resolveLandedDecision(undefined)).toBe("applied");
    expect(resolveLandedDecision("approved")).toBe("approved");
    expect(resolveLandedDecision("auto_approved")).toBe("auto_approved");
    expect(resolveLandedDecision("pending")).toBe("pending");
    expect(resolveLandedDecision("reverted")).toBe("reverted");
    // Not a decision about an existing object — the object exists, so applied.
    expect(resolveLandedDecision("rejected")).toBe("applied");
  });

  it("pending is To review — never landed; only auto-approved offers undo", () => {
    for (const s of LANDED_DECISION_STATES) {
      const v = resolveLandedDecisionView(s);
      expect(v.landed).toBe(s !== "pending");
      expect(v.undoable).toBe(s === "auto_approved");
    }
  });

  it("every state is a tone + glyph + a status token the vocabulary names", () => {
    for (const s of LANDED_DECISION_STATES) {
      const v = resolveLandedDecisionView(s);
      expect(v.tone).toMatch(/^[a-zA-Z]+$/); // a token NAME, never a colour
      expect(v.tone).not.toMatch(/^#|rgb/);
      expect(Object.prototype.hasOwnProperty.call(STATUS_LABELS, v.statusToken)).toBe(true);
    }
  });

  it("approved (a person decided) and auto-approved (a rule decided) are distinguishable marks", () => {
    const a = resolveLandedDecisionView("approved");
    const b = resolveLandedDecisionView("auto_approved");
    expect([a.tone, a.glyph]).not.toEqual([b.tone, b.glyph]);
  });
});

describe("actor filter", () => {
  const agent: LandedActor = { kind: "agent", id: "a1", name: "Claude Code" };
  const me: LandedActor = { kind: "human", id: "u1", name: "Ada", isViewer: true };
  const peer: LandedActor = { kind: "human", id: "u2", name: "Bo", isViewer: false };
  it("agents / me / all", () => {
    expect([agent, me, peer].filter((a) => matchesLandedActor(a, "agents"))).toEqual([agent]);
    expect([agent, me, peer].filter((a) => matchesLandedActor(a, "me"))).toEqual([me]);
    expect([agent, me, peer].filter((a) => matchesLandedActor(a, "all"))).toHaveLength(3);
  });
});

describe("summarizeSessionOutputs", () => {
  const lead = { slug: "lead", displayName: "Lead", icon: null };
  it("counts entities by profile, others by kind; top = newest", () => {
    const s = summarizeSessionOutputs([
      { kind: "entity", refId: "e1", title: "Ada", producedAt: "2026-09-28T09:00:00Z", entityProfile: lead },
      { kind: "entity", refId: "e2", title: "Bo", producedAt: "2026-09-28T09:05:00Z", entityProfile: lead },
      { kind: "document", refId: "d1", title: "Brief", producedAt: "2026-09-28T09:10:00Z" },
    ]);
    expect(s.count).toBe(3);
    expect(s.byKind).toEqual([
      { key: "lead", kind: "entity", entityProfile: lead, count: 2 },
      { key: "document", kind: "document", count: 1 },
    ]);
    expect(s.top).toEqual({ kind: "document", title: "Brief", ref: { kind: "document", id: "d1" } });
  });
  it("nothing produced is count 0 with no top — never estimated", () => {
    expect(summarizeSessionOutputs([])).toEqual({ count: 0, byKind: [], top: null });
  });
});
