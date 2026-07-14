import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  returning: vi.fn(),
  where: vi.fn(),
  lt: vi.fn(),
}));

vi.mock("@synap/database", () => ({
  db: { delete: mocks.delete },
  federatedAssertionReceipts: { expiresAt: "assertion-expires-at" },
  issuerIdentityLinkReceipts: { expiresAt: "identity-link-expires-at" },
  lt: mocks.lt,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import { handleFederationReceiptCleanup } from "./federation-receipt-cleanup.js";

describe("handleFederationReceiptCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lt.mockReturnValue(Symbol("expired-receipt"));
    mocks.returning.mockResolvedValue([]);
    mocks.where.mockReturnValue({ returning: mocks.returning });
    mocks.delete.mockReturnValue({ where: mocks.where });
  });

  it("purges both kinds of expired federation receipt", async () => {
    await expect(handleFederationReceiptCleanup()).resolves.toBeUndefined();

    expect(mocks.delete).toHaveBeenCalledTimes(2);
    expect(mocks.lt).toHaveBeenCalledWith(
      "assertion-expires-at",
      expect.any(Date)
    );
    expect(mocks.lt).toHaveBeenCalledWith(
      "identity-link-expires-at",
      expect.any(Date)
    );
    expect(mocks.where).toHaveBeenCalledTimes(2);
    expect(mocks.returning).toHaveBeenCalledTimes(2);
  });

  it("fails the job when receipt cleanup cannot reach the database", async () => {
    mocks.returning.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(handleFederationReceiptCleanup()).rejects.toThrow(
      "database unavailable"
    );
  });
});
