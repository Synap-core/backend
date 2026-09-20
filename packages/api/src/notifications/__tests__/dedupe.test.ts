/**
 * The dedupe gate, at the mechanism level.
 *
 * `session-attention-notifications.pglite.test.ts` proves the BEHAVIOUR on the
 * real doors with a real database. This file proves the three decisions the
 * mechanism encodes, each with the input that would rule the other rule out:
 *
 *   1. it is OPT-IN — a type with no `dedupeWindowMs` is never suppressed, even
 *      when a matching row exists. (Without this, `proposal.created` — which
 *      groups by AGENT — would silently swallow every proposal after an
 *      agent's first.)
 *   2. it suppresses EVERYTHING, not just the interruption: no row, no socket,
 *      no push. A gate that only skipped the push would leave N rows stacking
 *      in the bell.
 *   3. it needs a groupKey to mean anything, and says so rather than
 *      pretending.
 *
 * The discriminating input for (1) is a type WITHOUT the field and a matching
 * row present. A fixture that only ever exercises the deduped type agrees with
 * "suppress everything after the first" by accident.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockEmitChatEvent,
  mockPrefs,
  mockInsertReturning,
  mockSendExpoPush,
  dedupeHits,
  whereArgs,
  tz,
} = vi.hoisted(() => ({
  mockEmitChatEvent: vi.fn(),
  mockPrefs: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockSendExpoPush: vi.fn(),
  dedupeHits: [] as unknown[][],
  /** Every `.where()` argument the dedupe lookup built, for non-vacuity. */
  whereArgs: [] as unknown[],
  /** The recipient's stored IANA timezone. */
  tz: { value: "UTC" },
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
      select: (cols?: Record<string, unknown>) => {
        // `recipientTimezone` and the dedupe lookup share `db.select`. They are
        // told apart by the columns asked for, so a timezone read can never
        // consume a queued dedupe row (which would make the dedupe tests pass
        // for the wrong reason).
        const isTz = !!cols && "timezone" in cols;
        const node: Record<string, unknown> = {
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve(
              isTz ? [{ timezone: tz.value }] : (dedupeHits.shift() ?? [])
            ).then(resolve),
        };
        node.from = () => node;
        node.where = (arg: unknown) => {
          if (!isTz) whereArgs.push(arg);
          return node;
        };
        node.limit = () => node;
        return node;
      },
    },
    eventRepository: { append: vi.fn().mockResolvedValue(undefined) },
  };
});
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

import {
  NotificationService,
  localHourMinute,
} from "../NotificationService.js";
import { getNotificationDef } from "../registry.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const SESSION = "55555555-5555-4555-8555-555555555555";

/** A type that DECLARES a window. */
const DEDUPED = "session.criterion_escalated";
/** A type that does NOT — the discriminator. */
const NOT_DEDUPED = "proposal.created";

function escalation(overrides: Record<string, unknown> = {}) {
  return {
    type: DEDUPED,
    userId: USER,
    workspaceId: WORKSPACE,
    sourceType: "session" as const,
    sourceId: SESSION,
    groupKey: `${DEDUPED}:${SESSION}`,
    data: {
      sessionId: SESSION,
      sessionTitle: "Ship it",
      criterionStatement: "Typecheck passes",
      attempts: 2,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendExpoPush.mockResolvedValue({ sent: 1, revoked: 0, failed: 0 });
  mockPrefs.mockResolvedValue(undefined);
  mockInsertReturning.mockResolvedValue([{ id: "row-1" }]);
  dedupeHits.length = 0;
  whereArgs.length = 0;
  tz.value = "UTC";
});

describe("NotificationService.create — dedupe", () => {
  it("(a) the registry actually declares the window (non-vacuity)", () => {
    expect(getNotificationDef(DEDUPED)?.dedupeWindowMs).toBeGreaterThan(0);
    expect(
      getNotificationDef("session.closed.criteria_unmet")?.dedupeWindowMs
    ).toBeGreaterThan(0);
    // The discriminator must really lack it, or test (d) proves nothing.
    expect(getNotificationDef(NOT_DEDUPED)?.dedupeWindowMs).toBeUndefined();
  });

  it("(b) no matching row → the notification is written and BOTH channels fire", async () => {
    dedupeHits.push([]); // the lookup finds nothing
    const id = await NotificationService.create(escalation());

    expect(id).toBe("row-1");
    expect(mockEmitChatEvent).toHaveBeenCalledTimes(1);
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
    // The lookup RAN — otherwise (c) would pass for the wrong reason.
    expect(whereArgs).toHaveLength(1);
  });

  it("(c) a matching row inside the window → NO row, NO socket, NO push", async () => {
    dedupeHits.push([{ id: "earlier-row" }]);
    const id = await NotificationService.create(escalation());

    expect(id).toBeUndefined();
    expect(mockInsertReturning).not.toHaveBeenCalled();
    expect(mockEmitChatEvent).not.toHaveBeenCalled();
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });

  it("(d) DISCRIMINATOR: a type without a window is NOT suppressed by a matching row", async () => {
    // Same shape, same available "earlier row" — the ONLY difference is that
    // this type does not declare `dedupeWindowMs`. If the gate were global,
    // this would be suppressed too, and an agent's second proposal would
    // vanish.
    dedupeHits.push([{ id: "earlier-row" }]);
    const id = await NotificationService.create({
      type: NOT_DEDUPED,
      userId: USER,
      workspaceId: WORKSPACE,
      sourceType: "proposal",
      sourceId: "44444444-4444-4444-8444-444444444444",
      groupKey: `${WORKSPACE}:proposal.created:agent-1`,
      data: { proposalType: "entity.create", description: "Create ACME" },
    });

    expect(id).toBe("row-1");
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
    // It never even LOOKED — the gate is opt-in, not a lookup that happens to
    // miss.
    expect(whereArgs).toHaveLength(0);
  });

  it("(e) a deduped type with NO resolvable groupKey is written, not silently dropped", async () => {
    // `groupBy: 'sessionId'` needs a workspaceId to build the fallback key, so
    // a pod-wide escalation with no explicit key has none. "Cannot identify
    // this" must not become "suppress this" — an un-dedupable notification is
    // still news.
    const id = await NotificationService.create(
      escalation({ groupKey: undefined, workspaceId: null })
    );

    expect(id).toBe("row-1");
    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
    expect(whereArgs).toHaveLength(0);
  });

  it("(f) a MUTED category short-circuits before the lookup — prefs still outrank dedupe", async () => {
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { ai: "mute" },
    });
    dedupeHits.push([]);

    const id = await NotificationService.create(escalation());

    expect(id).toBeUndefined();
    expect(whereArgs).toHaveLength(0);
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });
});

