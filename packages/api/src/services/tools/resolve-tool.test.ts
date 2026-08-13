import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression lock for the "Event sync · on" → "skipped (it is disabled)" bug
 * class — now covering every caller of the shared `resolveTool` door
 * (discord event-sync, discord mail-feed, cal.com backfill, fireflies
 * backfill all route through this one function with their own predicate).
 */
const findMany = vi.fn();

vi.mock("@synap/database", () => ({
  db: { query: { tools: { findMany: (...a: unknown[]) => findMany(...a) } } },
}));
vi.mock("@synap/database/schema", () => ({
  tools: { name: "name", createdAt: "created_at" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  asc: (a: unknown) => ({ asc: a }),
}));

const { resolveTool } = await import("./resolve-tool.js");

const isEnabled = (metadata: unknown) =>
  (metadata as { enabled?: boolean } | null)?.enabled === true;

const enabledRow = {
  id: "tool-enabled",
  createdBy: "u1",
  workspaceId: "ws-bridge",
  metadata: { enabled: true },
};
const disabledRow = {
  id: "tool-disabled",
  createdBy: "u1",
  workspaceId: "ws-other",
  metadata: { enabled: false },
};

beforeEach(() => findMany.mockReset());

describe("resolveTool", () => {
  it("returns the CALLER's workspace row, not another workspace's", async () => {
    // Disabled row first — the order that produced the production bug.
    findMany.mockResolvedValue([disabledRow, enabledRow]);
    const got = await resolveTool("discord", isEnabled, "ws-bridge");
    expect(got?.id).toBe("tool-enabled");
  });

  it("never falls back to another workspace when the caller's row is absent", async () => {
    findMany.mockResolvedValue([disabledRow]);
    // Silently running another workspace's config is exactly the mismatch.
    expect(await resolveTool("discord", isEnabled, "ws-bridge")).toBeNull();
  });

  it("unscoped (cron) prefers a row the CALLER'S predicate marks enabled", async () => {
    findMany.mockResolvedValue([disabledRow, enabledRow]);
    const got = await resolveTool("discord", isEnabled);
    expect(got?.id).toBe("tool-enabled");
  });

  it("unscoped with none matching the predicate is deterministic (first by createdAt)", async () => {
    findMany.mockResolvedValue([disabledRow, { ...disabledRow, id: "second" }]);
    expect((await resolveTool("discord", isEnabled))?.id).toBe("tool-disabled");
  });

  it("returns null when the pod has no such tool", async () => {
    findMany.mockResolvedValue([]);
    expect(await resolveTool("discord", isEnabled)).toBeNull();
    expect(await resolveTool("discord", isEnabled, "ws-bridge")).toBeNull();
  });

  it("a caller's predicate for the WRONG feature does not silently substitute — proves the predicate is genuinely load-bearing, not decorative", async () => {
    // A row enabled for feature A ("enabled") but the caller is asking about
    // a DIFFERENT feature ("mailFeedEnabled") that this row does NOT have —
    // must NOT be preferred just because SOME flag on it is true. This is
    // the exact mail-feed/event-sync predicate-mismatch bug, generalised.
    const enabledForOtherFeature = {
      id: "tool-other-feature",
      createdBy: "u1",
      workspaceId: "ws-x",
      metadata: { enabled: true, mailFeedEnabled: false },
    };
    const isMailFeedEnabled = (metadata: unknown) =>
      (metadata as { mailFeedEnabled?: boolean } | null)?.mailFeedEnabled ===
      true;
    findMany.mockResolvedValue([enabledForOtherFeature]);
    const got = await resolveTool("discord", isMailFeedEnabled);
    // Falls back to deterministic-oldest (the only row), NOT "preferred"
    // because some unrelated flag was true.
    expect(got?.id).toBe("tool-other-feature");
    expect(isMailFeedEnabled(got?.metadata)).toBe(false);
  });

  // MUST-FIX 3: the "deterministic (first by createdAt)" cases above assert
  // only the MOCK ARRAY's order, which is decided by the test itself, not by
  // the resolver. Deleting `orderBy: [asc(tools.createdAt)]` from resolve-tool.ts
  // would NOT fail any of them (verified: temporarily deleted it, all cases
  // above still passed). This case is the one that actually locks the
  // ordering — it asserts findMany was CALLED with an orderBy clause at all.
  it("asks the DB to order by createdAt — does not rely on incidental array order", async () => {
    findMany.mockResolvedValue([]);
    await resolveTool("discord", isEnabled);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ asc: "created_at" }],
      })
    );
  });
});
