/**
 * WHERE a push tap lands.
 *
 * The defect: the push payload carried `sourceType`/`sourceId` and a `deepLink`
 * minted for `sourceType === 'proposal'` ONLY. Relay's push router reads, in
 * order, an explicit link → the proposal special case → `{kind, id}` mapped
 * through its route table — and nothing in the pod ever sent the third. Its
 * `session` and `room` routes were BUILT with zero producers, so a session push
 * arrived, rendered correctly, and tapped to nothing. Silently.
 *
 * REACHABILITY, NOT SHAPE. Asserting "the payload declares a `kind` key" is the
 * exact defect this closes — a field on the wire that nobody populates. These
 * tests assert the VALUE arrives, and then feed it to relay's own
 * `objectRouteFor` table so the claim under test is "a tap resolves a screen",
 * not "two strings were copied".
 *
 * `ROUTE_TABLE` below is relay's table RESTATED, not imported: relay is a
 * separate repo with its own module graph and `@synap/api` cannot depend on it.
 * That is a real limitation and it is the reason for the last test in this
 * file, which pins the restatement to relay's source on disk so this cannot
 * quietly become a test of its own fiction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const {
  mockEmitChatEvent,
  mockPrefs,
  mockInsertReturning,
  mockSendExpoPush,
  dedupeHits,
} = vi.hoisted(() => ({
  mockEmitChatEvent: vi.fn(),
  mockPrefs: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockSendExpoPush: vi.fn(),
  /** Rows the dedupe pre-insert lookup finds. Empty ⇒ nothing suppressed. */
  dedupeHits: [] as unknown[][],
}));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: mockEmitChatEvent,
}));
vi.mock("../expo-push.js", () => ({ sendExpoPush: mockSendExpoPush }));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: { notificationPreferences: { findFirst: mockPrefs } },
      insert: () => ({ values: () => ({ returning: mockInsertReturning }) }),
      // The dedupe gate's pre-insert lookup. Thenable chain, same idiom as
      // `session-unblock-reactor.test.ts`.
      select: () => {
        const node: Record<string, unknown> = {
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(dedupeHits.shift() ?? []).then(resolve),
        };
        for (const m of ["from", "where", "limit"]) node[m] = () => node;
        return node;
      },
    },
    eventRepository: { append: vi.fn().mockResolvedValue(undefined) },
  };
});
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

import { NotificationService, pushTarget } from "../NotificationService.js";
import { getNotificationDef } from "../registry.js";

/** Relay's route table on disk — a separate repo, so pinned by path. */
const RELAY_OBJECT_NAV = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../relay-app/src/lib/object-nav.ts"
);

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const SESSION = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
  mockEmitChatEvent.mockClear();
  mockSendExpoPush.mockClear();
  mockSendExpoPush.mockResolvedValue({ sent: 1, revoked: 0, failed: 0 });
  mockPrefs.mockResolvedValue(undefined);
  mockInsertReturning.mockResolvedValue([{ id: "row-1" }]);
  dedupeHits.length = 0;
});

