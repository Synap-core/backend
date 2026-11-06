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
import type { Catalog, Locale } from "../i18n/index.js";
import { buildObjectActionTitle, type VerbMood } from "../vocabulary/index.js";

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

/**
 * A passkey removal refused because it is the person's last passkey while the
 * proof of presence is on (W5): pod admin proves only with a passkey, so the
 * person would lose the way to approve here. Not a presence refusal (no proof
 * would change it): it is never in `PRESENCE_REFUSAL_CODES`.
 */
export const PRESENCE_LAST_PASSKEY = "PRESENCE_LAST_PASSKEY" as const;

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
  // A pack's verbs and tools turned ON by approval (its executor turns them
  // on through skills/tools.setApproved, which then trust this proof).
  "capability.enable": "setup",
  "apiKey/create": "setup",
  // Rotating a key mints a new secret (its executor replays apiKeys.rotate).
  "apiKey/update": "setup",
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
 * What a pod admin switched OFF of the sensitive lists (W5, founder 6 Nov
 * 2026: "pod settings (pod admin) should enable the user to select what is
 * considered sensitive & what is not"). Stored per pod
 * (`pod_settings.settings.presenceSensitivity`), written only by
 * `presence.setSensitivity`. Absent or empty = every row on: today's lists.
 * Only a row of `SENSITIVE_APPROVALS` / `SENSITIVE_PROPOSAL_TYPE_PREFIXES` /
 * `SENSITIVE_ACTIONS` can be switched: a request filed AS the person and the
 * requests a door decides (`PRESENCE_REQUEST_KINDS`) always ask.
 */
export interface PresenceSensitivityChoice {
  /** Keys of `SENSITIVE_APPROVALS` or `SENSITIVE_PROPOSAL_TYPE_PREFIXES` switched off. */
  approvalsOff: readonly string[];
  /** Paths of `SENSITIVE_ACTIONS` switched off. */
  actionsOff: readonly string[];
}

/** The default: nothing switched off, so the lists above hold as written. */
export const DEFAULT_PRESENCE_SENSITIVITY: PresenceSensitivityChoice = {
  approvalsOff: [],
  actionsOff: [],
};

/** One switchable row of "What asks for your passkey". */
export interface PresenceSensitivityRow {
  /** An approval (`<targetType>/<proposalType>`, a type, or a type prefix) or an action (a tRPC path). */
  kind: "approval" | "action";
  key: string;
  reason: SensitiveReason;
  /** A type prefix (`governance.`): every proposal type that starts with it. */
  prefix?: true;
}

/** Every switchable row, derived from the lists, in their order. */
export function presenceSensitivityRows(): PresenceSensitivityRow[] {
  return [
    ...Object.entries(SENSITIVE_APPROVALS).map(([key, reason]) => ({
      kind: "approval" as const,
      key,
      reason,
    })),
    ...Object.entries(SENSITIVE_PROPOSAL_TYPE_PREFIXES).map(
      ([key, reason]) => ({
        kind: "approval" as const,
        key,
        reason,
        prefix: true as const,
      })
    ),
    ...Object.entries(SENSITIVE_ACTIONS).map(([key, reason]) => ({
      kind: "action" as const,
      key,
      reason: reason as SensitiveReason,
    })),
  ];
}

/**
 * A choice as the pod stores it: only keys of the lists, each once, sorted.
 * An unknown key (a row removed from the lists since) is dropped, never kept
 * to switch off a row that may come back meaning something else.
 */
export function normalizePresenceSensitivity(
  choice: Partial<PresenceSensitivityChoice> | null | undefined
): PresenceSensitivityChoice {
  const approvals = new Set([
    ...Object.keys(SENSITIVE_APPROVALS),
    ...Object.keys(SENSITIVE_PROPOSAL_TYPE_PREFIXES),
  ]);
  const actions = new Set(Object.keys(SENSITIVE_ACTIONS));
  const keep = (keys: readonly string[] | undefined, known: Set<string>) =>
    [...new Set(keys ?? [])].filter((k) => known.has(k)).sort();
  return {
    approvalsOff: keep(choice?.approvalsOff, approvals),
    actionsOff: keep(choice?.actionsOff, actions),
  };
}

/**
 * Does `next` switch OFF a row `current` asks for? That change lets a
 * session alone do more, so it needs a proof of presence in every mode;
 * switching rows back ON only takes power away.
 */
export function sensitivityLoosens(
  current: PresenceSensitivityChoice,
  next: PresenceSensitivityChoice
): boolean {
  const was = (list: readonly string[]) => new Set(list);
  const approvals = was(current.approvalsOff);
  const actions = was(current.actionsOff);
  return (
    next.approvalsOff.some((k) => !approvals.has(k)) ||
    next.actionsOff.some((k) => !actions.has(k))
  );
}

/**
 * The request id a proof for a sensitivity change names
 * (`presence_sensitivity:<id>`): hex SHA-256 of the normalized new choice, so
 * the proof is bound to exactly the rows the person saw switched off.
 */
export function presenceSensitivityId(
  choice: PresenceSensitivityChoice
): Promise<string> {
  return sha256Hex(canonicalJson(normalizePresenceSensitivity(choice)));
}

/** The wire shape of a choice (`presence.setSensitivity`). */
export const presenceSensitivitySchema = z.object({
  approvalsOff: z.array(z.string().min(1).max(200)).max(200),
  actionsOff: z.array(z.string().min(1).max(200)).max(200),
});

/** The row of the approval lists this proposal falls under, or null. */
function sensitiveApprovalRow(proposal: {
  targetType: string;
  proposalType: string;
}): { key: string; reason: SensitiveReason } | null {
  const composite = `${proposal.targetType}/${proposal.proposalType}`;
  if (Object.prototype.hasOwnProperty.call(SENSITIVE_APPROVALS, composite)) {
    return { key: composite, reason: SENSITIVE_APPROVALS[composite]! };
  }
  if (
    Object.prototype.hasOwnProperty.call(
      SENSITIVE_APPROVALS,
      proposal.proposalType
    )
  ) {
    return {
      key: proposal.proposalType,
      reason: SENSITIVE_APPROVALS[proposal.proposalType]!,
    };
  }
  for (const [prefix, reason] of Object.entries(
    SENSITIVE_PROPOSAL_TYPE_PREFIXES
  )) {
    if (proposal.proposalType.startsWith(prefix))
      return { key: prefix, reason };
  }
  return null;
}

/**
 * Is approving this proposal sensitive, and why? Exact `targetType/proposalType`
 * first, then the `proposalType` alone, then a prefix: the registry's own
 * lookup order, so a proposal never escapes by being typed one way or the other.
 * With the pod's `choice`, a row a pod admin switched off is not sensitive;
 * the row that matched decides (a switched-off composite never falls through
 * to its type alone).
 */
export function sensitiveApprovalReason(
  proposal: {
    targetType: string;
    proposalType: string;
  },
  choice?: PresenceSensitivityChoice | null
): SensitiveReason | null {
  const row = sensitiveApprovalRow(proposal);
  if (!row) return null;
  return choice?.approvalsOff.includes(row.key) ? null : row.reason;
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
  /**
   * presence.devices.enroll when the person already has a factor (founder
   * decision 2, 4 Nov): an EXISTING factor approves the new device key. The id
   * is `presenceKeyFingerprint(<the new key's SPKI DER, base64url>)`.
   */
  device_enroll: "setup",
  /**
   * presence.authorizePasskeyChange: an existing factor approves ONE change
   * to the person's passkeys (adding one, or removing one) in Kratos' settings
   * flow, whose guard redeems it. The id is the person's own user id.
   */
  passkey_change: "setup",
  /** presence.setMode back to `report`: switching the proof off. The id is `report`. */
  presence_mode: "governance",
  /**
   * presence.setSensitivity when it switches a row OFF (W5): what asks for a
   * passkey, chosen by a pod admin. The id is `presenceSensitivityId` of the
   * new choice.
   */
  presence_sensitivity: "governance",
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
  return sha256Hex(
    [
      params.clientId,
      params.redirectUri,
      params.codeChallenge ?? "",
      params.state ?? "",
    ].join("\n")
  );
}

/** Hex SHA-256 of a UTF-8 string (Web Crypto: the same in a browser and on the pod). */
async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The id of a device key being enrolled: hex SHA-256 of its SPKI DER (base64url) as sent. */
export function presenceKeyFingerprint(publicKey: string): Promise<string> {
  return sha256Hex(publicKey);
}

/**
 * The sensitive ACTIONS (founder decision 1, 4 Nov): tRPC procedures that
 * create, rotate or widen a credential or a governance rule directly, with no
 * proposal to approve. Keyed by the procedure PATH. The pod's step-up
 * middleware (`requireFreshAuthentication`, so `credentialProcedure`) reads
 * this list: a listed call needs a proof of presence bound to the call itself
 * (`presenceActionSubject`). Clients read it to prove up front. The tripwire
 * `presence-gate-every-door` classifies every credential door as here or
 * everyday.
 */
export const SENSITIVE_ACTIONS = {
  "apiKeys.create": "setup",
  "apiKeys.rotate": "setup",
  "apiKeys.setGrants": "setup",
  "apiKeys.connectIntegration": "setup",
  "apiKeys.beginMcpConnect": "setup",
  "apiKeys.createSystemKey": "setup",
  "apiKeys.adminCreateServiceKey": "setup",
  "apiKeys.createForWorkspace": "setup",
  "apiKeys.setMachineDefaults": "setup",
  // A key or a client an app or AI service holds, or what it may do.
  "apps.issueKey": "setup",
  "apps.setWriteMode": "setup",
  "apps.setRedirectUris": "setup",
  "apps.setSignInPolicy": "setup",
  "intelligenceRegistry.register": "setup",
  "intelligenceRegistry.update": "setup",
  "intelligenceRegistry.rotateKey": "setup",
  "intelligence.registerCustomService": "setup",
  // A computer's key: how long it lives, whether it runs scripts, whose it is.
  "machines.setKeyTtl": "setup",
  "machines.setRunsScripts": "setup",
  "machines.setBelongsTo": "setup",
  // A secret's value, shown to the session.
  "secretsVault.reveal": "setup",
  // An agent's role, capabilities and whether its writes need a proposal.
  "agentUsers.create": "governance",
  "agentUsers.update": "governance",
  "agentUsers.setPosture": "governance",
  // A connection's `auto` rule; an outside issuer's trust.
  "connectors.setKeepSyncing": "governance",
  "trustedIssuers.adminRegister": "governance",
  "governanceRules.create": "governance",
  "governanceRules.widenCell": "governance",
  "governanceRules.proposeNextRung": "governance",
  "governanceRules.setReversibleDefault": "governance",
  "governanceRules.setOwnOrganiseDefault": "governance",
  // How a tool action runs for every AI (on its own / asks first / never).
  "governanceRules.setActionMode": "governance",
  "govConfig.set": "governance",
} as const satisfies Record<string, SensitiveReason>;

export type SensitiveActionPath = keyof typeof SENSITIVE_ACTIONS;

/**
 * Is this tRPC path a sensitive action? With the pod's `choice`, a path a pod
 * admin switched off is not (the step-up's fresh sign-in still holds).
 */
export function sensitiveActionReason(
  path: string,
  choice?: PresenceSensitivityChoice | null
): SensitiveReason | null {
  if (!Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, path)) {
    return null;
  }
  if (choice?.actionsOff.includes(path)) return null;
  return (SENSITIVE_ACTIONS as Record<string, SensitiveReason>)[path]!;
}

