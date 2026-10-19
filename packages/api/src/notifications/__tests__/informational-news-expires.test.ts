/**
 * Two notices that are NEWS, not asks — `pod.update_failed` (the engine
 * already rolled back) and `session.closed.criteria_unmet` (the session is
 * closed) — must not count in needs-you, and must go stale on their own.
 *
 *  - the COUNT is read through the real union (`countNeedsYou`), which
 *    classifies rows with `needsYouRole()` — so an omitted role (which
 *    resolves to "item") fails here, not only a wrong one;
 *  - the EXPIRY is read off the row `NotificationService.create()` inserts:
 *    `expiresAt` = now + the registry's `expiresAfterMs`, which the daily
 *    `notification-cleanup` worker honours. The discriminator is a type that
 *    declares no expiry (`pod.update_available`): it must stay unstamped, or
 *    "stamp every row" would pass too.
 *
 * NOT covered here: the cleanup worker itself (`packages/jobs`), and the
 * refresh path (0281) re-stamping `expiresAt` in SQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertedValues, mockInsertReturning } = vi.hoisted(() => ({
  insertedValues: [] as Array<Record<string, unknown>>,
  mockInsertReturning: vi.fn(),
}));

vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: vi.fn(),
}));
vi.mock("../expo-push.js", () => ({
  sendExpoPush: vi.fn().mockResolvedValue({ sent: 0, revoked: 0, failed: 0 }),
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const select = (cols?: Record<string, unknown>) => {
    const isTz = !!cols && "timezone" in cols;
    const node: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(isTz ? [{ timezone: "UTC" }] : []).then(resolve),
    };
    node.from = () => node;
    node.where = () => node;
    node.limit = () => node;
    return node;
  };
  return {
    ...actual,
    db: {
      query: {
        notificationPreferences: { findFirst: async () => undefined },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          insertedValues.push(v);
          return { returning: mockInsertReturning };
        },
      }),
      select,
    },
    eventRepository: { append: vi.fn().mockResolvedValue(undefined) },
  };
});
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

import { NotificationService } from "../NotificationService.js";
import {
  getNotificationDef,
  needsYouRole,
  STALE_NEWS_EXPIRY_MS,
} from "../registry.js";
import {
  countNeedsYou,
  type NotificationSignalInput,
} from "../../services/signals/needs-you-union.js";

const NEWS = ["pod.update_failed", "session.closed.criteria_unmet"] as const;
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "55555555-5555-4555-8555-555555555555";

const row = (type: string, n: number): NotificationSignalInput => ({
  id: `n-${n}`,
  type,
  title: `${type} ${n}`,
  category: "system",
  sourceType: "system",
  sourceId: `src-${n}`,
  createdAt: new Date("2026-10-19T10:00:00Z"),
});

beforeEach(() => {
  insertedValues.length = 0;
  mockInsertReturning.mockReset();
  mockInsertReturning.mockResolvedValue([{ id: "row-1" }]);
});

describe("informational news never counts in needs-you", () => {
  it.each(NEWS)("%s resolves to the informational role", (type) => {
    expect(getNotificationDef(type), type).toBeDefined(); // non-vacuity
    expect(needsYouRole(type)).toBe("informational");
  });

  it("the real union counts the ask beside them, and only the ask", () => {
    const r = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [
        row("pod.update_failed", 1),
        row("session.closed.criteria_unmet", 2),
        // An ordinary item — proves the union still counts rows at all.
        row("inbox.email", 3),
      ],
      notificationsTruncated: false,
      owedSlots: [],
      owedTruncated: false,
      openQuestionSessionIds: new Set(),
    });
    expect(r.notifications).toBe(1);
    expect(r.needsYou).toBe(1);
  });
});

describe("informational news expires", () => {
  const inputs = {
    "pod.update_failed": {
      type: "pod.update_failed",
      userId: USER,
      sourceType: "system" as const,
      data: { version: "1.2.3", headline: "rolled back", detail: "d" },
    },
    "session.closed.criteria_unmet": {
      type: "session.closed.criteria_unmet",
      userId: USER,
      sourceType: "session" as const,
      sourceId: SESSION,
      groupKey: `session.closed.criteria_unmet:${SESSION}`,
      data: {
        sessionId: SESSION,
        sessionTitle: "Ship it",
        statusLabel: "Closed",
        unmetSummary: "1 unmet",
      },
    },
  };

  it.each(NEWS)("%s is inserted with expiresAt = now + a week", async (t) => {
    const before = Date.now();
    await NotificationService.create(inputs[t] as never);
    expect(insertedValues).toHaveLength(1);
    const at = insertedValues[0]!.expiresAt as Date;
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before + STALE_NEWS_EXPIRY_MS);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now() + STALE_NEWS_EXPIRY_MS);
  });

  it("DISCRIMINATOR: a type that declares no expiry is never stamped", async () => {
    await NotificationService.create({
      type: "pod.update_available",
      userId: USER,
      sourceType: "system",
      data: { version: "1.2.3" },
    } as never);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]!.expiresAt).toBeUndefined();
  });
});
