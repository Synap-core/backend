/**
 * Proof of presence (W3, plan "one way to connect an AI to Synap", founder
 * decision of 4 Nov 2026): a session proves the ACCOUNT, not the person. An AI
 * can read a token on disk or drive the person's real browser. So the
 * sensitive approvals need a fresh signature over a pod challenge that names
 * ONE proposal, made by a key the person registered behind a biometric or the
 * device passcode: a passkey (WebAuthn, user verification required) or a
 * Relay device key (Secure Enclave / Keystore).
 *
 * This file is the ONE list of what needs it and the one wording of what is
 * signed. The pod enforces it (`@synap/api` `services/presence/`); the
 * clients (Relay, desktop, pod admin) build the proof from it. Contract: pod
 * document "W3 pod-first: proof of presence on the pod".
 */

import { z } from "zod";

/** The first line of every signed presence message (its version). */
export const PRESENCE_MESSAGE_VERSION = "synap-presence-v1" as const;

/** How long a presence challenge may be answered. */
export const PRESENCE_CHALLENGE_TTL_SECONDS = 120;

/**
 * Enrolling a device key needs a credential presented AT the pod (password,
 * code, passkey) at most this long ago: an old or stolen session cannot
 * enrol a key.
 */
export const PRESENCE_ENROLL_FRESH_SECONDS = 600;

/** The machine-readable reasons a sensitive approval is refused. */
export const PRESENCE_REQUIRED = "PRESENCE_REQUIRED" as const;
export const PRESENCE_INVALID = "PRESENCE_INVALID" as const;
export const PRESENCE_EXPIRED = "PRESENCE_EXPIRED" as const;
export const PRESENCE_USED = "PRESENCE_USED" as const;

/** Every refusal code, so a client tells a presence refusal from any other. */
export const PRESENCE_REFUSAL_CODES = [
  PRESENCE_REQUIRED,
  PRESENCE_INVALID,
  PRESENCE_EXPIRED,
  PRESENCE_USED,
] as const;

export type PresenceRefusalCode = (typeof PRESENCE_REFUSAL_CODES)[number];

/** Is `code` (an error's `data.reasonCode`, a Hub `code`) a presence refusal? */
export function isPresenceCode(code: unknown): code is PresenceRefusalCode {
  return (PRESENCE_REFUSAL_CODES as readonly unknown[]).includes(code);
}

/** Why an approval is sensitive. */
export type SensitiveReason = "setup" | "governance" | "deploy" | "deletion";

/**
 * The sensitive approvals, by the execution registry's key
 * (`<targetType>/<proposalType>`, or a `proposalType` alone). Everything else
 * is approved as before. Adding a row here asks every client for a proof on
 * that approval; removing one lets a session alone approve it again.
 */
export const SENSITIVE_APPROVALS: Readonly<Record<string, SensitiveReason>> = {
  // Setup as the person: a client, an agent, an app, a tool, a key, a secret.
  "agent/connect": "setup",
  "agent/updateCapabilities": "setup",
  "app/connect": "setup",
  "tool/create": "setup",
  // A skill created or changed by approval may turn a verb ON (founder, 4 Nov:
  // turning a tool or skill on is sensitive).
  "skill/create": "setup",
  "skill/update": "setup",
  "apiKey/create": "setup",
  "vault/grant": "setup",
  "vault/vault.request": "setup",
  // Governance: who or what may do what on the pod.
  "settings.update": "governance",
  "trusted_issuer/trusted_issuer.widen_scopes": "governance",
  // Deploys.
  "focus_session/dev.deploy_approval": "deploy",
  // Deletions.
  "entity/delete": "deletion",
  "entity/merge": "deletion",
  "relation/delete": "deletion",
  "link/delete": "deletion",
  "workspace/delete": "deletion",
  "workspace/archive": "deletion",
  "project/delete": "deletion",
  "project/archive": "deletion",
  "playbook/archive": "deletion",
  "role/delete": "deletion",
  "apiKey/delete": "deletion",
  "workspaceMember/remove": "deletion",
  "tool/delete": "deletion",
  "skill/delete": "deletion",
  "aiProvider/delete": "deletion",
  "profile/retire": "deletion",
  "profile/merge": "deletion",
  "pod_hygiene/cleanup_pack": "deletion",
  "channel/unbind": "deletion",
};

/** Every `governance.*` proposal type is governance (by prefix, as the floor). */
export const SENSITIVE_PROPOSAL_TYPE_PREFIXES: Readonly<
  Record<string, SensitiveReason>
> = {
  "governance.": "governance",
};

/**
 * Is approving this proposal sensitive, and why? Exact `targetType/proposalType`
 * first, then the `proposalType` alone, then a prefix: the registry's own
 * lookup order, so a proposal never escapes by being typed one way or the other.
 */
export function sensitiveApprovalReason(proposal: {
  targetType: string;
  proposalType: string;
}): SensitiveReason | null {
  const composite = `${proposal.targetType}/${proposal.proposalType}`;
  if (Object.prototype.hasOwnProperty.call(SENSITIVE_APPROVALS, composite)) {
    return SENSITIVE_APPROVALS[composite]!;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      SENSITIVE_APPROVALS,
      proposal.proposalType
    )
  ) {
    return SENSITIVE_APPROVALS[proposal.proposalType]!;
  }
  for (const [prefix, reason] of Object.entries(
    SENSITIVE_PROPOSAL_TYPE_PREFIXES
  )) {
    if (proposal.proposalType.startsWith(prefix)) return reason;
  }
  return null;
}