/**
 * What confirming each sensitive action does, as vocabulary TOKENS: the title
 * door (`buildObjectActionTitle`) turns them into words, in either mood and
 * language, so no client keeps a label map of its own. Typed over every path:
 * a path added to `SENSITIVE_ACTIONS` fails the build here until it is named.
 */
export const SENSITIVE_ACTION_TOKENS = {
  "apiKeys.create": { action: "create", objectKind: "api_key" },
  "apiKeys.rotate": { action: "rotate", objectKind: "api_key" },
  "apiKeys.setGrants": { action: "update", objectKind: "api_key" },
  "apiKeys.connectIntegration": { action: "connect", objectKind: "app" },
  "apiKeys.beginMcpConnect": { action: "connect", objectKind: "agent" },
  "apiKeys.createSystemKey": { action: "create", objectKind: "api_key" },
  "apiKeys.adminCreateServiceKey": { action: "create", objectKind: "api_key" },
  "apiKeys.createForWorkspace": { action: "create", objectKind: "api_key" },
  "apiKeys.setMachineDefaults": { action: "update", objectKind: "machine" },
  "apps.issueKey": { action: "create", objectKind: "api_key" },
  "apps.setWriteMode": { action: "update", objectKind: "app" },
  "apps.setRedirectUris": { action: "update", objectKind: "app" },
  "apps.setSignInPolicy": { action: "update", objectKind: "app" },
  "intelligenceRegistry.register": {
    action: "connect",
    objectKind: "intelligence_service",
  },
  "intelligenceRegistry.update": {
    action: "update",
    objectKind: "intelligence_service",
  },
  "intelligenceRegistry.rotateKey": { action: "rotate", objectKind: "api_key" },
  "intelligence.registerCustomService": {
    action: "connect",
    objectKind: "intelligence_service",
  },
  "machines.setKeyTtl": { action: "update", objectKind: "machine" },
  "machines.setRunsScripts": { action: "update", objectKind: "machine" },
  "machines.setBelongsTo": { action: "update", objectKind: "machine" },
  "secretsVault.reveal": { action: "see", objectKind: "secret" },
  "agentUsers.create": { action: "create", objectKind: "agent" },
  "agentUsers.update": { action: "update", objectKind: "agent" },
  "agentUsers.setPosture": { action: "update", objectKind: "agent" },
  "connectors.setKeepSyncing": { action: "update", objectKind: "connection" },
  "trustedIssuers.adminRegister": { action: "add", objectKind: "issuer" },
  "governanceRules.create": { action: "create", objectKind: "rule" },
  "governanceRules.widenCell": { action: "widen_scopes", objectKind: "agent" },
  "governanceRules.proposeNextRung": {
    action: "widen_scopes",
    objectKind: "agent",
  },
  "governanceRules.setReversibleDefault": {
    action: "update",
    objectKind: "rule",
  },
  "governanceRules.setOwnOrganiseDefault": {
    action: "update",
    objectKind: "rule",
  },
  "governanceRules.setActionMode": { action: "update", objectKind: "rule" },
  "govConfig.set": { action: "update", objectKind: "rule" },
} as const satisfies Record<
  SensitiveActionPath,
  { action: string; objectKind: string }
