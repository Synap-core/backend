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
  work: { items: [] },
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
