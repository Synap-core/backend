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
 * Its reach is the ISSUER, not the app: the link and the Cloud credential are
 * one per (issuer, person), so the person also stops signing in through every
 * other app of that issuer and, for the Cloud issuer, through "Continue with
 * Synap Cloud" on desktop and phone. A connection owns no per-person state to
 * narrow it to. `unlinkReach` names that reach, so the confirm can say it
 * before anything happens.
 *
 * Who may do it: a pod admin, on anyone their pod-admin role does not rank
 * below (`podAdminRoleOutranks`). An admin can never take the OWNER's sign-in
 * away; on a pod whose owner signs in only through Synap Cloud that would lock
 * the owner out.
 *
 * The Control Plane is NOT told. It may still list this Pod in the person's
 * Synap account (its access projection, `pod_user_relationships`), and no
 * Pod → CP path exists to withdraw it: the invite lifecycle notice
 * (`notifyCpInviteLifecycle`) is keyed by invite token and moves invites, not
 * identity links. Signing in through the app now fails on the Pod side, which
 * holds the authority.
 */

import {
  courierStatus,
  kratosAdmin,
  kratosIdentityHasPodHeldCredential,
} from "@synap/auth";
import {
  AccountRecoveryCodeRepository,
  db,
  eq,
  federatedApplicationConnections,
  podSettings,
  trustedIssuers,
  unlinkFederatedIdentity,
  users,
} from "@synap/database";
import { normalizeIssuerUrl } from "../../utils/issuer-url-safety.js";
import {
  getPodAdminRole,
  podAdminRoleOutranks,
  type PodAdminRole,
} from "../../utils/workspace-role.js";

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
  | { status: "no_connection" }
  /** The person's pod-admin role is above the caller's (the owner). */
  | { status: "outranked" };

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
  podAdminRole(userId: string): Promise<PodAdminRole | null>;
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
  podAdminRole: getPodAdminRole,
};

/** Is `issuerUrl` this Pod's Synap Cloud sign-in issuer? */
function isCloudSignInIssuer(
  cloudIssuer: string | null,
  issuerUrl: string
): boolean {
  return (
    cloudIssuer !== null &&
    normalizeIssuerUrl(cloudIssuer) === normalizeIssuerUrl(issuerUrl)
  );
}

export interface UnlinkReach {
  /** The other apps of the same issuer the person also stops signing in to. */
  otherApps: Array<{ id: string; displayName: string }>;
  /** Whether "Continue with Synap Cloud" goes too (the Cloud issuer). */
  cloudSignIn: boolean;
}

export interface UnlinkReachDeps {
  sameIssuerApps(
    issuerId: string
  ): Promise<Array<{ id: string; displayName: string; status: string }>>;
  cloudSignInIssuer(): Promise<string | null>;
}

const defaultReachDeps: UnlinkReachDeps = {
  sameIssuerApps: (issuerId) =>
    db
      .select({
        id: federatedApplicationConnections.id,
        displayName: federatedApplicationConnections.displayName,
        status: federatedApplicationConnections.status,
      })
      .from(federatedApplicationConnections)
      .where(eq(federatedApplicationConnections.issuerId, issuerId)),
  cloudSignInIssuer: defaultDeps.cloudSignInIssuer,
};

/**
 * What unlinking one person from `connection` takes away besides this app:
 * every other approved app of its issuer, and Cloud sign-in when its issuer is
 * the Cloud issuer. Read for the confirm, before anything happens.
 */
export async function unlinkReach(
  connection: { id: string; issuerId: string; issuerUrl: string },
  deps: UnlinkReachDeps = defaultReachDeps
): Promise<UnlinkReach> {
  const [apps, cloudIssuer] = await Promise.all([
    deps.sameIssuerApps(connection.issuerId),
    deps.cloudSignInIssuer(),
  ]);
  return {
    otherApps: apps
      .filter((app) => app.id !== connection.id && app.status === "approved")
      .map(({ id, displayName }) => ({ id, displayName })),
    cloudSignIn: isCloudSignInIssuer(cloudIssuer, connection.issuerUrl),
  };
}

