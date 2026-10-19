/**
 * Pod Admin names the account that will receive access. The start handler
 * (`apps/api` federation.ts) stores `request_metadata.requesterAccount` only
 * after verifying the issuer's assertion; this drives the stored row through
 * the real `getReviewRequest` projection, so deleting the projection line —
 * or showing an unverified record as verified — fails here.
 *
 * NOT COVERED: the start handler (federation-application-connections.test.ts)
 * and the page wording (pod-admin `_lib/requester-account.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getRequest: vi.fn(),
  memberRole: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        workspaces: { findFirst: async () => ({ id: "pod-admin-ws" }) },
        workspaceMembers: {
          findFirst: async () => ({ role: h.memberRole() }),
        },
        federatedApplicationConnections: { findFirst: async () => null },
      },
    },
    FederatedApplicationConnectionService: class {
      getRequest = h.getRequest;
    },
  };
});
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => true,
}));

import { applicationConnectionsRouter } from "./application-connections.js";
import { requesterAccountView } from "../utils/application-connection.js";
import type { Context } from "../types/context.js";

const REQUEST = "6f1c9a52-6d1b-4f38-9a3c-1b2f8f5b2a10";
const VERIFIED = {
  verifiedEmail: "ada@example.test",
  verifiedAt: "2026-10-19T20:00:00.000Z",
  issuerUrl: "https://api.synap.live",
};
const row = (requestMetadata: unknown) => ({
  id: REQUEST,
  issuerUrl: "https://api.synap.live",
  issuerSubject: "cp-user-opaque-id",
  clientId: "studio",
  displayName: "Studio",
  publisherUrl: null,
  requestedOrigin: "https://studio.synap.live",
  requestedCallbackUrl: "https://studio.synap.live/login",
  requestedScopes: ["auth:exchange-user", "identity:link-user"],
  status: "pending",
  decisionReason: null,
  expiresAt: new Date(Date.now() + 60_000),
  reviewedAt: null,
  requestedByUserId: "pod-user-1",
  requestMetadata,
});
const review = (userId = "owner") =>
  applicationConnectionsRouter
    .createCaller({
      authenticated: true,
      userId,
      session: { id: "s" },
    } as unknown as Context)
    .getReviewRequest({ requestId: REQUEST });

beforeEach(() => {
  h.getRequest.mockReset();
  h.memberRole.mockReset().mockReturnValue("owner");
});

describe("getReviewRequest — the account that will receive access", () => {
  it("shows the verified email and the issuer host, never the raw subject", async () => {
    h.getRequest.mockResolvedValue(
      row({
        requestedVia: "browser-pod-admin-handoff",
        requesterAccount: VERIFIED,
      })
    );
    const data = await review();
    expect(data.requesterAccount).toEqual({
      status: "verified",
      email: "ada@example.test",
      issuerHost: "api.synap.live",
      verifiedAt: VERIFIED.verifiedAt,
    });
    expect(JSON.stringify(data)).not.toContain("cp-user-opaque-id");
  });

  it("says Not verified when the start carried no verified account", async () => {
    h.getRequest.mockResolvedValue(
      row({ requestedVia: "browser-pod-admin-handoff" })
    );
    expect((await review()).requesterAccount).toEqual({
      status: "unverified",
    });
    h.getRequest.mockResolvedValue(row(null));
    expect((await review()).requesterAccount).toEqual({
      status: "unverified",
    });
  });

  it("keeps the account from a member who may not review", async () => {
    h.memberRole.mockReturnValue("member");
    h.getRequest.mockResolvedValue({
      ...row({ requesterAccount: VERIFIED }),
      requestedByUserId: "member",
    });
    expect((await review("member")).requesterAccount).toBeNull();
  });
});

describe("requesterAccountView", () => {
  it.each([
    ["no email", { ...VERIFIED, verifiedEmail: undefined }],
    ["not an email", { ...VERIFIED, verifiedEmail: "ada" }],
    ["no time", { ...VERIFIED, verifiedAt: "soon" }],
    ["no issuer", { ...VERIFIED, issuerUrl: "not a url" }],
    ["not an object", "ada@example.test"],
  ])("reads a malformed record (%s) as unverified", (_label, record) => {
    expect(requesterAccountView({ requesterAccount: record })).toEqual({
      status: "unverified",
    });
  });
});
