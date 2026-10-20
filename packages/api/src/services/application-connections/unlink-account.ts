/**
 * "Unlink {email}" — take ONE person's Synap account off this Pod, from the
 * app's page in Pod Admin (founder, 2026-10-19). The way back from an
 * invite-approved link, and from any other.
 *
 * What it removes, and only that:
 *  - the person's federated identity link for the app's issuer
 *    (`unlinkFederatedIdentity`, the one door, `(issuer, user)` only);
 *  - the matching "Continue with Synap Cloud" sign-in credential on their
 *    Kratos identity, when the issuer is this Pod's Cloud sign-in issuer —
 *    without it the link row alone would come back on their next sign-in.
 * What it never touches: the app connection (every other member keeps the
 * app), the issuer, the person's Pod account, memberships or password.
 *
 * The Control Plane is NOT told. It may still list this Pod in the person's
 * Synap account (its access projection, `pod_user_relationships`), and no
 * Pod → CP path exists to withdraw it: the invite lifecycle notice
 * (`notifyCpInviteLifecycle`) is keyed by invite token and moves invites, not
 * identity links. Signing in through the app now fails on the Pod side, which
 * holds the authority.
 */

import { kratosAdmin } from "@synap/auth";
import {
  db,
  eq,
  federatedApplicationConnections,
  podSettings,
  trustedIssuers,
  unlinkFederatedIdentity,
  users,
} from "@synap/database";
import { normalizeIssuerUrl } from "../../utils/issuer-url-safety.js";

/** The Kratos OIDC provider id of Synap Cloud sign-in (`kratos/oidc.cp.jsonnet`). */
const CP_OIDC_PROVIDER = "cp";

export type UnlinkAccountOutcome =
  | {
      status: "unlinked";
      email: string | null;
      /** The app, named for its timeline. */
      app: { displayName: string; clientId: string };
      /**
       * `removed` / `not_applicable` (another issuer) / `failed`: the link is
       * gone, but their Cloud sign-in credential could not be removed, so the
       * owner is told rather than shown a clean success.
       */
      signIn: "removed" | "not_applicable" | "failed";
    }
  | { status: "not_linked" }
  | { status: "no_connection" };

export interface UnlinkAccountDeps {
  connection(id: string): Promise<{
    issuerId: string;
    issuerUrl: string;
    displayName: string;
    clientId: string;
  } | null>;
  unlink(input: {
    issuerId: string;
    userId: string;
  }): Promise<{ issuerSubject: string } | null>;
  cloudSignInIssuer(): Promise<string | null>;
  detachCloudSignIn(input: {
    kratosIdentityId: string;
    subject: string;
  }): Promise<boolean>;
  email(userId: string): Promise<string | null>;
}

const defaultDeps: UnlinkAccountDeps = {
  connection: async (id) => {
    const [row] = await db
      .select({
        issuerId: federatedApplicationConnections.issuerId,
        issuerUrl: trustedIssuers.issuerUrl,
        displayName: federatedApplicationConnections.displayName,
        clientId: federatedApplicationConnections.clientId,
      })
      .from(federatedApplicationConnections)
      .innerJoin(
        trustedIssuers,
        eq(federatedApplicationConnections.issuerId, trustedIssuers.id)
      )
      .where(eq(federatedApplicationConnections.id, id))
      .limit(1);
    return row ?? null;
  },
  unlink: (input) => unlinkFederatedIdentity(input),
  cloudSignInIssuer: async () => {
    const [row] = await db
      .select({ settings: podSettings.settings })
      .from(podSettings)
      .orderBy(podSettings.createdAt)
      .limit(1);
    return row?.settings?.federationOidcClient?.issuer ?? null;
  },
  detachCloudSignIn: async ({ kratosIdentityId, subject }) => {
    try {
      await kratosAdmin.deleteIdentityCredentials({
        id: kratosIdentityId,
        type: "oidc",
        identifier: `${CP_OIDC_PROVIDER}:${subject}`,
      });
      return true;
    } catch (error) {
      // Already gone is the outcome we wanted.
      const status = (error as { response?: { status?: number } }).response
        ?.status;
      return status === 404;
    }
  },
  email: async (userId) =>
    (
      await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { email: true },
      })
    )?.email ?? null,
};

export async function unlinkConnectionAccount(
  input: { connectionId: string; userId: string },
  deps: UnlinkAccountDeps = defaultDeps
): Promise<UnlinkAccountOutcome> {
  const connection = await deps.connection(input.connectionId);
  if (!connection) return { status: "no_connection" };
  const removed = await deps.unlink({
    issuerId: connection.issuerId,
    userId: input.userId,
  });
  if (!removed) return { status: "not_linked" };

  const cloudIssuer = await deps.cloudSignInIssuer();
  const isCloudSignIn =
    cloudIssuer !== null &&
    normalizeIssuerUrl(cloudIssuer) === normalizeIssuerUrl(connection.issuerUrl);
  const signIn = isCloudSignIn
    ? (await deps.detachCloudSignIn({
        kratosIdentityId: input.userId,
        subject: removed.issuerSubject,
      }))
      ? "removed"
      : "failed"
    : "not_applicable";

  return {
    status: "unlinked",
    email: await deps.email(input.userId),
    app: { displayName: connection.displayName, clientId: connection.clientId },
    signIn,
  };
}
