import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const onConflictDoNothing = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const findFirst = vi.fn();
  const insert = vi.fn(() => ({ values }));
  return { findFirst, insert, onConflictDoNothing, returning, values };
});

vi.mock("../client-pg.js", () => ({
  db: {
    insert: mocks.insert,
    query: { federatedAssertionReceipts: { findFirst: mocks.findFirst } },
  },
}));

import { consumeFederatedAssertionReceipt } from "./federated-assertion-receipt-service.js";

const expiresAt = new Date(Date.now() + 60_000);

describe("consumeFederatedAssertionReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an issuer-scoped receipt before a federated side effect", async () => {
    mocks.returning.mockResolvedValue([{ issuerId: "issuer-1" }]);

    await expect(
      consumeFederatedAssertionReceipt({
        issuerId: "issuer-1",
        jti: "assertion-1",
        expiresAt,
      })
    ).resolves.toBe("consumed");

    expect(mocks.values).toHaveBeenCalledWith({
      issuerId: "issuer-1",
      jti: "assertion-1",
      expiresAt,
      replayContext: null,
    });
    expect(mocks.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("treats a primary-key conflict as an assertion replay", async () => {
    mocks.returning.mockResolvedValue([]);

    await expect(
      consumeFederatedAssertionReceipt({
        issuerId: "issuer-1",
        jti: "assertion-1",
        expiresAt,
      })
    ).resolves.toBe("replayed");
  });

  it("allows only the same generic operation context to recover an interrupted request", async () => {
    mocks.returning.mockResolvedValue([]);
    mocks.findFirst.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      consumeFederatedAssertionReceipt({
        issuerId: "issuer-1",
        jti: "assertion-1",
        expiresAt,
        replayContext: "application-connection:request-1",
      })
    ).resolves.toBe("recovered");

    expect(mocks.values).toHaveBeenCalledWith({
      issuerId: "issuer-1",
      jti: "assertion-1",
      expiresAt,
      replayContext: "application-connection:request-1",
    });
  });

  it("does not write an already-expired assertion", async () => {
    await expect(
      consumeFederatedAssertionReceipt({
        issuerId: "issuer-1",
        jti: "expired-assertion",
        expiresAt: new Date(Date.now() - 1),
      })
    ).resolves.toBe("expired");

    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
