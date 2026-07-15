import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const findFirst = vi.fn();
  return { findFirst, returning, update, where };
});

vi.mock("../client-pg.js", () => ({
  db: {
    update: mocks.update,
    query: {
      issuerIdentityLinkReceipts: { findFirst: mocks.findFirst },
    },
  },
}));

import { consumeIssuerIdentityLinkReceipt } from "./user-provisioning.js";

const input = {
  issuerId: "issuer-1",
  issuerSubject: "issuer-subject-1",
  intentId: "intent-1",
  nonce: "a-strong-nonce",
  receiptId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.returning.mockResolvedValue([]);
  mocks.findFirst.mockResolvedValue(undefined);
});

describe("consumeIssuerIdentityLinkReceipt", () => {
  it("marks a fresh matching proof consumed exactly once", async () => {
    mocks.returning.mockResolvedValue([
      { userId: "pod-user-1", issuerSubject: input.issuerSubject },
    ]);

    await expect(consumeIssuerIdentityLinkReceipt(input)).resolves.toEqual({
      status: "consumed",
      userId: "pod-user-1",
      issuerSubject: input.issuerSubject,
    });
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("recovers the same unexpired proof after a lost issuer response", async () => {
    mocks.findFirst.mockResolvedValue({
      userId: "pod-user-1",
      issuerSubject: input.issuerSubject,
    });

    await expect(consumeIssuerIdentityLinkReceipt(input)).resolves.toEqual({
      status: "already-consumed",
      userId: "pod-user-1",
      issuerSubject: input.issuerSubject,
    });
  });

  it("does not recover a different, expired, or unknown proof", async () => {
    await expect(consumeIssuerIdentityLinkReceipt(input)).resolves.toEqual({
      status: "not-found",
    });
  });
});
