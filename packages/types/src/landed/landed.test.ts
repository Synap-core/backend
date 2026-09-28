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
  resolveOutputsResultLine,
  summarizeSessionOutputs,
  PROPOSAL_SUBJECT_KINDS,
  type SessionOutputsSummary,
  type LandedActor,
} from "./index.js";
import { STATUS_LABELS, resolveStatusLabel } from "../vocabulary/index.js";
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

  it("failed wears the failure tone; closed reads done; cancelled is a neutral STOPPED mark, never a check", () => {
    expect(resolveLandedSessionState("failed")).toMatchObject({ state: "failed", tone: "error", statusToken: "failed" });
    expect(resolveLandedSessionState("closed")).toMatchObject({ state: "done", glyph: "check", statusToken: "closed" });
    const cancelled = resolveLandedSessionState("cancelled");
    expect(cancelled).toMatchObject({ tone: "textMuted", glyph: "pause", statusToken: "cancelled" });
    // A check says "it finished" — a cancelled session did not.
    expect(cancelled.glyph).not.toBe("check");
    expect(cancelled.state).not.toBe("done");
    expect(resolveStatusLabel(cancelled.statusToken)).toBe("Cancelled");
  });

  it("every landed status has a mark distinct from the others and a vocabulary label", () => {
    const marks = LANDED_SESSION_STATUSES.map((s) => {
      const v = resolveLandedSessionState(s);
      expect(Object.prototype.hasOwnProperty.call(STATUS_LABELS, v.statusToken) || v.statusToken === "closed").toBe(true);
      return `${v.tone}/${v.glyph}`;
    });
    expect(new Set(marks).size).toBe(LANDED_SESSION_STATUSES.length);
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

  it("a creating proposal the viewer cannot see is UNKNOWN — never applied by default", () => {
    expect(resolveLandedDecision("approved", { visible: false })).toBe("unknown");
    expect(resolveLandedDecision(null, { visible: false })).toBe("unknown");
    const v = resolveLandedDecisionView("unknown");
    expect(v).toMatchObject({ tone: "textSecondary", glyph: "question", undoable: false });
    expect(resolveStatusLabel(v.statusToken)).toBe("Unknown");
    // No decider-flavoured mark: not a check, not a person.
    expect(["check", "person"]).not.toContain(v.glyph);
  });

  it("every decision state wears a DISTINCT glyph (tone alone never carries the difference)", () => {
    const glyphs = LANDED_DECISION_STATES.map((s) => resolveLandedDecisionView(s).glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
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
  const lead = { slug: "lead", displayName: "Lead", plural: "Leads", icon: null };
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

describe("resolveOutputsResultLine — THE result line", () => {
  const lead = { slug: "lead", displayName: "Lead", plural: "Leads", icon: null };
  const blog = { slug: "blog_post", displayName: "Blog post", plural: "Blog entries", icon: null };
  const noPlural = { slug: "recipe_card", displayName: "Recipe card", plural: null, icon: null };
  const sum = (byKind: SessionOutputsSummary["byKind"]): SessionOutputsSummary => ({
    count: byKind.reduce((n, g) => n + g.count, 0),
    byKind,
    top: null,
  });

  it("nothing produced → null", () => {
    expect(resolveOutputsResultLine(null)).toBeNull();
    expect(resolveOutputsResultLine(sum([]))).toBeNull();
  });
  it("one kind, singular and plural", () => {
    expect(resolveOutputsResultLine(sum([{ key: "lead", kind: "entity", entityProfile: lead, count: 12 }]))).toBe("12 leads");
    expect(resolveOutputsResultLine(sum([{ key: "document", kind: "document", count: 1 }]))).toBe("1 document");
  });
  it("two kinds", () => {
    expect(
      resolveOutputsResultLine(sum([
        { key: "lead", kind: "entity", entityProfile: lead, count: 12 },
        { key: "document", kind: "document", count: 1 },
      ]))
    ).toBe("12 leads · 1 document");
  });
  it("three+ kinds: two named, then +N more counting OBJECTS", () => {
    expect(
      resolveOutputsResultLine(sum([
        { key: "lead", kind: "entity", entityProfile: lead, count: 12 },
        { key: "document", kind: "document", count: 2 },
        { key: "view", kind: "view", count: 2 },
        { key: "person", kind: "entity", count: 1 },
      ]))
    ).toBe("12 leads · 2 documents · +3 more");
  });
  it("a custom profile speaks its OWN plural, not a pluralised slug", () => {
    expect(resolveOutputsResultLine(sum([{ key: "blog_post", kind: "entity", entityProfile: blog, count: 3 }]))).toBe("3 blog entries");
    expect(resolveOutputsResultLine(sum([{ key: "blog_post", kind: "entity", entityProfile: blog, count: 1 }]))).toBe("1 blog post");
  });
  it("a null plural falls back to the vocabulary plural of the key (curated: person → people)", () => {
    expect(resolveOutputsResultLine(sum([{ key: "recipe_card", kind: "entity", entityProfile: noPlural, count: 2 }]))).toBe("2 recipe cards");
    expect(resolveOutputsResultLine(sum([{ key: "person", kind: "entity", entityProfile: { slug: "person", displayName: "Person", plural: null, icon: null }, count: 3 }]))).toBe("3 people");
  });
});

describe("PROPOSAL_SUBJECT_KINDS", () => {
  it("is the entity + document pair the pod's subject filter accepts", () => {
    expect([...PROPOSAL_SUBJECT_KINDS]).toEqual(["entity", "document"]);
  });
});
