/**
 * What a key narrowed by its grant is answered by `GET /status-of`: an
 * ALLOW-LIST of answer keys (pinned here: a field added to `StatusOf` later is
 * withheld until listed) and of history events (no wait episode: its ref,
 * `on` and `reason` name objects read with no grant clause; no role's event;
 * no actor, hold, cause or reason).
 */
import { describe, it, expect } from "vitest";
import {
  narrowStatusOfAnswer,
  STATUS_OF_NARROWED_ANSWER_KEYS,
} from "../status-of-narrowed.js";
import {
  narrowStatusOfWork,
  narrowWorkItem,
  STATUS_OF_NARROWED_WORK_ITEM_KEYS,
} from "../status-of-narrowed-work.js";

const FOREIGN = {
  kind: "proposal",
  id: "foreign-proposal-id",
  url: "https://pod/open/foreign",
  label: "Foreign proposal title",
};
const FULL = {
  id: "e1",
  type: "entity",
  name: "A piece",
  status: "draft",
  label: "Draft",
  category: "open",
  tone: "neutral",
  since: "2026-11-01T00:00:00.000Z",
  sinceMeasured: true,
  stuck: { afterDays: 3, forDays: 4 },
  live: { status: "ok", state: "idle", lastActivityAt: null },
  moves: [],
  link: "l",
  waitingOn: [FOREIGN],
  blocker: { x: 1 },
  nextMove: { x: 1 },
  hold: { ref: FOREIGN },
  roles: [{ facetId: "f" }],
  account: { name: "Acme" },
  work: { items: [], truncated: false },
  somethingAddedLater: "secret",
  history: {
    truncated: false,
    events: [
      {
        id: "a",
        kind: "wait_episode",
        at: "t",
        on: "person",
        reason: "waits for Bob",
        ref: FOREIGN,
        facetId: null,
      },
      {
        id: "b",
        kind: "wait_episode",
        at: "t",
        ref: FOREIGN,
        facetId: "f",
      },
      {
        id: "c",
        kind: "status_moved",
        at: "t",
        from: "draft",
        to: "review",
        category: "active",
        reason: "Bob said so",
        hold: { ref: FOREIGN },
        cause: { id: "x" },
        actor: { name: "Bob" },
      },
      { id: "d", kind: "status_moved", at: "t", to: "x", role: "client" },
      {
        id: "e",
        kind: "stage_entered",
        at: "t",
        stageKey: "build",
        fromStage: "shape",
        via: "advance",
        actor: { name: "Bob" },
        refs: { sessionId: "s" },
      },
      { id: "f", kind: "paused", at: "t" },
    ],
  },
};

describe("narrowStatusOfAnswer", () => {
  const out = narrowStatusOfAnswer(FULL as never) as unknown as Record<
    string,
    unknown
  >;

  it("keeps exactly the listed keys, so a field added later is withheld", () => {
    expect(Object.keys(out).sort()).toEqual(
      [...STATUS_OF_NARROWED_ANSWER_KEYS].sort()
    );
    expect(out).not.toHaveProperty("somethingAddedLater");
    expect(STATUS_OF_NARROWED_ANSWER_KEYS).toEqual([
      "id",
      "type",
      "name",
      "status",
      "label",
      "category",
      "tone",
      "since",
      "sinceMeasured",
      "stuck",
      "live",
      "moves",
      "history",
      "work",
      "link",
    ]);
  });

  it("history carries no wait episode, role event, actor, hold, cause or reason", () => {
    const events = (out.history as { events: Array<Record<string, unknown>> })
      .events;
    expect(events.map((e) => e.id)).toEqual(["c", "e"]);
    expect(events[0]).toEqual({
      id: "c",
      kind: "status_moved",
      at: "t",
      from: "draft",
      to: "review",
      category: "active",
    });
    expect(events[1]).toEqual({
      id: "e",
      kind: "stage_entered",
      at: "t",
      stageKey: "build",
      fromStage: "shape",
      via: "advance",
    });
    // Nothing of the foreign object survives anywhere in the answer.
    const wire = JSON.stringify(out);
    for (const leak of [
      "foreign-proposal-id",
      "Foreign proposal",
      "Bob",
      "Acme",
    ])
      expect(wire).not.toContain(leak);
  });

  it("an unknown id and an unavailable history pass through as they are", () => {
    expect(narrowStatusOfAnswer({ id: "g", type: "unknown" })).toEqual({
      id: "g",
      type: "unknown",
    });
    expect(
      (
        narrowStatusOfAnswer({
          id: "e",
          type: "entity",
          history: { status: "unavailable" },
        } as never) as unknown as { history: unknown }
      ).history
    ).toEqual({ status: "unavailable" });
  });
});

