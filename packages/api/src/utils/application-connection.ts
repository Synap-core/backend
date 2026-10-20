/**
 * Browser application-connection protocol helpers.
 *
 * A Pod owner reviews these values before they become durable. They are not
 * CORS inputs and do not authorize data-plane access: their only job is to
 * bind a federation journey to an exact application callback without an open
 * redirect.
 */

import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9._-]{2,127}$/;

export const APPLICATION_CONNECTION_SCOPES = [
  "auth:exchange-user",
  "identity:link-user",
] as const;

export type ApplicationConnectionScope =
  (typeof APPLICATION_CONNECTION_SCOPES)[number];

export function normalizeApplicationClientId(value: string): string | null {
  const candidate = value.trim();
  return CLIENT_ID_PATTERN.test(candidate) ? candidate : null;
}

function isExplicitLocalDevUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    (host === "localhost" || host === "127.0.0.1" || host === "::1") &&
    url.port.length > 0
  );
}

/**
 * Canonical origin registration. Production origins must be HTTPS. A local
 * browser app is allowed only on an explicit loopback host and port; there is
 * intentionally no wildcard, suffix, or scheme-less registration.
 */
export function normalizeApplicationOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.hostname.includes("*")
    ) {
      return null;
    }
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    const isHttps =
      url.protocol === "https:" && (!isLocal || isExplicitLocalDevUrl(url));
    const isDevHttp = url.protocol === "http:" && isExplicitLocalDevUrl(url);
    if (!isHttps && !isDevHttp) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * A callback may have a path and static query parameters, but must live on the
 * exact origin proposed by the application. A reviewer return carries only a
 * public request correlation; the requester-held continuation stays local.
 */
export function normalizeApplicationCallbackUrl(
  value: string,
  origin: string
): string | null {
  const normalizedOrigin = normalizeApplicationOrigin(origin);
  if (!normalizedOrigin) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.includes("*") ||
      url.origin !== normalizedOrigin
    ) {
      return null;
    }
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    const isHttps =
      url.protocol === "https:" && (!isLocal || isExplicitLocalDevUrl(url));
    const isDevHttp = url.protocol === "http:" && isExplicitLocalDevUrl(url);
    if (!isHttps && !isDevHttp) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePublisherUrl(
  value: string | undefined
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.includes("*")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeApplicationConnectionScopes(
  values: readonly string[]
): ApplicationConnectionScope[] | null {
  const scopes = Array.from(new Set(values));
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope): scope is string =>
        !APPLICATION_CONNECTION_SCOPES.includes(
          scope as ApplicationConnectionScope
        )
    )
  ) {
    return null;
  }
  return scopes as ApplicationConnectionScope[];
}

/** SHA-256 is suitable because protocol secrets are random 256-bit values. */
export function hashOpaqueApplicationConnectionValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOpaqueApplicationConnectionValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A reviewed application may be offered a non-authorizing return link after
 * owner approval. The requester still proves possession of its continuation
 * to poll and complete, so this public correlation id is safe in a URL.
 */
export function buildApplicationConnectionReturnUrl(input: {
  callbackUrl: string;
  requestId: string;
}): string {
  const url = new URL(input.callbackUrl);
  url.searchParams.set("connection_request", input.requestId);
  return url.toString();
}

/**
 * The account a connection request will link, as the Pod verified it when
 * the handoff started: the requesting app sent the issuer's signed
 * identity-link assertion beside its subject commitment, and the Pod checked
 * it against an issuer it had ALREADY approved (`federation.ts`
 * `verifyRequesterAccountHint`). Stored under
 * `request_metadata.requesterAccount`; written by that function only.
 */
export interface VerifiedRequesterAccount {
  verifiedEmail: string;
  /** ISO time the Pod verified the assertion. */
  verifiedAt: string;
  /** The approved issuer that signed it. */
  issuerUrl: string;
  /**
   * The browser origin the issuer admitted for the app (its signed `origin`
   * claim), when it sent one. The "invite is the consent" rule requires it to
   * equal the request's origin.
   */
  vouchedOrigin?: string;
}

