/**
 * A sign-in app's lifecycle is on its timeline: the first redeem of a request
 * is the ask, approve and revoke land on the connection, a turn-down on the
 * request. A refresh that redeems again records nothing new.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getRequest: vi.fn(),
  redeemRequest: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  revokeReturning: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      update: () => ({
        set: () => ({
          where: () => ({ returning: h.revokeReturning }),
        }),
      }),
    },
    FederatedApplicationConnectionService: class {
      getRequest = h.getRequest;
      redeemRequest = h.redeemRequest;
      approve = h.approve;
      reject = h.reject;
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: h.auditLog }));
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

import { applicationConnectionsRouter } from "./application-connections.js";
import type { Context } from "../types/context.js";

const REQUEST = "6f1c9a52-6d1b-4f38-9a3c-1b2f8f5b2a10";
const CONNECTION = "0b8e0c55-0f36-4a5e-9d1a-6a3a4c1f7e21";
const request = {
  id: REQUEST,
  displayName: "Synap CRM",
  clientId: "crm",
  requestedOrigin: "https://crm.example",
  requestedCallbackUrl: "https://crm.example/cb",
};
const as = (userId: string) =>
  applicationConnectionsRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
  } as unknown as Context);

const recorded = () =>
  h.auditLog.mock.calls.map(([opts]) => ({
    type: `${opts.subjectType}.${opts.action}.${opts.phase}`,
    subjectId: opts.subjectId,
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    data: opts.data,
  }));

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
});

describe("applicationConnections — lifecycle events", () => {
  it("records the ask on the first redeem only", async () => {
    h.redeemRequest.mockResolvedValue({ ...request, status: "pending" });
    h.getRequest.mockResolvedValueOnce({ status: "awaiting_local_auth" });
    h.getRequest.mockResolvedValueOnce({ status: "pending" });
    const secret = "a".repeat(40);
    await as("anna").redeemRequest({
      requestId: REQUEST,
      redemptionSecret: secret,
    });
    await as("anna").redeemRequest({
      requestId: REQUEST,
      redemptionSecret: secret,
    });
    expect(recorded()).toEqual([
      {
        type: "application_connection.request.completed",
        subjectId: REQUEST,
        userId: "anna",
        workspaceId: null,
        data: {
          displayName: "Synap CRM",
          clientId: "crm",
          origin: "https://crm.example",
        },
      },
    ]);
  });

  it("records an approval on the connection", async () => {
    h.approve.mockResolvedValue({
      request,
      connection: { id: CONNECTION, displayName: "Synap CRM", clientId: "crm" },
    });
    await as("admin").approveRequest({ requestId: REQUEST });
    expect(recorded()).toEqual([
      {
        type: "application_connection.approve.completed",
        subjectId: CONNECTION,
        userId: "admin",
        workspaceId: null,
        data: {
          displayName: "Synap CRM",
          clientId: "crm",
          requestId: REQUEST,
          origin: "https://crm.example",
        },
      },
    ]);
  });

  it("records a turn-down on the request", async () => {
    h.reject.mockResolvedValue({ ...request, status: "rejected" });
    await as("admin").rejectRequest({ requestId: REQUEST, reason: "Not ours" });
    expect(recorded()).toMatchObject([
      {
        type: "application_connection.reject.completed",
        subjectId: REQUEST,
        userId: "admin",
      },
    ]);
  });

  it("records a revoke on the connection", async () => {
    h.revokeReturning.mockResolvedValue([
      { id: CONNECTION, displayName: "Synap CRM", clientId: "crm" },
    ]);
    await as("admin").revokeConnection({ id: CONNECTION });
    expect(recorded()).toEqual([
      {
        type: "application_connection.revoke.completed",
        subjectId: CONNECTION,
        userId: "admin",
        workspaceId: null,
        data: { displayName: "Synap CRM", clientId: "crm" },
      },
    ]);
  });

  it("records nothing when the act fails", async () => {
    h.reject.mockRejectedValue(new Error("no longer pending"));
    await expect(
      as("admin").rejectRequest({ requestId: REQUEST, reason: "Not ours" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    h.revokeReturning.mockResolvedValue([]);
    await expect(
      as("admin").revokeConnection({ id: CONNECTION })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.auditLog).not.toHaveBeenCalled();
  });
});