>;

/**
 * A sensitive action's title through the one title door: imperative (what
 * confirming it WILL do, "Create API key") by default, past for history.
 */
export function sensitiveActionTitle(
  path: SensitiveActionPath,
  opts: { mood?: VerbMood; locale?: Locale } = {}
): string {
  const tokens = SENSITIVE_ACTION_TOKENS[path];
  return buildObjectActionTitle({
    action: tokens.action,
    objectKind: tokens.objectKind,
    mood: opts.mood ?? "imperative",
    ...(opts.locale ? { locale: opts.locale } : {}),
  });
}

/**
 * The ONE wording of proof of presence that every client shows (pod admin,
 * Relay, the desktop app), as a catalog of the i18n door: English is the
 * source and the type.
 *  - `setting`: the pod setting's name;
 *  - `on` / `off`: its state. Off is "Off" everywhere (the pod still records
 *    each approval made without a proof; the setting's own line says so);
 *  - `refused`: the title of a refusal for want of a proof;
 *  - `sensitive`: what needs it;
 *  - `where`: where the person can give it.
 * DRAFT French ("vous"), awaiting the founder's review.
 */
export const presenceWordsEn = {
  "presence.setting": "Approvals need you in person",
  "presence.on": "On",
  "presence.off": "Off",
  "presence.refused": "Needs you in person",
  "presence.sensitive":
    "Connecting an AI or an app, changing keys and rules, deploys and deletions",
  "presence.where":
    "You approve in pod admin with a passkey, in Relay with Face ID, or in the desktop app with Touch ID.",
} as const;