/**
 * The exact bytes a proof signs (UTF-8). A device key signs it (ECDSA P-256,
 * SHA-256, DER); a passkey's WebAuthn `challenge` is its SHA-256. Either way
 * the signature names the pod, the challenge and the proposal.
 */
export function presenceMessage(parts: {
  podOrigin: string;
  challengeId: string;
  /** The proposal, or `enroll:<challengeId>` for a device-key enrolment. */
  subject: string;
  nonce: string;
}): string {
  return [
    PRESENCE_MESSAGE_VERSION,
    parts.podOrigin,
    parts.challengeId,
    parts.subject,
    parts.nonce,
  ].join("\n");
}

/** The subject an enrolment challenge signs instead of a proposal id. */
export function enrollmentSubject(challengeId: string): string {
  return `enroll:${challengeId}`;
}

/** How the audit names the approver: "Antoine (approved with Face ID on iPhone, requested from MacBook-Pro)". */
export function presenceActorLabel(parts: {
  person: string;
  method: "passkey" | "device_key";
  deviceLabel?: string | null;
  requestedFrom?: string | null;
}): string {
  const how =
    parts.method === "passkey"
      ? "approved with a passkey"
      : `approved with Face ID or the passcode on ${parts.deviceLabel ?? "a device"}`;
  const from = parts.requestedFrom
    ? `, requested from ${parts.requestedFrom}`
    : "";
  return `${parts.person} (${how}${from})`;
}

const b64urlString = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/, "base64url");

/** The wire shape of a proof (every door parses it with this). */
export const presenceProofSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("device_key"),
    challengeId: z.string().uuid(),
    keyId: z.string().uuid(),
    signature: b64urlString,
  }),
  z.object({
    kind: z.literal("passkey"),
    challengeId: z.string().uuid(),
    credential: z.object({
      id: b64urlString,
      rawId: b64urlString,
      type: z.literal("public-key"),
      response: z.object({
        clientDataJSON: b64urlString,
        authenticatorData: b64urlString,
        signature: b64urlString,
        userHandle: b64urlString.nullish(),
      }),
      clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
      authenticatorAttachment: z.string().nullish(),
    }),
  }),
]);

/**
 * What an approval carries to prove the person is there: the wire schema's
 * own type, so the two can never drift. A device key signs `presenceMessage`
 * (DER ECDSA P-256 SHA-256, base64url); a passkey answers the WebAuthn
 * challenge.
 */
export type PresenceProof = z.infer<typeof presenceProofSchema>;

/** A WebAuthn assertion as JSON, every byte field base64url. */
export type PasskeyAssertionJSON = Extract<
  PresenceProof,
  { kind: "passkey" }
>["credential"];

/**
 * The sensitive decisions that settle NO proposal (W3 slice 2): each door
 * decides its own request, so the challenge names that request,
 * `<kind>:<id>`. One row per door; the tripwire
 * `presence-gate-every-door` derives the approve/decide procedures and fails
 * when one is neither gated nor listed as everyday.
 */
export const PRESENCE_REQUEST_KINDS = {
  /** apiKeys.decideKeyRequest: a key the CLI asked for, minted as the person. */
  key_request: "setup",
  /** apiKeys.decideDeviceRequest: a computer and its agents. */
  device_request: "setup",
  /** apiKeys.decideOAuthAuthorization: an app or MCP client connected by consent. */
  oauth_consent: "setup",
  /** applicationConnections.approveRequest: a federated application. */
  app_connection_request: "setup",
  /** mcpServers.setApproved: an MCP server's tools given to the AIs. */
  mcp_server: "setup",
  /** intelligenceRegistry.approveMcp: an AI service's MCP endpoint. */
  intelligence_mcp: "setup",
  /** skills.setApproved, capabilities.setToolEnabled, Hub /skills/:id/approve: a verb turned ON. */
  skill: "setup",
  /** tools.setApproved, Hub /tools/:id/approve: a tool turned ON. */
  tool: "setup",
  /** trustedIssuers.approve: what an outside issuer may do on the pod. */
  trusted_issuer: "governance",
  /** marketplace.approveKeyChange: trusting a catalog source's new signing key. */
  marketplace_key: "governance",
} as const satisfies Record<string, SensitiveReason>;

export type PresenceRequestKind = keyof typeof PRESENCE_REQUEST_KINDS;

/** The challenge subject of a request a door decides: `<kind>:<id>`. */
export function presenceRequestSubject(
  kind: PresenceRequestKind,
  id: string
): string {
  return `${kind}:${id}`;
}

/**
 * The id of one OAuth authorization (a consent screen): the parameters the
 * person is shown, hashed. The consent page asks for a challenge with the same
 * parameters, so the proof names THIS authorization. Async: Web Crypto, so the
 * browser computes the same id as the pod.
 */
export async function oauthConsentId(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string | null;
  state?: string | null;
}): Promise<string> {
  const text = [
    params.clientId,
    params.redirectUri,
    params.codeChallenge ?? "",
    params.state ?? "",
  ].join("\n");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
