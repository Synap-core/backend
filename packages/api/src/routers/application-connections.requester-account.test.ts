/**
 * Pod Admin names the account that will receive access and the member it will
 * sign in as. The start handler (`apps/api` federation.ts) stores
 * `request_metadata.requesterAccount` only after verifying the issuer's
 * assertion; this drives the stored row through the real `getReviewRequest`
 * projection, so deleting a projection line — or showing an unverified
 * record as verified — fails here. It also drives `redeemRequest` into the
 * invite-consent rule, and `unlinkAccount` (the undo, one person) without
 * revoking the app connection.
 *
 * NOT COVERED: the start handler (federation-application-connections.test.ts),
 * the rule's own conditions (`invite-consent.test.ts`) and the page wording
 * (pod-admin `_lib/requester-account.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getRequest: vi.fn(),
  redeemRequest: vi.fn(),
  memberRole: vi.fn(),
  member: vi.fn(),
  issuer: vi.fn(),
  consent: vi.fn(),
  unlink: vi.fn(),
  auditLog: vi.fn(),
  revokeSet: vi.fn(),
  revokeReturning: vi.fn(),
  endDevices: vi.fn(),
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
        users: { findFirst: async () => h.member() },
      },
      update: () => ({
        set: (values: unknown) => {
          h.revokeSet(values);
          return { where: () => ({ returning: h.revokeReturning }) };
        },
      }),
    },
    FederatedApplicationConnectionService: class {
      getRequest = h.getRequest;
      redeemRequest = h.redeemRequest;
    },
    TrustedIssuerService: class {
      getByUrl = h.issuer;
    },
  };
});
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => true,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: h.auditLog }));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("@synap/database/person-devices", () => ({
  revokeAllPersonDevices: h.endDevices,
}));
vi.mock("../services/application-connections/invite-consent.js", () => ({
  approveByInviteIfConsented: h.consent,
}));
vi.mock("../services/application-connections/unlink-account.js", () => ({
  unlinkConnectionAccount: h.unlink,
}));

import { applicationConnectionsRouter } from "./application-connections.js";
import { requesterAccountView } from "../utils/application-connection.js";
import { getNotificationDef } from "../notifications/registry.js";
import type { Context } from "../types/context.js";

const REQUEST = "6f1c9a52-6d1b-4f38-9a3c-1b2f8f5b2a10";
const CONNECTION = "0b8e0c55-0f36-4a5e-9d1a-6a3a4c1f7e21";
const VERIFIED = {
  verifiedEmail: "ada@example.test",
  verifiedAt: "2026-10-19T20:00:00.000Z",
  issuerUrl: "https://api.synap.live",
};
const row = (requestMetadata: unknown, over: Record<string, unknown> = {}) => ({
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
  ...over,
});
const as = (userId: string) =>
  applicationConnectionsRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
  } as unknown as Context);
const review = (userId = "owner") =>
  as(userId).getReviewRequest({ requestId: REQUEST });

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.memberRole.mockReturnValue("owner");
  h.member.mockReturnValue({ name: "Ada Lovelace", email: "ada@pod.test" });
  h.issuer.mockResolvedValue({ displayName: "Synap" });
});

describe("getReviewRequest — the account that will receive access", () => {
  it("names the verified email, who verified it, and the member — never the raw subject", async () => {
    h.getRequest.mockResolvedValue(
      row(
        {
          requestedVia: "browser-pod-admin-handoff",
          requesterAccount: VERIFIED,
        },
        { approvedConnectionId: CONNECTION }
      )
    );
    const data = await review();
    // The door to the app's page in Pod Admin.
    expect(data.approvedConnectionId).toBe(CONNECTION);
    expect(data.requesterAccount).toEqual({
      status: "verified",
      email: "ada@example.test",
      issuerHost: "api.synap.live",
      issuerName: "Synap",
      verifiedAt: VERIFIED.verifiedAt,
    });
    expect(data.requesterMember).toEqual({
      name: "Ada Lovelace",
      email: "ada@pod.test",
    });
    expect(data.approvedByInvite).toBe(false);
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

  it("names no account on an origin-only request", async () => {
    h.getRequest.mockResolvedValue(
      row(
        { requesterAccount: VERIFIED },
        { requestedScopes: ["auth:exchange-user"] }
      )
    );
    expect((await review()).requesterAccount).toBeNull();
  });

  it("shows the requester their own account and, once linked, the way back", async () => {
    h.memberRole.mockReturnValue("member");
    h.getRequest.mockResolvedValue(
      row(
        {
          requesterAccount: VERIFIED,
          approvedByInvite: {
            inviteId: "i",
            inviteAcceptedAt: "x",
            approvedAt: "y",
          },
        },
        { requestedByUserId: "member", status: "approved" }
      )
    );
    const data = await review("member");
    expect(data.requesterAccount).toMatchObject({
      status: "verified",
      email: "ada@example.test",
    });
    expect(data.displayName).toBe("Studio");
    expect(data.approvedByInvite).toBe(true);
    expect(data.returnUrl).toBe(
      `https://studio.synap.live/login?connection_request=${REQUEST}`
    );
    expect(data.requesterMember).toBeNull();
  });

  it("keeps the request from a member who neither reviews nor requested it", async () => {
    h.memberRole.mockReturnValue("member");
    h.getRequest.mockResolvedValue({
      ...row({ requesterAccount: VERIFIED }),
      requestedByUserId: "member",
    });
    await expect(review("someone-else")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("redeemRequest — the invite is the consent", () => {
  const SECRET = "a".repeat(40);

  it("asks the rule on the FIRST redeem and says when the invite linked it", async () => {
    h.redeemRequest.mockResolvedValue({
      request: row({ requesterAccount: VERIFIED }),
      firstRedeem: true,
    });
    h.consent.mockResolvedValue({
      kind: "approved",
      inviteId: "invite-1",
      invitedBy: "owner-1",
      connectionId: CONNECTION,
    });

    await expect(
      as("pod-user-1").redeemRequest({
        requestId: REQUEST,
        redemptionSecret: SECRET,
      })
    ).resolves.toEqual({ requestId: REQUEST, linkedByInvite: true });
    expect(h.consent).toHaveBeenCalledTimes(1);
    // The approval is on the app's timeline, by the invite's sender.
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "approve",
        subjectId: CONNECTION,
        userId: "owner-1",
        data: expect.objectContaining({ approvedByInvite: "invite-1" }),
      })
    );
  });

  it("leaves it pending when the rule says an owner decides", async () => {
    h.redeemRequest.mockResolvedValue({ request: row({}), firstRedeem: true });
    h.consent.mockResolvedValue({ kind: "owner_review", reason: "unverified" });
    await expect(
      as("pod-user-1").redeemRequest({
        requestId: REQUEST,
        redemptionSecret: SECRET,
      })
    ).resolves.toEqual({ requestId: REQUEST, linkedByInvite: false });
  });

  it("never re-asks on a refresh redeem", async () => {
    // The service reports the redeem that did NOT move the request.
    h.redeemRequest.mockResolvedValue({ request: row({}), firstRedeem: false });
    await as("pod-user-1").redeemRequest({
      requestId: REQUEST,
      redemptionSecret: SECRET,
    });
    expect(h.consent).not.toHaveBeenCalled();
  });
});

describe("undo after an invite approval — unlink that one person", () => {
  it("the owners' notice is a door to the app's page, never a button that acts", () => {
    const def = getNotificationDef("application_connection.linked_by_invite");
    // The notification's sourceId is the connection id (invite-consent.ts).
    expect(def?.actions?.map((a) => a.handler)).toEqual([
      { type: "navigate-object", kind: "application_connection" },
    ]);
  });

  it("unlinks through the one door and puts it on the app's timeline", async () => {
    h.unlink.mockResolvedValue({
      status: "unlinked",
      email: "ada@example.test",
      app: { displayName: "Studio", clientId: "studio" },
      signIn: "removed",
    });
    await expect(
      as("owner").unlinkAccount({ connectionId: CONNECTION, userId: "ada" })
    ).resolves.toMatchObject({ status: "unlinked" });
    expect(h.unlink).toHaveBeenCalledWith({
      connectionId: CONNECTION,
      userId: "ada",
    });
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "unlink",
        subjectId: CONNECTION,
        userId: "owner",
        data: expect.objectContaining({
          unlinkedUserId: "ada",
          email: "ada@example.test",
        }),
      })
    );
    // The app connection is not revoked; the person's Synap apps sign in again.
    expect(h.revokeSet).not.toHaveBeenCalled();
    expect(h.endDevices).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "ada" })
    );
  });

  it("answers NOT_FOUND for an unknown connection", async () => {
    h.unlink.mockResolvedValue({ status: "no_connection" });
    await expect(
      as("owner").unlinkAccount({ connectionId: CONNECTION, userId: "ada" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.auditLog).not.toHaveBeenCalled();
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