// ── `work` for a narrowed key (D7) ────────────────────────────────────────

const STAGES = {
  status: "ok",
  current: "draft",
  items: [
    {
      key: "draft",
      name: "Draft",
      position: "current",
      entry: {
        status: "running",
        attempt: 1,
        startedAt: "t0",
        endedAt: null,
        agentName: "Scribe",
        childSessionId: "foreign-child-session",
      },
    },
    { key: "publish", name: "Publish", position: "left", entry: null },
  ],
};

/** A full work item as `workItemOf` shapes it, stuffed with foreign references. */
const ITEM = {
  sessionId: "s1",
  name: "Make video 12",
  kind: "work",
  status: "active",
  label: "Active",
  category: "active",
  tone: "active",
  on: "subject",
  playbookId: "pb1",
  roomId: "room1",
  run: {
    id: "run1",
    status: "running",
    label: "Running",
    category: "active",
    stopReason: "budget at foreign-session-9",
    error: "failed reading foreign-entity-7",
    startedAt: "t0",
    completedAt: null,
  },
  stages: STAGES,
  gates: {
    status: "ok",
    items: [
      {
        stageKey: "draft",
        stageName: "Foreign gate name",
        kind: "human",
        state: "pending",
        proposalId: "p-own",
        decidedByHuman: false,
        fromStage: "stage-of-another-space",
        summary: "Approve stage: Draft for Video 12",
        commitSha: "deadbeef",
        canReview: true,
      },
      {
        stageKey: "publish",
        stageName: "Publish",
        kind: "human",
        state: "approved",
        proposalId: "p-foreign",
        decidedByHuman: true,
        decidedAt: "t1",
        summary: "Foreign summary",
        canReview: true,
      },
      {
        stageKey: "stage-of-another-space",
        stageName: "Not declared",
        kind: "human",
        state: "pending",
        proposalId: "p-own",
        decidedByHuman: false,
        canReview: true,
      },
      {
        stageKey: "draft",
        stageName: "Draft",
        kind: "human",
        state: "pending",
        decidedByHuman: false,
        canReview: true,
      },
    ],
  },
  asks: {
    status: "ok",
    total: 1,
    items: [
      {
        label: "Pick a title",
        kind: "decision",
        noun: "Decision",
        prompt: "Which title?",
        askMode: "choose",
        why: "because of foreign-why",
        blockedReason: "foreign-blocked",
        criterionKey: "c1",
        owedSince: "t0",
      },
    ],
  },
  proposals: {
    status: "ok",
    total: 1,
    items: [{ id: "p-foreign", title: "Foreign title", proposalType: "x" }],
  },
  outcomes: {
    status: "ok",
    counts: { met: 0, total: 1 },
    items: [
      {
        key: "script",
        label: "A script",
        kind: "document",
        owner: "agent",
        met: false,
        retired: false,
        state: "open",
        ref: { kind: "entity", id: "foreign-entity-7" },
        criteria: [
          {
            key: "c1",
            label: "Has a hook",
            met: false,
            state: "open",
            outputKey: "script",
            evidence: "foreign-evidence",
          },
        ],
      },
    ],
  },
  hold: {
    on: "person",
    ref: "person:foreign-person",
    reason: "waits for Bob",
    until: { moves: "pr:foreign/repo#1" },
    resumeTo: "active",
    since: "t0",
  },
  holder: {
    kind: "agent",
    waitKind: null,
    since: "t0",
    agentName: "Scribe",
  },
  live: { status: "ok", state: "working", lastActivityAt: "t0" },
  stopped: {
    at: { key: "draft", name: "Draft", extra: "foreign" },
    left: [{ key: "publish", name: "Publish" }],
    label: "Stopped at Draft",
  },
  nextMove: { kind: "owed_slot", label: "Foreign", proposalId: "p-foreign" },
  lastCompletion: { closedAt: "t", summary: "Foreign summary" },
  continue: {
    at: { key: "draft", name: "Draft" },
    left: [{ key: "publish", name: "Publish" }],
    label: "Continue at Draft",
    canAct: true,
    extra: "foreign",
  },
  somethingAddedLater: "secret",
  link: "l",
};