function pushData(): Record<string, unknown> {
  expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
  return (mockSendExpoPush.mock.calls[0]![0] as Record<string, unknown>)
    .data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Relay's route table, restated. Pinned to relay's source by the last test.
// ---------------------------------------------------------------------------
const ROUTE_TABLE: Record<string, (id: string) => string> = {
  session: (id) => `/session/${encodeURIComponent(id)}`,
  room: (id) => `/room/${encodeURIComponent(id)}`,
  proposal: (id) => `/proposal/${encodeURIComponent(id)}`,
};

/** Relay's `routeForPushNotificationData`, in the order relay reads it. */
function routeForPushData(data: Record<string, unknown>): string | null {
  const url = data.url;
  if (typeof url === "string" && url) return url;
  if (data.sourceType === "proposal" && typeof data.sourceId === "string") {
    return `/proposal/${encodeURIComponent(data.sourceId)}`;
  }
  const kind = data.kind;
  const id = data.id;
  if (typeof kind === "string" && typeof id === "string") {
    const view = data.view;
    const key = typeof view === "string" && view ? view : kind;
    return ROUTE_TABLE[key]?.(id) ?? null;
  }
  return null;
}

describe("push tap target — the payload carries {kind,id}", () => {
  it("(a) an escalation push resolves to the session screen (was: nothing)", async () => {
    await NotificationService.create({
      type: "session.criterion_escalated",
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "session",
      sourceId: SESSION,
      groupKey: `k:${SESSION}`,
      data: {
        sessionId: SESSION,
        sessionTitle: "Ship it",
        criterionStatement: "Typecheck passes",
        attempts: 2,
      },
    });

    const data = pushData();
    expect(data.kind).toBe("session");
    expect(data.id).toBe(SESSION);
    // The claim that matters: relay's own table resolves it to a real screen.
    expect(routeForPushData(data)).toBe(`/session/${SESSION}`);
  });

  it("(b) a criteria-unmet push resolves to the same screen", async () => {
    await NotificationService.create({
      type: "session.closed.criteria_unmet",
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "session",
      sourceId: SESSION,
      groupKey: `k2:${SESSION}`,
      data: {
        sessionId: SESSION,
        sessionTitle: "Ship it",
        statusLabel: "Closed",
        unmetSummary: "1 required criterion not met",
      },
    });
    expect(routeForPushData(pushData())).toBe(`/session/${SESSION}`);
  });

  it("(c) the `view` reading survives the wire — handoff.continue opens the ROOM, not the session", async () => {
    // `handoff.continue` declares `view: 'room'`. Dropping `view` would land the
    // tap on the session screen: plausible, wrong, and invisible.
    await NotificationService.create({
      type: "handoff.continue",
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "session",
      sourceId: SESSION,
      data: { goal: "Finish the import" },
    });
    // `handoff.continue` is ceilinged to in_app, so nothing is pushed — the
    // target derivation is still asserted directly, which is the unit under
    // test here.
    expect(mockSendExpoPush).not.toHaveBeenCalled();
    const target = pushTarget(getNotificationDef("handoff.continue")!, {
      sourceId: SESSION,
    });
    expect(target).toEqual({ kind: "session", id: SESSION, view: "room" });
    expect(routeForPushData({ ...target })).toBe(`/room/${SESSION}`);
  });

  it("(d) an explicit `target` overrides the registry's action", async () => {
    await NotificationService.create({
      type: "session.criterion_escalated",
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "session",
      sourceId: SESSION,
      groupKey: `k3:${SESSION}`,
      target: { kind: "session", id: SESSION, view: "room" },
      data: {
        sessionId: SESSION,
        sessionTitle: "x",
        criterionStatement: "y",
        attempts: 2,
      },
    });
    expect(routeForPushData(pushData())).toBe(`/room/${SESSION}`);
  });

  it("(e) REGRESSION FLOOR: the proposal deepLink is unchanged, and still wins", async () => {
    // Relay reads a link FIRST. Adding `{kind,id}` must not have displaced it.
    process.env.PUBLIC_URL = "https://pod.example.test";
    await NotificationService.create({
      type: "proposal.created",
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "proposal",
      sourceId: "44444444-4444-4444-8444-444444444444",
      data: { proposalType: "entity.create", description: "Create ACME Corp" },
    });
    const data = pushData();
    expect(data.deepLink).toBe(
      "https://pod.example.test/open/44444444-4444-4444-8444-444444444444?client=mobile"
    );
    delete process.env.PUBLIC_URL;
  });

  it("(f) a type with NO navigate-object action carries no kind/id — a dead link is worse than none", async () => {
    // ANTI-VACUITY: proves (a)/(b) are not passing because the keys are
    // unconditionally stamped onto every payload.
    await NotificationService.create({
      type: "agent.task_failed",
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "agent",
      sourceId: "turn-1",
      data: { agentName: "coder", errorMessage: "boom" },
    });
    const data = pushData();
    expect(data.kind).toBeUndefined();
    expect(data.id).toBeUndefined();
    expect(routeForPushData(data)).toBeNull();
  });

  it("(g) a navigate-object action with no literal id and no sourceId yields nothing", () => {
    const def = getNotificationDef("session.criterion_escalated")!;
    expect(pushTarget(def, {})).toBeUndefined();
  });

  it("(h) PIN: the restated ROUTE_TABLE above matches relay's own source", () => {
    // What makes this file's restatement honest rather than a test of its own
    // fiction. If relay renames or removes one of these routes, this goes red.
    const relayObjectNav = readFileSync(RELAY_OBJECT_NAV, "utf8");
    // Non-vacuity: the file must be the one we think it is.
    expect(relayObjectNav).toContain("export function objectRouteFor");
    expect(Object.keys(ROUTE_TABLE).length).toBeGreaterThanOrEqual(3);
    for (const kind of Object.keys(ROUTE_TABLE)) {
      expect(
        new RegExp(`^\\s*${kind}: \\(id\\) =>`, "m").test(relayObjectNav),
        `relay's object-nav has no route for kind "${kind}"`
      ).toBe(true);
    }
  });

  it("(i) PIN: both new session types name a kind relay can actually open", () => {
    const relayObjectNav = readFileSync(RELAY_OBJECT_NAV, "utf8");
    const newTypes = [
      "session.criterion_escalated",
      "session.closed.criteria_unmet",
    ];
    for (const type of newTypes) {
      const target = pushTarget(getNotificationDef(type)!, {
        sourceId: SESSION,
      });
      expect(target, `${type} must name a tap target`).toBeTruthy();
      expect(
        new RegExp(`^\\s*${target!.kind}: \\(id\\) =>`, "m").test(
          relayObjectNav
        )
      ).toBe(true);
    }
  });

  /**
   * MEASURED LIMIT, stated rather than implied. This file pins the kinds the
   * TWO NEW types emit, not every kind in the registry — because one existing
   * type already names a kind relay deliberately cannot open: `chat.mention`
   * declares `kind: "channel"`, and relay lists `channel` in its `NO_SCREEN`
   * set on purpose ("relay has no channel INSPECT screen"). Forwarding
   * `{kind,id}` for it is not a regression — before this change the payload
   * carried no kind at all and also navigated nowhere; relay's router returns
   * null for an unroutable kind either way. A registry-wide pin would
   * therefore be red on arrival for a reason that is not a defect, and a guard
   * that is red for a non-defect is a guard that gets deleted.
   */
  it("(j) the known gap is real and unchanged: `channel` is routable nowhere on relay", () => {
    const relayObjectNav = readFileSync(RELAY_OBJECT_NAV, "utf8");
    expect(/^\s*channel: \(id\) =>/m.test(relayObjectNav)).toBe(false);
    expect(routeForPushData({ kind: "channel", id: "c1" })).toBeNull();
  });
});
