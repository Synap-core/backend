/**
 * An inbox signal for a notification carries the room VIEW its banner action
 * names, so "Continue on desktop" opens the Intake Room from the inbox too.
 *
 * Driven from the REAL registry row (`handoff.continue`'s persisted `actions`,
 * exactly what `create()` stores and `notifCenter.list` returns) through
 * `unionNeedsYou` — nothing hand-built between the registry and the signal.
 */
import { describe, expect, it } from "vitest";
import { getNotificationDef } from "../../../notifications/registry.js";
import {
  targetFromNotification,
  unionNeedsYou,
  type NotificationSignalInput,
} from "../needs-you-union.js";

const SESSION = "5b7d9c1e-0000-4000-8000-000000000001";

function row(
  type: string,
  sourceType: string,
  over: Partial<NotificationSignalInput> = {}
): NotificationSignalInput {
  return {
    id: `n-${type}`,
    title: `t ${type}`,
    category: "system",
    sourceType,
    sourceId: SESSION,
    createdAt: new Date("2026-09-13T10:00:00Z"),
    // What the DB row holds: the registry def's actions, verbatim.
    actions: getNotificationDef(type)?.actions ?? [],
    ...over,
  };
}

function targetOf(n: NotificationSignalInput) {
  const signals = unionNeedsYou({
    clusters: [],
    notifications: [n],
    owedSlots: [],
  });
  return signals.find((s) => s.id === `notification:${n.id}`)?.target;
}

describe("notification signal target view", () => {
  it("a handoff.continue row opens the session's ROOM from the inbox", () => {
    expect(getNotificationDef("handoff.continue")).toBeDefined();
    expect(targetOf(row("handoff.continue", "session"))).toEqual({
      kind: "session",
      id: SESSION,
      view: "room",
    });
  });

  it("a session row whose action names no view opens the plain session", () => {
    // session.unblocked's action is navigate-object session with no view.
    expect(targetOf(row("session.unblocked", "session"))).toEqual({
      kind: "session",
      id: SESSION,
    });
  });

  it("drops a view the allowlist does not name, or one on another kind / object", () => {
    const actions = (handler: Record<string, unknown>) => [
      { id: "a", handler },
    ];
    expect(
      targetFromNotification(
        "session",
        SESSION,
        actions({ type: "navigate-object", kind: "session", view: "thread" })
      )
    ).toEqual({ kind: "session", id: SESSION });
    expect(
      targetFromNotification(
        "session",
        SESSION,
        actions({ type: "navigate-object", kind: "proposal", view: "room" })
      )
    ).toEqual({ kind: "session", id: SESSION });
    expect(
      targetFromNotification(
        "session",
        SESSION,
        actions({
          type: "navigate-object",
          kind: "session",
          id: "other",
          view: "room",
        })
      )
    ).toEqual({ kind: "session", id: SESSION });
    expect(targetFromNotification("session", SESSION, "junk")).toEqual({
      kind: "session",
      id: SESSION,
    });
  });
});
