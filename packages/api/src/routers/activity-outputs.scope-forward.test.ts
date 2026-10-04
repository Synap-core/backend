/**
 * A track / session lens's "Show all" and pulse read the SAME narrowing the
 * lens read does: `activity.list`, `activity.daily` and `outputs.landed`
 * forward `trackId` / `sessionId` to the service that already honours them.
 * The assertion reads the FORWARDED query (a router that accepted the input
 * and dropped it would return the whole floor under a session's heading).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSpy = vi.fn();
const dailySpy = vi.fn();
const landedSpy = vi.fn();

vi.mock("../services/activity/list-activity.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listActivity: async (q: unknown) => {
    listSpy(q);
    return { items: [], nextCursor: null };
  },
  dailyActivity: async (q: unknown) => {
    dailySpy(q);
    return { from: "2026-10-01", to: "2026-10-04", tz: "UTC", days: [] };
  },
}));

vi.mock("../services/outputs/landed-outputs.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLandedOutputs: async (q: unknown) => {
    landedSpy(q);
    return {
      items: [],
      pending: { count: 0, samples: [] },
      nextCursor: null,
      truncated: false,
    };
  },
}));

const { activityRouter } = await import("./activity.js");
const { outputsRouter } = await import("./outputs.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const T = "66666666-6666-4666-8666-666666666666";
const S = "11111111-1111-4111-8111-111111111111";

beforeEach(() => vi.clearAllMocks());

describe("track / session narrowing reaches the service", () => {
  it("activity.list", async () => {
    await activityRouter.createCaller(ctx).list({ trackId: T, sessionId: S });
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: T, sessionId: S })
    );
  });

  it("activity.daily", async () => {
    await activityRouter
      .createCaller(ctx)
      .daily({ tz: "UTC", trackId: T, sessionId: S });
    expect(dailySpy).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: T, sessionId: S })
    );
  });

  it("outputs.landed", async () => {
    await outputsRouter.createCaller(ctx).landed({ trackId: T, sessionId: S });
    expect(landedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: T, sessionId: S })
    );
  });
});
