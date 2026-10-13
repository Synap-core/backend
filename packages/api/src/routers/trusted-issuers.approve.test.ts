/**
 * `trustedIssuers.approve` decides only from the status the person saw: the
 * default is `pending`, a moved status is CONFLICT (never a silent resurrect),
 * a missing issuer is NOT_FOUND. The compare-and-set itself is the service's
 * (`trusted-issuer-service.pglite.test.ts`); this locks the door's mapping.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  approveFromStatus: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: { query: { trustedIssuers: { findFirst: h.findFirst } } },
    TrustedIssuerService: class {
      approveFromStatus = h.approveFromStatus;
    },
  };
});
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => true,
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { trustedIssuersRouter } from "./trusted-issuers.js";
import type { Context } from "../types/context.js";

const ID = "6f1c9a52-6d1b-4f38-9a3c-1b2f8f5b2a10";
const admin = () =>
  trustedIssuersRouter.createCaller({
    authenticated: true,
    userId: "admin-1",
  } as unknown as Context);

beforeEach(() => {
  h.approveFromStatus.mockReset();
  h.findFirst.mockReset();
});

describe("trustedIssuers.approve", () => {
  it("approves from pending by default", async () => {
    h.approveFromStatus.mockResolvedValue({ id: ID, status: "approved" });
    await expect(
      admin().approve({ id: ID, allowedScopes: ["sync"] })
    ).resolves.toMatchObject({ status: "approved" });
    expect(h.approveFromStatus).toHaveBeenCalledWith(
      ID,
      "admin-1",
      ["sync"],
      "pending"
    );
  });

  it("an issuer that is no longer pending is CONFLICT, not re-approved", async () => {
    h.approveFromStatus.mockResolvedValue(null);
    h.findFirst.mockResolvedValue({ status: "revoked" });
    await expect(
      admin().approve({ id: ID, allowedScopes: ["sync"] })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a scope change on an approved issuer names that status explicitly", async () => {
    h.approveFromStatus.mockResolvedValue({ id: ID, status: "approved" });
    await admin().approve({
      id: ID,
      allowedScopes: ["sync"],
      expectedStatus: "approved",
    });
    expect(h.approveFromStatus).toHaveBeenCalledWith(
      ID,
      "admin-1",
      ["sync"],
      "approved"
    );
  });

  it("an unknown issuer is NOT_FOUND", async () => {
    h.approveFromStatus.mockResolvedValue(null);
    h.findFirst.mockResolvedValue(undefined);
    await expect(
      admin().approve({ id: ID, allowedScopes: ["sync"] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