/** The verified record as stored, or null when there is none or it is malformed. */
export function readVerifiedRequesterAccount(
  requestMetadata: unknown
): VerifiedRequesterAccount | null {
  const record =
    requestMetadata && typeof requestMetadata === "object"
      ? (requestMetadata as { requesterAccount?: unknown }).requesterAccount
      : undefined;
  if (!record || typeof record !== "object") return null;
  const { verifiedEmail, verifiedAt, issuerUrl, vouchedOrigin } =
    record as Partial<Record<keyof VerifiedRequesterAccount, unknown>>;
  if (
    typeof verifiedEmail !== "string" ||
    !verifiedEmail.includes("@") ||
    typeof verifiedAt !== "string" ||
    Number.isNaN(Date.parse(verifiedAt)) ||
    typeof issuerUrl !== "string"
  ) {
    return null;
  }
  try {
    new URL(issuerUrl);
  } catch {
    return null;
  }
  return {
    verifiedEmail,
    verifiedAt,
    issuerUrl,
    ...(typeof vouchedOrigin === "string" ? { vouchedOrigin } : {}),
  };
}

/**
 * What a reviewer is told about that account. `unverified` covers every
 * request without a verified record — no assertion sent, an unapproved
 * issuer, a signature that failed — because to the reviewer they mean the
 * same thing: nobody vouched for the account. The raw issuer subject is
 * never shown; it is an opaque id, not something a person can recognise.
 */
export type RequesterAccountView =
  | {
      status: "verified";
      email: string;
      issuerHost: string;
      /** The trusted issuer's display name on this Pod, when it has one. */
      issuerName: string | null;
      verifiedAt: string;
    }
  | { status: "unverified" };

export function requesterAccountView(
  requestMetadata: unknown,
  options: { issuerName?: string | null } = {}
): RequesterAccountView {
  const account = readVerifiedRequesterAccount(requestMetadata);
  if (!account) return { status: "unverified" };
  return {
    status: "verified",
    email: account.verifiedEmail,
    issuerHost: new URL(account.issuerUrl).host,
    issuerName: options.issuerName?.trim() || null,
    verifiedAt: account.verifiedAt,
  };
}

/**
 * How a request was approved, read from its metadata: by an owner, or by the
 * invite the requester accepted (`approveByInviteIfConsented`).
 */
export const INVITE_APPROVAL_METADATA_KEY = "approvedByInvite" as const;

export interface InviteApprovalRecord {
  inviteId: string;
  inviteAcceptedAt: string;
  approvedAt: string;
}

export function readInviteApproval(
  requestMetadata: unknown
): InviteApprovalRecord | null {
  const record =
    requestMetadata && typeof requestMetadata === "object"
      ? (requestMetadata as Record<string, unknown>)[
          INVITE_APPROVAL_METADATA_KEY
        ]
      : undefined;
  if (!record || typeof record !== "object") return null;
  const { inviteId, inviteAcceptedAt, approvedAt } = record as Record<
    string,
    unknown
  >;
  return typeof inviteId === "string" &&
    typeof inviteAcceptedAt === "string" &&
    typeof approvedAt === "string"
    ? { inviteId, inviteAcceptedAt, approvedAt }
    : null;
}

/**
 * The people of a sign-in app, each marked when their link was made because
 * their invite was the consent (no owner pressed Approve). `requests` are the
 * app's asks; a person counts when any ask they made was approved by invite.
 */
export function markLinkedByInvite<P extends { userId: string }>(
  people: readonly P[],
  requests: ReadonlyArray<{
    requestedByUserId: string | null;
    requestMetadata: unknown;
  }>
): Array<P & { linkedByInvite: boolean }> {
  const byInvite = new Set(
    requests
      .filter((r) => readInviteApproval(r.requestMetadata) !== null)
      .map((r) => r.requestedByUserId)
      .filter((id): id is string => Boolean(id))
  );
  return people.map((person) => ({
    ...person,
    linkedByInvite: byInvite.has(person.userId),
  }));
}