const NONE = { readableProposalIds: new Set<string>(), holderReadable: false };
const wireOf = (v: unknown) => JSON.stringify(v);
const FOREIGN_WORDS = [
  "foreign",
  "Foreign",
  "p-foreign",
  "Bob",
  "deadbeef",
  "secret",
  "Scribe",
  "stage-of-another-space",
];

describe("narrowStatusOfWork (a key narrowed by its grant)", () => {
  it("pins the exact set of item keys: a field added later is withheld", () => {
    const item = narrowWorkItem(ITEM, NONE);
    expect(Object.keys(item).sort()).toEqual(
      [...STATUS_OF_NARROWED_WORK_ITEM_KEYS].sort()
    );
    expect(STATUS_OF_NARROWED_WORK_ITEM_KEYS).toEqual([
      "sessionId",
      "name",
      "kind",
      "status",
      "label",
      "category",
      "tone",
      "on",
      "playbookId",
      "roomId",
      "run",
      "stages",
      "gates",
      "asks",
      "proposals",
      "outcomes",
      "hold",
      "holder",
      "live",
      "stopped",
      "continue",
      "link",
    ]);
    for (const dropped of ["nextMove", "lastCompletion", "somethingAddedLater"])
      expect(item).not.toHaveProperty(dropped);
  });

  it("with no proposal readable and no agent grant, nothing foreign survives anywhere", () => {
    const wire = wireOf(narrowStatusOfWork({ items: [ITEM], truncated: true }, NONE));
    for (const w of FOREIGN_WORDS) expect(wire).not.toContain(w);
    // The own plain facts are still there.
    for (const kept of ["Make video 12", "Draft", "Pick a title", "Has a hook"])
      expect(wire).toContain(kept);
  });

  it("with no context at all, it fails closed the same way", () => {
    const wire = wireOf(narrowStatusOfWork({ items: [ITEM], truncated: false }));
    for (const w of FOREIGN_WORDS) expect(wire).not.toContain(w);
  });

  it("a gate keeps its proposal only when the proposal floor reads it, named from the declared stages", () => {
    const item = narrowWorkItem(ITEM, {
      readableProposalIds: new Set(["p-own"]),
      holderReadable: false,
    }) as { gates: { items: Array<Record<string, unknown>> } };
    expect(item.gates.items).toEqual([
      {
        stageKey: "draft",
        stageName: "Draft", // the session's own, never the gate's
        kind: "human",
        state: "pending",
        proposalId: "p-own",
        decidedByHuman: false,
        summary: "Approve stage: Draft for Video 12",
        canReview: true, // no fromStage: it names a stage the session does not declare
      },
      {
        stageKey: "publish",
        stageName: "Publish",
        kind: "human",
        state: "withheld", // p-foreign is not readable
        decidedByHuman: false,
        canReview: false,
      },
      {
        // a pending state with no proposal id can only be withheld
        stageKey: "draft",
        stageName: "Draft",
        kind: "human",
        state: "withheld",
        decidedByHuman: false,
        canReview: false,
      },
    ]);
    // The gate of a stage the session does not declare is dropped.
    expect(wireOf(item)).not.toContain("stage-of-another-space");
    expect(wireOf(item)).not.toContain("p-foreign");
  });

  it("a runner's name rides only when the key reads the person's agents", () => {
    const open = wireOf(
      narrowWorkItem(ITEM, { ...NONE, holderReadable: true })
    );
    expect(open).toContain("Scribe");
    expect(wireOf(narrowWorkItem(ITEM, NONE))).not.toContain("Scribe");
  });

  it("a hold keeps its kind only, never its reference, reason or resume condition", () => {
    expect(
      (narrowWorkItem(ITEM, NONE) as { hold: unknown }).hold
    ).toEqual({ on: "person", since: "t0" });
  });

  it("an unavailable part stays unavailable, an unreadable work part is unavailable", () => {
    expect(narrowStatusOfWork({ status: "unavailable", reason: "x leaks 7" })).toEqual({
      status: "unavailable",
      reason: "This part could not be read.",
    });
    const item = narrowWorkItem(
      { ...ITEM, stages: { status: "unavailable", reason: "r" }, gates: { status: "ok", items: ITEM.gates.items } },
      NONE
    ) as { stages: unknown; gates: unknown };
    expect(item.stages).toMatchObject({ status: "unavailable" });
    // No declared stage to name a gate from: the gates are unavailable, never "none".
    expect(item.gates).toMatchObject({ status: "unavailable" });
  });
});