/**
 * What one person is left to sign in with once unlinked, for the confirm —
 * read before anything happens, never guessed:
 *  - `keeps_a_way_in`: the unlink takes no sign-in method (another issuer), or
 *    they hold a password or passkey on this Pod, or an unused recovery code
 *    (account recovery's "pod-held factor");
 *  - `email_recovery_only`: none of those, but this Pod's mail goes out, so
 *    recovering the account by email still gets them back in;
 *  - `no_way_in`: none of those, and no mail: they cannot sign in at all;
 *  - `unknown`: a read failed. The confirm says it could not check.
 */
export type UnlinkImpact =
  "keeps_a_way_in" | "email_recovery_only" | "no_way_in" | "unknown";

export interface UnlinkImpactDeps {
  /** Throws on a failed read (`kratosIdentityHasPodHeldCredential`). */
  podHeldCredential(kratosIdentityId: string): Promise<boolean>;
  /** Throws on a failed read (`AccountRecoveryCodeRepository`). */
  unusedRecoveryCodes(userId: string): Promise<number>;
  /** The same fact as account recovery's "Email me a code" door. */
  emailRecovery(): boolean;
}

const defaultImpactDeps: UnlinkImpactDeps = {
  podHeldCredential: (kratosIdentityId) =>
    kratosIdentityHasPodHeldCredential(kratosIdentityId),
  unusedRecoveryCodes: async (userId) =>
    (await new AccountRecoveryCodeRepository(db).summary(userId)).remaining,
  emailRecovery: () => courierStatus().status === "configured",
};

/**
 * `UnlinkImpact` for each of `userIds` when unlinked from a connection with
 * `reach`. Only the Cloud issuer takes a sign-in method away (its Kratos
 * credential); any other issuer is answered without a read.
 */
export async function unlinkImpacts(
  userIds: readonly string[],
  reach: Pick<UnlinkReach, "cloudSignIn">,
  deps: UnlinkImpactDeps = defaultImpactDeps
): Promise<Map<string, UnlinkImpact>> {
  if (!reach.cloudSignIn) {
    return new Map(userIds.map((id) => [id, "keeps_a_way_in" as const]));
  }
  const emailRecovery = deps.emailRecovery();
  const impacts = await Promise.all(
    userIds.map(async (userId): Promise<[string, UnlinkImpact]> => {
      try {
        // The Pod's user id IS the Kratos identity id (`unlinkConnectionAccount`).
        const [credential, codes] = await Promise.all([
          deps.podHeldCredential(userId),
          deps.unusedRecoveryCodes(userId),
        ]);
        if (credential || codes > 0) return [userId, "keeps_a_way_in"];
        return [userId, emailRecovery ? "email_recovery_only" : "no_way_in"];
      } catch {
        return [userId, "unknown"];
      }
    })
  );
  return new Map(impacts);
}

export async function unlinkConnectionAccount(
  input: { connectionId: string; userId: string; actorUserId: string },
  deps: UnlinkAccountDeps = defaultDeps
): Promise<UnlinkAccountOutcome> {
  const connection = await deps.connection(input.connectionId);
  if (!connection) return { status: "no_connection" };
  const [targetRole, actorRole] = await Promise.all([
    deps.podAdminRole(input.userId),
    deps.podAdminRole(input.actorUserId),
  ]);
  if (podAdminRoleOutranks(targetRole, actorRole)) {
    return { status: "outranked" };
  }
  const removed = await deps.unlink({
    issuerId: connection.issuerId,
    userId: input.userId,
  });
  if (!removed) return { status: "not_linked" };

  const signIn = isCloudSignInIssuer(
    await deps.cloudSignInIssuer(),
    connection.issuerUrl
  )
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
