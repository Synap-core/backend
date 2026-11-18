/**
 * The session room model (`./index.ts`). Each rule has a case that goes red
 * when that rule is removed (negative controls run on the devbox: each line
 * reverted in turn, see the PR).
 */
import { describe, expect, it } from "vitest";
import {
  agentLineOf,
  deliveryOf,
  isOpenQuestion,
  roomQuestions,
  roomTimeline,
  ROOM_RUNNER_LIVE_MS,
  type AgentLine,
  type RoomMessageLike,
  type RoomSlot,
} from "./index.js";

const open = (over: Partial<RoomSlot> = {}): RoomSlot => ({
  label: "Disposition Esteban Arias",
  owner: "human",
  status: "pending",
  owedSince: "2026-11-17T14:10:00.000Z",
  ...over,
});

describe("isOpenQuestion", () => {
  it("an owed, unanswered human slot is open", () => {
    expect(isOpenQuestion(open())).toBe(true);
  });
  it("each closing fact closes it", () => {
    expect(isOpenQuestion(open({ owner: undefined }))).toBe(false);
    expect(isOpenQuestion(open({ owner: "agent" }))).toBe(false);
    expect(isOpenQuestion(open({ status: "done" }))).toBe(false);
    expect(isOpenQuestion(open({ retiredAt: "2026-11-18T00:00:00Z" }))).toBe(
      false
    );
    expect(isOpenQuestion(open({ required: false }))).toBe(false);
    expect(isOpenQuestion(open({ optional: true }))).toBe(false);
    expect(isOpenQuestion(open({ label: "   " }))).toBe(false);
    expect(
      isOpenQuestion(
        open({ answer: { text: "Nurturing", answeredAt: "2026-11-18T11:26Z" } })
      )
    ).toBe(false);
  });
  it("an answer with no answeredAt (a relay waiting for the tap) leaves it open", () => {
    expect(isOpenQuestion(open({ answer: { text: "x" } }))).toBe(true);
  });
});

describe("roomQuestions", () => {
  it("open and answered, in slot order; retired, optional, agent work and unanswered agent slots left out", () => {
    const answered: RoomSlot = {
      label: "Keep the run going",
      status: "pending",
      answer: { text: "Yes", answeredAt: "2026-11-18T11:25:50Z" },
    };
    const slots: RoomSlot[] = [
      { label: "Conversations lues" },
      answered,
      open(),
      open({ label: "Retired", retiredAt: "2026-11-18T00:00:00Z" }),
      open({ label: "Optional", optional: true }),
      {
        label: "Optional answered",
        required: false,
        answer: { answeredAt: "2026-11-18T11:00Z" },
      },
    ];
    expect(roomQuestions(slots)).toEqual([
      { slot: answered, state: "answered" },
      { slot: slots[2], state: "open" },
    ]);
  });
});

const msg = (
  id: string,
  createdAt: string,
  over: Partial<RoomMessageLike> = {}
): RoomMessageLike => ({ id, createdAt, authorIsPerson: false, ...over });

