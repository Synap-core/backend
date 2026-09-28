import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FILTER_PRESETS,
  ACTIVITY_OUTCOMES,
  activityAgentFilter,
  activityFilterForPreset,
  activityOutcomeForProposal,
  activityOutcomeForRun,
  activityOutcomeForSession,
  matchesActivityActor,
  parseActivityActorFilter,
  resolveActivityOutcomeView,
  resolveActivityVerb,
  selectAgentsToday,
  startOfActivityDay,
  type ActivityActor,
  type ActivityRow,
} from "./index.js";
import { resolveStatusLabel } from "../vocabulary/index.js";

function row(
  id: string,
  occurredAt: string,
  actor: ActivityActor,
  over: Partial<ActivityRow> = {}
): ActivityRow {
  return {
    id,
    source: "proposal",
    occurredAt,
    actor,
    action: "create",
    verb: "Created",
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

const cc: ActivityActor = { kind: "agent", id: "agent-cc", name: "Claude Code" };
const codex: ActivityActor = { kind: "agent", id: "agent-codex", name: "Codex" };
const me: ActivityActor = { kind: "human", id: "u1", name: "Me", isViewer: true };
const peer: ActivityActor = { kind: "human", id: "u2", name: "Peer", isViewer: false };
const rule: ActivityActor = { kind: "system", id: "auto-1", name: "Enrich" };

describe("outcome view — a mark, never a colour", () => {
  it("every outcome has a tone token, a glyph and a humanized status label", () => {
    for (const o of ACTIVITY_OUTCOMES) {
      const v = resolveActivityOutcomeView(o);
      expect(v.outcome).toBe(o);
      expect(v.tone).toMatch(/^[a-zA-Z]+$/);
      expect(v.tone.startsWith("#")).toBe(false);
      expect(v.glyph.length).toBeGreaterThan(0);
      expect(resolveStatusLabel(v.statusToken)).not.toBe(o);
    }
  });
  it("failed and succeeded never share a mark", () => {
    const f = resolveActivityOutcomeView("failed");
    const s = resolveActivityOutcomeView("succeeded");
    expect([f.tone, f.glyph]).not.toEqual([s.tone, s.glyph]);
    expect(f.tone).toBe("error");
  });
});

describe("outcome mappers", () => {
  it("proposal statuses", () => {
    expect(activityOutcomeForProposal("auto_approved")).toBe("succeeded");
    expect(activityOutcomeForProposal("approved")).toBe("succeeded");
    expect(activityOutcomeForProposal("pending")).toBe("proposed");
    expect(activityOutcomeForProposal("rejected")).toBe("rejected");
    expect(activityOutcomeForProposal("reverted")).toBe("reverted");
    expect(activityOutcomeForProposal("approval_failed")).toBe("failed");
    expect(activityOutcomeForProposal("withdrawn")).toBe("stopped");
  });
  it("run statuses — waiting_on_you is waiting, not failed", () => {
    expect(activityOutcomeForRun("failed")).toBe("failed");
    expect(activityOutcomeForRun("completed")).toBe("succeeded");
    expect(activityOutcomeForRun("waiting_on_you")).toBe("waiting");
    expect(activityOutcomeForRun("blocked_by_policy")).toBe("stopped");
  });
  it("session statuses", () => {
    expect(activityOutcomeForSession("active")).toBe("running");
    expect(activityOutcomeForSession("closed")).toBe("succeeded");
    expect(activityOutcomeForSession("failed")).toBe("failed");
    expect(activityOutcomeForSession("stale")).toBe("stopped");
  });
});

describe("verb — past mood through the vocabulary", () => {
  it("reads past, including the session start verb", () => {
    expect(resolveActivityVerb("create")).toBe("Created");
    expect(resolveActivityVerb("approve")).toBe("Approved");
    expect(resolveActivityVerb("start")).toBe("Started");
    expect(resolveActivityVerb("run")).toBe("Ran");
  });
});

describe("actor filter", () => {
  it("parses the four shapes and rejects junk", () => {
    expect(parseActivityActorFilter(undefined)).toEqual({ kind: "all" });
    expect(parseActivityActorFilter("agents")).toEqual({ kind: "agents" });
    expect(parseActivityActorFilter(activityAgentFilter("x"))).toEqual({
      kind: "agent",
      agentUserId: "x",
    });
    expect(parseActivityActorFilter("agent:")).toBeNull();
    expect(parseActivityActorFilter("person:x")).toBeNull();
  });
  it("agents excludes humans AND rules; me is only the viewer", () => {
    expect(matchesActivityActor(cc, "agents")).toBe(true);
    expect(matchesActivityActor(me, "agents")).toBe(false);
    expect(matchesActivityActor(rule, "agents")).toBe(false);
    expect(matchesActivityActor(me, "me")).toBe(true);
    expect(matchesActivityActor(peer, "me")).toBe(false);
    expect(matchesActivityActor(cc, activityAgentFilter("agent-cc"))).toBe(true);
    expect(matchesActivityActor(codex, activityAgentFilter("agent-cc"))).toBe(false);
  });
});

describe("filter presets", () => {
  it("every preset maps to a door input", () => {
    for (const p of ACTIVITY_FILTER_PRESETS) {
      expect(activityFilterForPreset(p)).toBeTypeOf("object");
    }
    expect(activityFilterForPreset("decided")).toEqual({ source: "decision" });
    expect(activityFilterForPreset("failed")).toEqual({ outcome: "failed" });
  });
});

describe("selectAgentsToday — THE Home selection", () => {
  const since = "2026-09-28T00:00:00.000Z";
  const items = [
    row("a", "2026-09-28T09:00:00.000Z", cc),
    row("b", "2026-09-28T11:00:00.000Z", codex),
    row("c", "2026-09-28T12:00:00.000Z", cc),
    row("d", "2026-09-28T13:00:00.000Z", me),
    row("e", "2026-09-27T23:00:00.000Z", cc),
    row("f", "2026-09-28T10:00:00.000Z", { kind: "agent", id: null, name: "Codex" }),
  ];

  it("counts per agent, newest act, most recent agent first; humans and pre-since rows ignored", () => {
    const sel = selectAgentsToday({ items, nextCursor: null }, { since });
    expect(sel.agents.map((a) => [a.agent.id, a.count, a.lastAct.id])).toEqual([
      ["agent-cc", 2, "c"],
      ["agent-codex", 1, "b"],
      // An unnamed-id agent is never merged into the named one.
      [null, 1, "f"],
    ]);
    expect(sel.truncated).toBe(false);
  });

  it("a page with more to read says the counts are lower bounds", () => {
    expect(selectAgentsToday({ items, nextCursor: "x" }).truncated).toBe(true);
  });

  it("caps and reports the rest", () => {
    const sel = selectAgentsToday({ items, nextCursor: null }, { since, limit: 1 });
    expect(sel.agents).toHaveLength(1);
    expect(sel.hiddenAgents).toBe(2);
  });

  it("an unreadable since throws — never a calm empty list", () => {
    expect(() =>
      selectAgentsToday({ items, nextCursor: null }, { since: "nope" })
    ).toThrow(RangeError);
  });

  it("startOfActivityDay is a local midnight at or before now", () => {
    const now = new Date("2026-09-28T15:30:00.000Z");
    const start = new Date(startOfActivityDay(now));
    expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime() - start.getTime()).toBeLessThan(24 * 3600 * 1000);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
  });
});