export const presenceWordsFr: Catalog<typeof presenceWordsEn> = {
  "presence.setting": "Les approbations demandent votre présence",
  "presence.on": "Activé",
  "presence.off": "Désactivé",
  "presence.refused": "Demande votre présence",
  "presence.sensitive":
    "Connecter une IA ou une app, modifier des clés et des règles, les déploiements et les suppressions",
  "presence.where":
    "Vous approuvez dans l’administration du pod avec une clé d’accès, dans Relay avec Face ID, ou dans l’app de bureau avec Touch ID.",
};

/** The shared presence words, per catalog language (`useT` / `createT`). */
export const PRESENCE_WORDS = { en: presenceWordsEn, fr: presenceWordsFr };

/**
 * JSON with object keys sorted at every level, so the client and the pod
 * serialize the same input to the same text. `undefined` members are dropped
 * and a Date becomes its ISO string, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(src)
          .sort()
          .map((k) => [k, src[k]])
      );
    }
    return v;
  });
}

/**
 * The digest that binds a proof to ONE call: hex SHA-256 of
 * `<path>\n<canonical JSON of the input without its presence>`. The client
 * computes it over the exact input it sends; the pod over the raw input it
 * received.
 */
export async function presenceActionDigest(
  path: string,
  input: unknown
): Promise<string> {
  let body: unknown = input ?? null;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { presence: _presence, ...rest } = body as Record<string, unknown>;
    body = rest;
  }
  return sha256Hex(`${path}\n${canonicalJson(body)}`);
}

/** The challenge subject of a sensitive action: `action:<path>:<digest>`. */
export function presenceActionSubject(path: string, digest: string): string {
  return `action:${path}:${digest}`;
}

export * from "./authenticators.js";