/**
 * ROUTING-RULE PRECEDENCE: more specific wins.
 *
 * `routingRules` has always held BOTH category keys and type keys, and the
 * resolver read `rules[category] ?? rules[type]` — so the type half was dead
 * whenever its category carried a rule. That is the worst shape a preference
 * can have: the control exists, writes a real row, and is silently overruled.
 * The per-type picker this wave exists to enable would have shipped as a lie.
 *
 * Each test below is the input that RULES OUT the other precedence. A fixture
 * where only one of the two keys is set agrees with both rules and proves
 * nothing, which is why every case here sets BOTH and they disagree.
 */
describe("NotificationService.create — routing-rule precedence", () => {
  it("(g) a per-TYPE rule overrides its category's rule", async () => {
    // Category says mute, type says in_app. Old precedence: silent. New: emits.
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { ai: "mute", [DEDUPED]: "in_app" },
    });
    dedupeHits.push([]);

    const id = await NotificationService.create(escalation());

    expect(id).toBe("row-1");
    expect(mockEmitChatEvent).toHaveBeenCalledTimes(1);
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });

  it("(h) a per-TYPE mute silences a type whose category is NOT muted", async () => {
    // The inverse direction, so this cannot pass by the resolver simply
    // preferring whichever key is non-mute.
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { ai: "all", [DEDUPED]: "mute" },
    });

    const id = await NotificationService.create(escalation());

    expect(id).toBeUndefined();
    expect(mockEmitChatEvent).not.toHaveBeenCalled();
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });

  it("(i) the category rule still governs a type that is NOT named individually", async () => {
    // Category is the FALLBACK, not removed. A rule set on `ai` must still
    // reach every ai-category type the user has not singled out.
    mockPrefs.mockResolvedValue({
      enabled: true,
      routingRules: { ai: "mute", "session.closed.criteria_unmet": "all" },
    });

    const id = await NotificationService.create(escalation());

    expect(id).toBeUndefined();
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });
});

/**
 * QUIET HOURS ARE READ ON THE RECIPIENT'S CLOCK.
 *
 * `notifications.ts:162` has always documented the window as "(local time,
 * user's timezone)" and the code read `new Date().getHours()` — the SERVER's
 * clock. A pod in UTC serving a founder in UTC+2 applied a 22:00–08:00 window
 * at 00:00–10:00 their time: silent through their morning, ringing at midnight.
 * The exact inverse of the setting, on the one channel allowed to wake someone.
 *
 * Each case fixes a real instant and varies ONLY the stored timezone, so the
 * two candidate rules (server clock vs recipient clock) disagree on every row.
 */
describe("NotificationService.create — quiet hours use the recipient's timezone", () => {
  /** 23:30 UTC — inside a 22:00–08:00 window in UTC, OUTSIDE it in UTC-5. */
  const AT = new Date("2026-09-20T23:30:00Z");

  const QUIET = {
    enabled: true,
    routingRules: {},
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
  });

  it("(j) the helper reads the given zone, not the host's (non-vacuity)", () => {
    expect(localHourMinute(AT, "UTC")).toBe("23:30");
    expect(localHourMinute(AT, "America/New_York")).toBe("19:30");
    expect(localHourMinute(AT, "Asia/Kolkata")).toBe("05:00"); // half-hour offset
  });

  it("(k) a recipient in UTC is inside the window — suppressed", async () => {
    mockPrefs.mockResolvedValue(QUIET);
    tz.value = "UTC";
    dedupeHits.push([]);

    await NotificationService.create(escalation());

    expect(mockSendExpoPush).not.toHaveBeenCalled();
    expect(mockEmitChatEvent).not.toHaveBeenCalled();
  });

  it("(l) DISCRIMINATOR: at the SAME instant a recipient in UTC-5 is at 18:30 — NOT suppressed", async () => {
    // Same moment, same window, different stored zone. Under the server-clock
    // rule this is identical to (k) and would also be suppressed.
    mockPrefs.mockResolvedValue(QUIET);
    tz.value = "America/New_York";
    dedupeHits.push([]);

    await NotificationService.create(escalation());

    expect(mockSendExpoPush).toHaveBeenCalledTimes(1);
    expect(mockEmitChatEvent).toHaveBeenCalledTimes(1);
  });

  it("(m) an unknown IANA name falls back to UTC rather than losing the notification", async () => {
    mockPrefs.mockResolvedValue(QUIET);
    tz.value = "Mars/Olympus_Mons";
    dedupeHits.push([]);

    await NotificationService.create(escalation());

    // UTC ⇒ inside the window ⇒ suppressed interruption, row still written.
    expect(mockInsertReturning).toHaveBeenCalled();
    expect(mockSendExpoPush).not.toHaveBeenCalled();
  });
});