describe("roomTimeline", () => {
  it("a question with its room question message is drawn AT that message, replacing it", () => {
    const slot = open({ owedSince: "2026-11-17T14:00:00Z" });
    const m1 = msg("m1", "2026-11-17T14:05:00Z");
    const q = msg("q", "2026-11-17T14:12:00Z", {
      roomPost: { kind: "question", slotLabel: slot.label },
    });
    const m2 = msg("m2", "2026-11-17T14:20:00Z", { authorIsPerson: true });
    const items = roomTimeline([m1, q, m2], [slot]);
    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "question",
      "message",
    ]);
    expect(items[1]).toEqual({
      kind: "question",
      at: q.createdAt,
      slot,
      state: "open",
      anchorMessageId: "q",
    });
  });

  it("an update post about the slot, or a question about another slot, does not anchor it", () => {
    const slot = open({ owedSince: "2026-11-17T14:30:00Z" });
    const upd = msg("u", "2026-11-17T14:12:00Z", {
      roomPost: { kind: "update", slotLabel: slot.label },
    });
    const other = msg("o", "2026-11-17T14:13:00Z", {
      roomPost: { kind: "question", slotLabel: "Another" },
    });
    const items = roomTimeline([upd, other], [slot]);
    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "message",
      "question",
    ]);
    expect(items[2]).toMatchObject({
      anchorMessageId: null,
      at: slot.owedSince,
    });
  });

  it("asked twice: the NEWEST question message anchors it, the older stays a message", () => {
    const slot = open();
    const q1 = msg("q1", "2026-11-17T14:00:00Z", {
      roomPost: { kind: "question", slotLabel: slot.label },
    });
    const q2 = msg("q2", "2026-11-17T15:00:00Z", {
      roomPost: { kind: "question", slotLabel: slot.label },
    });
    const items = roomTimeline([q1, q2], [slot]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "message" });
    expect(items[1]).toMatchObject({ kind: "question", anchorMessageId: "q2" });
  });

  it("no question message: at owedSince, between the messages around it", () => {
    const slot = open({ owedSince: "2026-11-17T14:10:00Z" });
    const items = roomTimeline(
      [msg("a", "2026-11-17T14:05:00Z"), msg("b", "2026-11-17T14:15:00Z")],
      [slot]
    );
    expect(
      items.map((i) => (i.kind === "message" ? i.message.id : "Q"))
    ).toEqual(["a", "Q", "b"]);
  });

  it("no owedSince: after every message, even one later than the input order says", () => {
    const slot = open({ owedSince: null });
    const items = roomTimeline(
      [
        msg("late", "2026-11-18T09:00:00Z"),
        msg("early", "2026-11-17T09:00:00Z"),
      ],
      [slot]
    );
    expect(
      items.map((i) => (i.kind === "message" ? i.message.id : "Q"))
    ).toEqual(["early", "late", "Q"]);
    expect(items[2]!.at).toBe("2026-11-18T09:00:00Z");
  });

  it("equal times: a question before a message; equal messages keep input order", () => {
    const at = "2026-11-17T14:10:00.000Z";
    const slot = open({ owedSince: at });
    const items = roomTimeline([msg("x", at), msg("y", at)], [slot]);
    expect(
      items.map((i) => (i.kind === "message" ? i.message.id : "Q"))
    ).toEqual(["Q", "x", "y"]);
  });

  it("an answered question is drawn too, folded by its state", () => {
    const slot = open({
      owner: undefined,
      owedSince: null,
      answer: { text: "Disqualified", answeredAt: "2026-11-18T11:25:43Z" },
    });
    const [item] = roomTimeline([], [slot]);
    expect(item).toMatchObject({ kind: "question", state: "answered", at: "" });
  });
});

const NOW = new Date("2026-11-18T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const agent = (over: Record<string, unknown> = {}) => ({
  agentUserId: "a1",
  name: "Claude Code",
  displayName: "Claude Code on MacBook",
  agentType: "claude-code",
  computer: { agentUserId: "m1", name: "MacBook", source: "host" },
  reach: "pull",
  servedAt: null,
  nobodyRuns: null,
  ...over,
});
const holder = (over: Record<string, unknown> = {}) => ({
  status: "ok",
  holder: {
    kind: "agent",
    waitKind: "agent_stopped",
    since: ago(60_000),
    agent: agent(),
    runner: null,
    source: { from: "roster" },
    ...over,
  },
});
const runner = (over: Record<string, unknown> = {}) => ({
  harness: "claude-code",
  agentUserId: "a1",
  state: "idle",
  stateSince: ago(30_000),
  lastSeenAt: ago(10_000),
  live: true,
  firstSeenAt: ago(3_600_000),
  ...over,
});
const items = (...r: unknown[]) => ({
  status: "ok",
  total: r.length,
  items: r,
});

