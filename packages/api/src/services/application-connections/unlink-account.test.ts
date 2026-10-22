/**
 * "Unlink {email}": one person's link to one issuer goes, with their Cloud
 * sign-in credential when that issuer is this Pod's Cloud sign-in; the app
 * connection is only ever READ. Driven with injected reads and writes.
 *
 * NOT COVERED here: the SQL that removes only that row
 * (`unlink-federated-identity.pglite.test.ts` in @synap/database) and the Pod
 * Admin procedure's owner check (`podAdminProcedure`).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/auth", () => ({ kratosAdmin: {} }));
vi.mock("../../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPodAdminRole: vi.fn(),
}));
vi.mock("@synap/database", () => ({
  db: {},
  eq: vi.fn(),
  federatedApplicationConnections: {},
  podSettings: {},
  trustedIssuers: {},
  unlinkFederatedIdentity: vi.fn(),
  users: {},
}));

import {
  unlinkConnectionAccount,
  unlinkReach,
  type UnlinkAccountDeps,
} from "./unlink-account.js";

const CLOUD = "https://api.synap.live";

function deps(over: Partial<UnlinkAccountDeps> = {}) {
  const d = {
    connection: vi.fn().mockResolvedValue({
      issuerId: "issuer-1",
      issuerUrl: CLOUD,
      displayName: "Studio",
      clientId: "studio",
    }),
    unlink: vi.fn().mockResolvedValue({ issuerSubject: "cp-ada" }),
    cloudSignInIssuer: vi.fn().mockResolvedValue(CLOUD),
    detachCloudSignIn: vi.fn().mockResolvedValue(true),
    endSessions: vi.fn().mockResolvedValue(true),
    email: vi.fn().mockResolvedValue("ada@example.test"),
    // The caller is the owner; everyone else is a plain member.
    podAdminRole: vi.fn(async (userId: string) =>
      userId === "owner" ? ("owner" as const) : null
    ),
    ...over,
  };
  return d as typeof d & UnlinkAccountDeps;
}

describe("unlinkConnectionAccount", () => {
  it("removes that person's link and their Cloud sign-in, nothing else", async () => {
    const d = deps();
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-1", userId: "ada", actorUserId: "owner" },
        d
      )
    ).resolves.toEqual({
      status: "unlinked",
      email: "ada@example.test",
      app: { displayName: "Studio", clientId: "studio" },
      signIn: "removed",
    });
    // Exactly one link: this issuer, this person.
    expect(d.unlink).toHaveBeenCalledTimes(1);
    expect(d.unlink).toHaveBeenCalledWith({
      issuerId: "issuer-1",
      userId: "ada",
    });
    expect(d.detachCloudSignIn).toHaveBeenCalledWith({
      kratosIdentityId: "ada",
      subject: "cp-ada",
    });
    // The app connection is read to find its issuer, never written: the
    // deps have no connection write at all, and the read ran once.
    expect(d.connection).toHaveBeenCalledTimes(1);
  });

  it("leaves another issuer's sign-in credential alone", async () => {
    const d = deps({
      connection: vi.fn().mockResolvedValue({
        issuerId: "issuer-2",
        issuerUrl: "https://other-issuer.example",
        displayName: "Other",
        clientId: "other",
      }),
    });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-2", userId: "ada", actorUserId: "owner" },
        d
      )
    ).resolves.toMatchObject({ status: "unlinked", signIn: "not_applicable" });
    expect(d.detachCloudSignIn).not.toHaveBeenCalled();
  });

  it("tells the owner when the sign-in credential could not be removed", async () => {
    const d = deps({ detachCloudSignIn: vi.fn().mockResolvedValue(false) });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-1", userId: "ada", actorUserId: "owner" },
        d
      )
    ).resolves.toMatchObject({ status: "unlinked", signIn: "failed" });
  });

  it("ends the person's live sessions once the credential is gone", async () => {
    const d = deps();
    await unlinkConnectionAccount(
      { connectionId: "conn-1", userId: "ada", actorUserId: "owner" },
      d
    );
    expect(d.endSessions).toHaveBeenCalledWith("ada");
    // Credential first: ending sessions while it stands lets them sign back in.
    expect(d.detachCloudSignIn.mock.invocationCallOrder[0]).toBeLessThan(
      d.endSessions.mock.invocationCallOrder[0]!
    );
  });

  it("tells the owner when the sessions could not be ended", async () => {
    const d = deps({ endSessions: vi.fn().mockResolvedValue(false) });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-1", userId: "ada", actorUserId: "owner" },
        d
      )
    ).resolves.toMatchObject({ status: "unlinked", signIn: "failed" });
  });

  it("leaves sessions alone when the credential could not be removed or is not Cloud's", async () => {
    const failed = deps({
      detachCloudSignIn: vi.fn().mockResolvedValue(false),
    });
    await unlinkConnectionAccount(
      { connectionId: "conn-1", userId: "ada", actorUserId: "owner" },
      failed
    );
    expect(failed.endSessions).not.toHaveBeenCalled();
    const other = deps({
      connection: vi.fn().mockResolvedValue({
        issuerId: "issuer-2",
        issuerUrl: "https://other.example",
        displayName: "Elsewhere",
        clientId: "elsewhere",
      }),
    });
    await unlinkConnectionAccount(
      { connectionId: "conn-2", userId: "ada", actorUserId: "owner" },
      other
    );
    expect(other.endSessions).not.toHaveBeenCalled();
  });

  it("says when the person was not linked, and touches no credential", async () => {
    const d = deps({ unlink: vi.fn().mockResolvedValue(null) });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-1", userId: "bob", actorUserId: "owner" },
        d
      )
    ).resolves.toEqual({ status: "not_linked" });
    expect(d.detachCloudSignIn).not.toHaveBeenCalled();
  });

  it("refuses an unknown connection before unlinking anyone", async () => {
    const d = deps({ connection: vi.fn().mockResolvedValue(null) });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "nope", userId: "ada", actorUserId: "owner" },
        d
      )
    ).resolves.toEqual({ status: "no_connection" });
    expect(d.unlink).not.toHaveBeenCalled();
  });

  it("an admin can never unlink the owner: nothing is removed", async () => {
    const d = deps({
      podAdminRole: vi.fn(async (userId: string) =>
        userId === "owner" ? ("owner" as const) : ("admin" as const)
      ),
    });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-1", userId: "owner", actorUserId: "admin-1" },
        d
      )
    ).resolves.toEqual({ status: "outranked" });
    expect(d.unlink).not.toHaveBeenCalled();
    expect(d.detachCloudSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["the owner, an admin", "owner", "owner", "admin"],
    ["an admin, another admin", "admin", "admin", "admin"],
    ["an admin, a member", "admin", "admin", null],
  ] as const)("%s: allowed", async (_label, actor, actorRole, targetRole) => {
    const d = deps({
      podAdminRole: vi.fn(async (userId: string) =>
        userId === actor ? actorRole : targetRole
      ),
    });
    await expect(
      unlinkConnectionAccount(
        { connectionId: "conn-1", userId: "target", actorUserId: actor },
        d
      )
    ).resolves.toMatchObject({ status: "unlinked" });
  });
});

describe("unlinkReach — what the confirm says goes with it", () => {
  const connection = {
    id: "conn-1",
    issuerId: "issuer-1",
    issuerUrl: CLOUD,
  };

  it("names the issuer's OTHER approved apps and Cloud sign-in", async () => {
    const sameIssuerApps = vi.fn().mockResolvedValue([
      { id: "conn-1", displayName: "Studio", status: "approved" },
      { id: "conn-2", displayName: "CRM", status: "approved" },
      { id: "conn-3", displayName: "Old app", status: "revoked" },
    ]);
    await expect(
      unlinkReach(connection, {
        sameIssuerApps,
        cloudSignInIssuer: vi.fn().mockResolvedValue(`${CLOUD}/`),
      })
    ).resolves.toEqual({
      otherApps: [{ id: "conn-2", displayName: "CRM" }],
      cloudSignIn: true,
    });
    // The apps are read for THIS connection's issuer.
    expect(sameIssuerApps).toHaveBeenCalledWith("issuer-1");
  });

  it("another issuer's app takes no Cloud sign-in with it", async () => {
    await expect(
      unlinkReach(
        { ...connection, issuerUrl: "https://other-issuer.example" },
        {
          sameIssuerApps: vi.fn().mockResolvedValue([]),
          cloudSignInIssuer: vi.fn().mockResolvedValue(CLOUD),
        }
      )
    ).resolves.toEqual({ otherApps: [], cloudSignIn: false });
  });
});
