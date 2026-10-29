import { z } from "zod";

export const registrationOutcomeSchema = z.enum([
  "CONNECTED_VERIFIED",
  "KEY_MINTED_BUT_VERIFICATION_FAILED",
]);

export type RegistrationOutcome = z.infer<typeof registrationOutcomeSchema>;

export const registrationTraceSchema = z.object({
  flowId: z.string().uuid(),
  outcome: registrationOutcomeSchema,
  verificationError: z.string().optional(),
});

export type RegistrationTrace = z.infer<typeof registrationTraceSchema>;

// The KIND of an external integration a Hub API key is minted for. This is NOT
// the proposal write-source enum (`proposals.source`).
//
// `"openclaw"` is a LEGACY value, accepted and nothing more: Synap no longer
// bundles OpenClaw (2026-10-14), no surface offers it, and it mints with the
// `custom` scopes. It stays accepted because older CLIs and installs still build
// `?integration=openclaw`, and the value is part of the key's hubId
// (`integration:openclaw`), so a reconnect's `replace_existing` still finds and
// revokes the key it replaces. Cut-over: drop it once no supported CLI builds it.
export const integrationKindSchema = z.enum([
  "raycast",
  "cli",
  "openclaw",
  "custom",
]);

export type IntegrationKind = z.infer<typeof integrationKindSchema>;

export const deeplinkContextSchema = z.object({
  apiKey: z.string(),
  podUrl: z.string().url(),
  workspaceId: z.string().uuid().optional().nullable(),
});

export type DeeplinkContext = z.infer<typeof deeplinkContextSchema>;

export const externalConnectErrorCodeSchema = z.enum([
  "KEY_MINTED_BUT_VERIFICATION_FAILED",
  "setup_agent_deprecated",
]);

export type ExternalConnectErrorCode = z.infer<
  typeof externalConnectErrorCodeSchema
>;

export const externalConnectErrorSchema = z.object({
  error: z.string(),
  code: externalConnectErrorCodeSchema.optional(),
  flowId: z.string().uuid().optional(),
  registration: registrationTraceSchema.optional(),
  message: z.string().optional(),
  adminConnectUrl: z.string().url().optional(),
});

export type ExternalConnectError = z.infer<typeof externalConnectErrorSchema>;

export const setupAgentSuccessSchema = z.object({
  agentUserId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  hubApiKey: z.string(),
  keyId: z.string().uuid(),
  registration: registrationTraceSchema,
});

export type SetupAgentSuccess = z.infer<typeof setupAgentSuccessSchema>;

export const activateAddonSuccessSchema = z.object({
  agentUserId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  hubApiKey: z.string(),
  keyId: z.string().uuid(),
  serviceId: z.string(),
  registration: registrationTraceSchema,
});

export type ActivateAddonSuccess = z.infer<typeof activateAddonSuccessSchema>;

/**
 * Most pending agent keys one approval request may carry. `synap init` mints one
 * pending key per harness it finds and opens ONE approval page for all of them;
 * the pod's `/setup/agent/pending/lookup` + `/approve-batch` doors and the
 * pod-admin `/approve-agents` page all read this one number.
 */
export const PENDING_APPROVAL_BATCH_MAX = 20;

// ─── Where /connect may deliver a freshly minted credential ─────────────────

/**
 * The redirect targets a freshly minted integration KEY may be delivered to:
 * the Synap Raycast extension, the Synap desktop app, and the CLI's loopback
 * callback (a short-lived local server on an ephemeral port). A plaintext key
 * never goes to an https origin: the claude-web flow hands its https callback
 * a one-time code (`apiKeys.beginMcpConnect`), never a key.
 */
export const DEFAULT_CONNECT_REDIRECT_PREFIXES = [
  "raycast://extensions/synap-core/synap/",
  "synap://",
  "http://127.0.0.1:",
  "http://localhost:",
] as const;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function matchesAllowedPrefix(target: URL, prefix: string): boolean {
  const allowed = parseUrl(prefix);
  if (!allowed || allowed.username !== "" || allowed.password !== "") {
    return false;
  }
  if (target.protocol !== allowed.protocol) return false;
  if (allowed.protocol === "http:") {
    // Plain http only ever means the loopback callback, on any port.
    return (
      LOOPBACK_HOSTNAMES.has(allowed.hostname) &&
      LOOPBACK_HOSTNAMES.has(target.hostname)
    );
  }
  // Same host (an empty allowed host, `synap://`, admits any host of the
  // scheme) and a path under the allowed path. `host` carries the port, so
  // `https://a.example:8443/` is not `https://a.example/`.
  if (allowed.host !== "" && target.host !== allowed.host) return false;
  return target.pathname.startsWith(allowed.pathname);
}

/**
 * May `/connect` send a credential to `uri`? A PARSED check, not a string
 * prefix: `http://localhost:@attacker.example/` starts with `http://localhost:`
 * but its host is attacker.example (`localhost:` is userinfo), and a prefix
 * test handed that origin a full-access key (pre-launch audit 2026-10-28, F3).
 *
 * - any userinfo (`user@`, `user:pass@`) is refused;
 * - `http:` only to a loopback host (127.0.0.1, localhost, [::1]);
 * - a custom scheme by protocol, plus host and path prefix when the allowed
 *   entry names them (`raycast://extensions/synap-core/synap/`);
 * - `https:` by exact host (with port) and path prefix.
 *
 * ONE rule for the pod-admin page and the server (`apiKeys.connectIntegration`).
 */
export function isAllowedConnectRedirectUri(
  uri: string,
  allowedPrefixes: readonly string[] = DEFAULT_CONNECT_REDIRECT_PREFIXES
): boolean {
  const target = parseUrl(uri);
  if (!target) return false;
  if (target.username !== "" || target.password !== "") return false;
  return allowedPrefixes.some((prefix) => matchesAllowedPrefix(target, prefix));
}
