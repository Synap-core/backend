/**
 * `signals.list` / `signals.count` — SCOPE FORWARDING and FAILED-HALF
 * REPORTING.
 *
 * The signals router owns no access logic: it calls `proposals.groups`,
 * `notifCenter.list` and `events.read` through their own routers and the
 * services behind the other doors (`listOwedSlots`, `listSessionsAwaitingReview`,
 * `listActivity`, `listLandedOutputs`). So the thing that can actually break
 * when a scope is added is a scope silently NOT being forwarded — a pod-wide
 * list wearing a container's label — and a failed half silently reading as
 * empty. Those are what these tests pin.
 *
 * DB-FREE: every downstream door is mocked at its module boundary (partial
 * mocks via `importOriginal`) and the assertions read the FORWARDED INPUT.
 * The container FILTER of notifications is behavioural and lives in the
 * PGlite suites (`signals.needs-you-session-pointer.pglite.test.ts`,
 * `signals.lens-page.pglite.test.ts`).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const groupsSpy = vi.fn();
const notifListSpy = vi.fn();
const eventsReadSpy = vi.fn();
const owedSpy = vi.fn();
const reviewSpy = vi.fn();
const activitySpy = vi.fn();
const landedSpy = vi.fn();

vi.mock("./proposals.js", () => ({
  proposalsRouter: { createCaller: () => ({ groups: groupsSpy }) },
}));

vi.mock("./notif-center.js", () => ({
  notifCenterRouter: { createCaller: () => ({ list: notifListSpy }) },
}));

vi.mock("./events.js", () => ({
  eventsRouter: { createCaller: () => ({ read: eventsReadSpy }) },
}));

vi.mock("../services/focus-sessions/owed-outputs.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOwedSlots: async (...args: unknown[]) => {
    owedSpy(...args);
    return [];
  },
}));

vi.mock("../services/projects/project-needs-you.js", () => ({
  listSessionsAwaitingReview: async (...args: unknown[]) => {
    reviewSpy(...args);
    return { sessions: [], truncated: false };
  },
}));

vi.mock("../services/activity/list-activity.js", () => ({
  listActivity: async (...args: unknown[]) => activitySpy(...args),
}));

vi.mock("../services/outputs/landed-outputs.js", () => ({
  LANDED_OUTPUTS_MAX_LIMIT: 100,
  listLandedOutputs: async (...args: unknown[]) => landedSpy(...args),
}));

// Partial mock: keep every real export and replace ONLY the connection.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  return { ...actual, db: chain };
});

const { signalsRouter } = await import("./signals.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => signalsRouter.createCaller(ctx);

const S = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333333";
const T = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  vi.clearAllMocks();
  groupsSpy.mockResolvedValue({
    groups: [],
    distinct: 0,
    scanTruncated: false,
  });
  notifListSpy.mockResolvedValue({ notifications: [] });
  eventsReadSpy.mockResolvedValue([]);
  activitySpy.mockResolvedValue({ items: [], nextCursor: null });
  landedSpy.mockResolvedValue({
    items: [],
    pending: { count: 0, samples: [] },
    nextCursor: null,
    truncated: false,
  });
});

describe("signals.list — needs-you lens forwards the scope to every half", () => {
  it("forwards session / project / track / automation to proposals.groups, split per session", async () => {
    await caller().list({
      lens: "needs-you",
      sessionId: S,
      projectId: P,
      trackId: T,
      automationId: A,
    });
    expect(groupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: S,
        projectId: P,
        trackId: T,
        automationId: A,
        status: "pending",
        splitBySession: true,
      })
    );
  });

  it("KEEPS the notification half under a container scope (narrowed by resolved container, not dropped)", async () => {
    await caller().list({ lens: "needs-you", sessionId: S });
    expect(notifListSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards session + track to the owed read and to the review read", async () => {
    await caller().list({ lens: "needs-you", sessionId: S, trackId: T });
    expect(owedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S, trackId: T, excludeDrafts: true })
    );
    expect(reviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S, trackId: T })
    );
  });

  it("reads sessions awaiting review at POD scope too", async () => {
    await caller().list({ lens: "needs-you" });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    const [arg] = reviewSpy.mock.calls[0] as [Record<string, unknown>];
    expect(arg.projectId).toBeUndefined();
    expect(arg.workspaceId).toBeUndefined();
  });

  it("under an AUTOMATION scope only the proposal half runs — nothing is returned unnarrowed", async () => {
    await caller().list({ lens: "needs-you", automationId: A });
    expect(groupsSpy).toHaveBeenCalledTimes(1);
    expect(notifListSpy).not.toHaveBeenCalled();
    expect(owedSpy).not.toHaveBeenCalled();
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it("THROWS when a half fails — a failed read is never an empty tray", async () => {
    notifListSpy.mockRejectedValue(new Error("notif down"));
    await expect(caller().list({ lens: "needs-you" })).rejects.toThrow(
      "notif down"
    );
  });
});

describe("signals.list — history lens (Happened)", () => {
  it("forwards session / project / track to the activity ledger", async () => {
    await caller().list({
      lens: "history",
      workspaceId: "ws-1",
      sessionId: S,
      projectId: P,
      trackId: T,
    });
    expect(activitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceLens: "ws-1",
        sessionId: S,
        projectId: P,
        trackId: T,
      })
    );
  });

  it("forwards sessionId to events.read", async () => {
    await caller().list({ lens: "history", sessionId: S });
    expect(eventsReadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S })
    );
  });

  for (const scope of [{ projectId: P }, { trackId: T }]) {
    it(`SUPPRESSES the events half under ${Object.keys(scope)[0]} rather than returning it unnarrowed`, async () => {
      await caller().list({ lens: "history", ...scope });
      expect(eventsReadSpy).not.toHaveBeenCalled();
      expect(activitySpy).toHaveBeenCalledTimes(1);
    });
  }

  it("passes the cursor as the ledger's and the events' exclusive upper bound", async () => {
    const cursor = "2026-10-01T00:00:00.000Z";
    await caller().list({ lens: "history", cursor });
    expect(activitySpy).toHaveBeenCalledWith(
      expect.objectContaining({ until: cursor })
    );
    expect(eventsReadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ until: new Date(cursor) })
    );
  });

  it("follows no automation (the ledger cannot narrow by it)", async () => {
    const r = await caller().list({ lens: "history", automationId: A });
    expect(r.signals).toEqual([]);
    expect(activitySpy).not.toHaveBeenCalled();
    expect(eventsReadSpy).not.toHaveBeenCalled();
  });
});

describe("signals.list — produced lens", () => {
  it("forwards every lens to outputs.landed's service", async () => {
    await caller().list({
      lens: "produced",
      workspaceId: "ws-1",
      projectId: P,
      trackId: T,
      sessionId: S,
    });
    expect(landedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceLens: "ws-1",
        projectId: P,
        trackId: T,
        sessionId: S,
      })
    );
  });
});

describe("signals.list — page lens reports failed halves per class", () => {
  it("a failed ledger marks ONLY Happened unreadable; the other classes stay readable", async () => {
    activitySpy.mockRejectedValue(new Error("ledger down"));
    const { page } = await caller().list({ lens: "page" });
    expect(page!.happened.unreadable).toEqual(["activity"]);
    expect(page!.happened.truncated).toBe(true);
    expect(page!.happened.hasMore).toBe(true);
    expect(page!.blocking.unreadable).toEqual([]);
    expect(page!.produced.unreadable).toEqual([]);
  });

  it("a failed notification read marks Blocking + Proposed and says the banner is NOT MEASURED", async () => {
    notifListSpy.mockRejectedValue(new Error("notif down"));
    const { page } = await caller().list({ lens: "page" });
    expect(page!.blocking.unreadable).toContain("notifications");
    expect(page!.proposed.unreadable).toContain("notifications");
    expect(page!.status).toBeNull();
    expect(page!.statusUnreadable).toBe(true);
    expect(page!.happened.unreadable).toEqual([]);
  });

  it("a failed outputs read marks Produced", async () => {
    landedSpy.mockRejectedValue(new Error("outputs down"));
    const { page } = await caller().list({ lens: "page" });
    expect(page!.produced.unreadable).toEqual(["outputs"]);
    expect(page!.produced.rows).toEqual([]);
  });

  it("a project the caller cannot see is unreadable, never an empty Produced", async () => {
    landedSpy.mockResolvedValue(null);
    const { page } = await caller().list({ lens: "page", projectId: P });
    expect(page!.produced.unreadable).toEqual(["outputs"]);
  });

  it("the status banner folds repeated health rows into ONE issue and keeps them out of Blocking", async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 4, 10, m));
    const health = (id: string, m: number, title: string) => ({
      id,
      type: "system.intelligence_degraded",
      category: "system",
      title,
      sourceType: "system",
      sourceId: null,
      createdAt: at(m),
    });
    notifListSpy.mockResolvedValue({
      notifications: [
        health("h1", 1, "Intelligence Hub is degraded"),
        health("h2", 3, "Intelligence Hub is degraded"),
        health("h3", 2, "Intelligence Hub is degraded"),
        {
          id: "st",
          type: "pod.storage_warning",
          category: "system",
          title: "Storage at 91% capacity",
          sourceType: "system",
          sourceId: null,
          createdAt: at(0),
        },
      ],
    });
    const { page } = await caller().list({ lens: "page" });
    expect(page!.status).toMatchObject({
      title: "Intelligence Hub is degraded",
      issues: [
        {
          type: "system.intelligence_degraded",
          repeatCount: 3,
          notificationIds: ["h1", "h2", "h3"],
        },
        { type: "pod.storage_warning", repeatCount: 1 },
      ],
    });
    expect(page!.blocking.total).toBe(0);
    expect(page!.blocking.rows).toEqual([]);
  });

  it("honours per-class caps and reports totals + hasMore past them", async () => {
    notifListSpy.mockResolvedValue({
      notifications: Array.from({ length: 4 }, (_, i) => ({
        id: `n${i}`,
        type: "chat.mention",
        category: "inbox",
        title: `Mention ${i}`,
        sourceType: "entity",
        sourceId: `e${i}`,
        createdAt: new Date(Date.UTC(2026, 9, 4, 10, i)),
      })),
    });
    const { page } = await caller().list({
      lens: "page",
      caps: { blocking: 2 },
    });
    expect(page!.blocking.rows).toHaveLength(2);
    expect(page!.blocking.total).toBe(4);
    expect(page!.blocking.hasMore).toBe(true);
  });
});

describe("signals.count — the same reader, the same scope", () => {
  it("forwards the container scope to every half", async () => {
    await caller().count({ sessionId: S });
    expect(groupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S })
    );
    expect(notifListSpy).toHaveBeenCalledTimes(1);
    expect(owedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: S })
    );
  });

  it("is unchanged for the pod-wide badge's proposal call", async () => {
    await caller().count();
    expect(notifListSpy).toHaveBeenCalledTimes(1);
    const [arg] = groupsSpy.mock.calls[0] as [Record<string, unknown>];
    expect(arg).toEqual(
      expect.objectContaining({ status: "pending", workspaceId: undefined })
    );
  });
});

describe("signals.countByProject — the rail's badges, one round-trip", () => {
  const P1 = "44444444-4444-4444-8444-444444444444";
  const P2 = "55555555-5555-4555-8555-555555555555";

  it("is `count` per project: each call carries its own projectId, none is pod-wide", async () => {
    const out = await caller().countByProject({ projectIds: [P1, P2, P1] });
    expect(out.map((r) => r.projectId)).toEqual([P1, P2]);
    const forwarded = groupsSpy.mock.calls.map(([a]) => a.projectId);
    expect(forwarded.sort()).toEqual([P1, P2].sort());
    expect(out.every((r) => r.status === "ok")).toBe(true);
  });

  it("DRAFTS NEVER COUNT: every half is asked to leave undecided agent drafts out", async () => {
    await caller().countByProject({ projectIds: [P1] });
    expect(groupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: P1, excludeDraftSessions: true })
    );
    expect(owedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ excludeDrafts: true })
    );
  });

  it("reports a project whose count failed as unavailable, never as zero", async () => {
    groupsSpy.mockImplementation(async (a: { projectId?: string }) => {
      if (a.projectId === P2) throw new Error("boom");
      return { groups: [], distinct: 0, scanTruncated: false };
    });
    const out = await caller().countByProject({ projectIds: [P1, P2] });
    expect(out.find((r) => r.projectId === P1)?.status).toBe("ok");
    expect(out.find((r) => r.projectId === P2)).toEqual({
      projectId: P2,
      status: "unavailable",
    });
  });
});