describe("agentLineOf", () => {
  it("an unreadable holder is 'unknown', never 'nobody'", () => {
    expect(agentLineOf(undefined, null, NOW)).toEqual({ state: "unknown" });
    expect(
      agentLineOf({ status: "unavailable", reason: "x" }, items(), NOW)
    ).toEqual({ state: "unknown" });
    expect(agentLineOf({ status: "withheld" }, items(), NOW)).toEqual({
      state: "unknown",
    });
  });

  it("the holder says nobody, or names no agent → nobody", () => {
    const nobody = { state: "nobody", name: null, computer: null };
    expect(
      agentLineOf(holder({ kind: "nobody", agent: null }), items(), NOW)
    ).toEqual(nobody);
    expect(agentLineOf(holder({ agent: null }), items(), NOW)).toEqual(nobody);
  });

  it("a bare SessionHolder (no section) reads the same", () => {
    expect(agentLineOf(holder().holder, items(runner()), NOW)).toMatchObject({
      state: "reachable",
    });
  });

  it("the holder's agent_work → working (a pod agent mid-turn)", () => {
    expect(
      agentLineOf(
        holder({ waitKind: "agent_work", agent: agent({ reach: "pod" }) }),
        items(),
        NOW
      )
    ).toEqual({
      state: "working",
      name: "Claude Code",
      computer: "MacBook",
      since: ago(60_000),
    });
  });

  it("a live busy runner → working, since its state", () => {
    expect(
      agentLineOf(holder(), items(runner({ state: "busy" })), NOW)
    ).toMatchObject({ state: "working", since: ago(30_000) });
  });

  it("a live idle runner → reachable; past 150 s it no longer counts live", () => {
    expect(agentLineOf(holder(), items(runner()), NOW)).toEqual({
      state: "reachable",
      name: "Claude Code",
      computer: "MacBook",
      lastSeenAt: ago(10_000),
    });
    const stale = runner({ lastSeenAt: ago(ROOM_RUNNER_LIVE_MS + 1_000) });
    expect(agentLineOf(holder(), items(stale), NOW)).toEqual({
      state: "unreachable",
      name: "Claude Code",
      computer: "MacBook",
      lastSeenAt: ago(ROOM_RUNNER_LIVE_MS + 1_000),
    });
  });

  it("an ENDED runner is not live, even seen a second ago", () => {
    expect(
      agentLineOf(holder(), items(runner({ state: "ended" })), NOW)
    ).toMatchObject({ state: "unreachable" });
  });

  it("another agent's live runner does not make this one reachable", () => {
    expect(
      agentLineOf(holder(), items(runner({ agentUserId: "other" })), NOW)
    ).toMatchObject({ state: "unreachable" });
  });

  it("the holder's own runner counts when the runners list is withheld", () => {
    expect(
      agentLineOf(holder({ runner: runner() }), { status: "withheld" }, NOW)
    ).toMatchObject({ state: "reachable" });
  });

  it("a pod-run or dispatched agent with no runner is reachable (the pod wakes it)", () => {
    for (const reach of ["pod", "dispatch"]) {
      expect(
        agentLineOf(holder({ agent: agent({ reach }) }), items(), NOW)
      ).toMatchObject({ state: "reachable" });
    }
    expect(
      agentLineOf(
        holder({ agent: agent({ reach: "dispatch", nobodyRuns: true }) }),
        items(),
        NOW
      )
    ).toMatchObject({ state: "unreachable" });
  });

  it("a pull agent nothing runs → unreachable, last seen = its newest sighting", () => {
    expect(
      agentLineOf(
        holder({ agent: agent({ servedAt: ago(900_000) }) }),
        items(runner({ lastSeenAt: ago(600_000) })),
        NOW
      )
    ).toEqual({
      state: "unreachable",
      name: "Claude Code",
      computer: "MacBook",
      lastSeenAt: ago(600_000),
    });
  });

  it("names: name, else displayName, else agentType; no computer → null", () => {
    expect(
      agentLineOf(
        holder({
          agent: agent({ name: null, computer: null, reach: "pod" }),
        }),
        items(),
        NOW
      )
    ).toMatchObject({ name: "Claude Code on MacBook", computer: null });
  });
});

describe("deliveryOf", () => {
  const person = msg("p", "2026-11-18T11:00:00Z", { authorIsPerson: true });
  const reachable: AgentLine = {
    state: "reachable",
    name: "x",
    computer: null,
    lastSeenAt: null,
  };
  it("not a person's message → null", () => {
    expect(deliveryOf(msg("a", "2026-11-18T11:00:00Z"), reachable)).toBeNull();
  });
  it("seen by the agent → seen, whoever works it now", () => {
    const seen = { ...person, seenByAgentAt: "2026-11-18T11:01:00Z" };
    expect(
      deliveryOf(seen, { state: "nobody", name: null, computer: null })
    ).toBe("seen");
  });
  it("nobody / unreachable → waiting; reachable, working, unknown → sent", () => {
    expect(
      deliveryOf(person, { state: "nobody", name: null, computer: null })
    ).toBe("waiting");
    expect(
      deliveryOf(person, {
        state: "unreachable",
        name: "x",
        computer: null,
        lastSeenAt: null,
      })
    ).toBe("waiting");
    expect(deliveryOf(person, reachable)).toBe("sent");
    expect(
      deliveryOf(person, {
        state: "working",
        name: "x",
        computer: null,
        since: null,
      })
    ).toBe("sent");
    expect(deliveryOf(person, { state: "unknown" })).toBe("sent");
  });
});
