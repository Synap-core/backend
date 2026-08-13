import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression lock: an inbound webhook must resolve the tool row whose SECRET
 * matches, never an arbitrary row of the same provider name. Same failure
 * class as ../tools/resolve-tool.test.ts, applied to the cal.com / fireflies
 * / mailgun webhook receivers.
 */
const findMany = vi.fn();

vi.mock("@synap/database", () => ({
  db: { query: { tools: { findMany: (...a: unknown[]) => findMany(...a) } } },
}));
vi.mock("@synap/database/schema", () => ({
  tools: { name: "name" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

const { resolveToolByWebhookToken } =
  await import("./resolve-tool-by-webhook-token.js");

const rowA = {
  id: "tool-a",
  createdBy: "u1",
  workspaceId: "ws-a",
  metadata: { calcom: { webhook: { token: "secret-a" } } },
};
const rowB = {
  id: "tool-b",
  createdBy: "u2",
  workspaceId: "ws-b",
  metadata: { calcom: { webhook: { token: "secret-b" } } },
};

beforeEach(() => findMany.mockReset());

describe("resolveToolByWebhookToken", () => {
  it("returns the row whose token matches, not the first row (heap order)", async () => {
    findMany.mockResolvedValue([rowA, rowB]);
    const got = await resolveToolByWebhookToken(
      "cal_com",
      "calcom",
      "secret-b"
    );
    expect(got?.id).toBe("tool-b");
  });

  it("returns null when no row's token matches", async () => {
    findMany.mockResolvedValue([rowA, rowB]);
    expect(
      await resolveToolByWebhookToken("cal_com", "calcom", "nope")
    ).toBeNull();
  });

  it("returns null for an empty token without querying selection logic further", async () => {
    findMany.mockResolvedValue([rowA]);
    expect(await resolveToolByWebhookToken("cal_com", "calcom", "")).toBeNull();
  });

  it("returns null when the pod has no such tool", async () => {
    findMany.mockResolvedValue([]);
    expect(
      await resolveToolByWebhookToken("cal_com", "calcom", "secret-a")
    ).toBeNull();
  });
});
