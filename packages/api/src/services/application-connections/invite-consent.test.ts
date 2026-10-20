/**
 * The invite is the consent: which requests are linked without an owner, and
 * which stay pending. Driven through `approveByInviteIfConsented` with its
 * reads and writes injected, so each case names the ONE condition it breaks.
 *
 * NOT COVERED here: the invite query itself (too old, another member, a
 * workspace invite: `invite-acceptance.pglite.test.ts` in @synap/database),
 * the start handler that writes `requesterAccount`
 * (`federation-application-connections.test.ts`), and the revoke procedure
 * (`application-connections.requester-account.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", () => ({
  FederatedApplicationConnectionService: class {},
  TrustedIssuerService: class {},
  findOpenPodInviteAcceptance: vi.fn(),
  db: {},
  and: vi.fn(),
  eq: vi.fn(),
  users: {},
  federatedApplicationConnections: {},
  trustedIssuers: {},
}));
vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: { create: vi.fn() },
}));
vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: vi.fn(),
}));

import {
  approveByInviteIfConsented,
  INVITE_LINKED_NOTIFICATION_TYPE,
  type InviteConsentDeps,
} from "./invite-consent.js";
import { readInviteApproval } from "../../utils/application-connection.js";

const NOW = new Date("2026-10-19T20:00:00Z");
const ISSUER = "https://api.synap.live";
const ORIGIN = "https://studio.synap.live";

const verifiedAccount = {
  verifiedEmail: "ada@example.test",
  verifiedAt: "2026-10-19T19:59:00.000Z",
  issuerUrl: ISSUER,
  vouchedOrigin: ORIGIN,
};

function request(over: Record<string, unknown> = {}) {
  return {
    id: "6f1c9a52-6d1b-4f38-9a3c-1b2f8f5b2a10",
    status: "pending",
    requestedByUserId: "member-1",
    requestedScopes: ["auth:exchange-user", "identity:link-user"],
    issuerUrl: ISSUER,
    requestedOrigin: ORIGIN,
    clientId: "studio",
    displayName: "Studio",
    requestMetadata: {
      requestedVia: "browser-pod-admin-handoff",
      requesterAccount: verifiedAccount,
    },
    ...over,
  } as unknown as Parameters<typeof approveByInviteIfConsented>[0];
}

function deps(over: Partial<InviteConsentDeps> = {}) {
  const d = {
    issuerStatus: vi.fn().mockResolvedValue("approved"),
    appConnection: vi.fn().mockResolvedValue({
      status: "approved",
      allowedOrigins: [ORIGIN],
      allowedScopes: ["auth:exchange-user", "identity:link-user"],
    }),
    findInvite: vi.fn().mockResolvedValue({
      inviteId: "invite-1",
      userId: "member-1",
      inviteType: "pod",
      invitedEmail: "ada@example.test",
      invitedBy: "owner-1",
      inviteExpiresAt: new Date(NOW.getTime() + 86_400_000),
      acceptedAt: new Date("2026-10-18T10:00:00Z"),
    }),
    approve: vi.fn().mockResolvedValue({ connection: { id: "connection-1" } }),
    recipients: vi.fn().mockResolvedValue(["owner-1", "admin-2"]),
    memberName: vi.fn().mockResolvedValue("Ada"),
    notify: vi.fn().mockResolvedValue("notification-id"),
    now: () => NOW,
    ...over,
  };
  return d as typeof d & InviteConsentDeps;
}

describe("approveByInviteIfConsented", () => {
  it("links a verified account with an open invite, and tells every owner", async () => {
    const d = deps();
    await expect(approveByInviteIfConsented(request(), d)).resolves.toEqual({
      kind: "approved",
      inviteId: "invite-1",
      invitedBy: "owner-1",
      connectionId: "connection-1",
    });

    // The same door as an owner's approval, the invite as reviewer of record.
    expect(d.approve).toHaveBeenCalledTimes(1);
    const input = vi.mocked(d.approve).mock.calls[0]![0];
    expect(input).toMatchObject({
      requestId: request().id,
      reviewerUserId: "owner-1",
    });
    expect(readInviteApproval(input.approvalMetadata)).toEqual({
      inviteId: "invite-1",
      inviteAcceptedAt: "2026-10-18T10:00:00.000Z",
      approvedAt: NOW.toISOString(),
    });
    expect(d.findInvite).toHaveBeenCalledWith({
      userId: "member-1",
      email: "ada@example.test",
      now: NOW,
    });

    expect(vi.mocked(d.notify).mock.calls.map(([n]) => n.userId)).toEqual([
      "owner-1",
      "admin-2",
    ]);
    expect(d.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: INVITE_LINKED_NOTIFICATION_TYPE,
        sourceId: "connection-1",
        data: {
          email: "ada@example.test",
          memberName: "Ada",
          appName: "Studio",
        },
      })
    );
  });

  it.each([
    [
      "an unverified account",
      { requestMetadata: { requestedVia: "browser-pod-admin-handoff" } },
      "unverified",
    ],
    [
      "an account verified by another issuer",
      { issuerUrl: "https://other-issuer.example" },
      "unverified",
    ],
    [
      "an origin the issuer did not vouch for",
      { requestedOrigin: "https://evil.example" },
      "origin_not_vouched",
    ],
    [
      "an origin-only request",
      { requestedScopes: ["auth:exchange-user"] },
      "not_an_account_link",
    ],
    ["a request no longer pending", { status: "rejected" }, "not_pending"],
  ])("leaves %s pending for an owner", async (_label, over, reason) => {
    const d = deps();
    await expect(approveByInviteIfConsented(request(over), d)).resolves.toEqual(
      { kind: "owner_review", reason }
    );
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it.each([
    ["an app an owner revoked", { status: "revoked", allowedOrigins: [ORIGIN], allowedScopes: ["auth:exchange-user", "identity:link-user"] }],
    ["an app no owner approved yet", null],
    ["an origin the owner did not approve", { status: "approved", allowedOrigins: ["https://other.example"], allowedScopes: ["auth:exchange-user", "identity:link-user"] }],
    ["a scope the owner did not approve", { status: "approved", allowedOrigins: [ORIGIN], allowedScopes: ["identity:link-user"] }],
  ])("never approves the APP: %s waits for an owner", async (_label, app) => {
    const d = deps({ appConnection: vi.fn().mockResolvedValue(app) });
    await expect(approveByInviteIfConsented(request(), d)).resolves.toEqual({
      kind: "owner_review",
      reason: "app_not_approved",
    });
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("leaves it pending when the issuer is no longer approved", async () => {
    const d = deps({ issuerStatus: vi.fn().mockResolvedValue("revoked") });
    await expect(approveByInviteIfConsented(request(), d)).resolves.toEqual({
      kind: "owner_review",
      reason: "issuer_not_approved",
    });
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("leaves it pending without an open invite (too old, or another member's)", async () => {
    const d = deps({ findInvite: vi.fn().mockResolvedValue(null) });
    await expect(approveByInviteIfConsented(request(), d)).resolves.toEqual({
      kind: "owner_review",
      reason: "no_open_invite",
    });
    expect(d.approve).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("waits for an owner when a check fails, instead of failing the sign-in", async () => {
    const d = deps({
      findInvite: vi.fn().mockRejectedValue(new Error("db down")),
    });
    await expect(approveByInviteIfConsented(request(), d)).resolves.toEqual({
      kind: "owner_review",
      reason: "check_failed",
    });
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("keeps the link when telling the owners fails", async () => {
    const d = deps({ notify: vi.fn().mockRejectedValue(new Error("bell")) });
    await expect(
      approveByInviteIfConsented(request(), d)
    ).resolves.toMatchObject({ kind: "approved" });
  });
});
