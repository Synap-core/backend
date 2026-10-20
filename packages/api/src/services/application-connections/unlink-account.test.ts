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
    email: vi.fn().mockResolvedValue("ada@example.test"),
    ...over,
  };
  return d as typeof d & UnlinkAccountDeps;
}

describe("unlinkConnectionAccount", () => {
  it("removes that person's link and their Cloud sign-in, nothing else", async () => {
    const d = deps();
    await expect(
      unlinkConnectionAccount({ connectionId: "conn-1", userId: "ada" }, d)
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
      unlinkConnectionAccount({ connectionId: "conn-2", userId: "ada" }, d)
    ).resolves.toMatchObject({ status: "unlinked", signIn: "not_applicable" });
    expect(d.detachCloudSignIn).not.toHaveBeenCalled();
  });

  it("tells the owner when the sign-in credential could not be removed", async () => {
    const d = deps({ detachCloudSignIn: vi.fn().mockResolvedValue(false) });
    await expect(
      unlinkConnectionAccount({ connectionId: "conn-1", userId: "ada" }, d)
    ).resolves.toMatchObject({ status: "unlinked", signIn: "failed" });
  });

  it("says when the person was not linked, and touches no credential", async () => {
    const d = deps({ unlink: vi.fn().mockResolvedValue(null) });
    await expect(
      unlinkConnectionAccount({ connectionId: "conn-1", userId: "bob" }, d)
    ).resolves.toEqual({ status: "not_linked" });
    expect(d.detachCloudSignIn).not.toHaveBeenCalled();
  });

  it("refuses an unknown connection before unlinking anyone", async () => {
    const d = deps({ connection: vi.fn().mockResolvedValue(null) });
    await expect(
      unlinkConnectionAccount({ connectionId: "nope", userId: "ada" }, d)
    ).resolves.toEqual({ status: "no_connection" });
    expect(d.unlink).not.toHaveBeenCalled();
  });
});
