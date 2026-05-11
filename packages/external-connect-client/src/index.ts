export type RegistrationOutcome =
  | "CONNECTED_VERIFIED"
  | "KEY_MINTED_BUT_VERIFICATION_FAILED";
export interface RegistrationTrace {
  flowId: string;
  outcome: RegistrationOutcome;
  verificationError?: string;
}

export type IntegrationKind = "raycast" | "cli" | "openclaw" | "custom";

export interface DeeplinkContext {
  apiKey: string;
  podUrl: string;
  workspaceId?: string | null;
}

export interface ExternalConnectError {
  error: string;
  code?: string;
  flowId?: string;
  registration?: {
    flowId: string;
    outcome: string;
    verificationError?: string;
  };
  message?: string;
  adminConnectUrl?: string;
}

export interface NormalizedHandshakeError {
  code: string;
  stage?: string;
  podUrl?: string;
  status?: number;
  detail?: string;
  message: string;
}

export const DEFAULT_CONNECT_REDIRECT_PREFIXES = [
  "raycast://extensions/synap-core/synap/",
  "synap://",
  // CLI flow: loopback HTTP callback. The CLI starts a short-lived local server
  // on an ephemeral port and passes the full URL as redirect_uri. Loopback is
  // safe — no external network can intercept the callback, and the port is
  // chosen by the local process.
  "http://127.0.0.1:",
  "http://localhost:",
] as const;

export function isAllowedConnectRedirectUri(
  uri: string,
  allowedPrefixes: readonly string[] = DEFAULT_CONNECT_REDIRECT_PREFIXES
): boolean {
  return allowedPrefixes.some((prefix) => uri.startsWith(prefix));
}

export function buildConnectDeeplink(
  redirectUri: string,
  context: DeeplinkContext
): string {
  return `${redirectUri}?context=${encodeURIComponent(JSON.stringify(context))}`;
}

export function parseConnectContext(raw: unknown): DeeplinkContext | null {
  if (!raw || typeof raw !== "object") return null;
  const rawObj = raw as {
    apiKey?: unknown;
    podUrl?: unknown;
    workspaceId?: unknown;
    context?: unknown;
  };
  if (typeof rawObj.apiKey === "string" && typeof rawObj.podUrl === "string") {
    return {
      apiKey: rawObj.apiKey,
      podUrl: rawObj.podUrl,
      workspaceId:
        typeof rawObj.workspaceId === "string" || rawObj.workspaceId == null
          ? (rawObj.workspaceId ?? null)
          : null,
    };
  }

  const maybeContext = rawObj.context;
  if (typeof maybeContext !== "string" || maybeContext.length === 0)
    return null;

  try {
    const parsed = JSON.parse(maybeContext) as {
      apiKey?: unknown;
      podUrl?: unknown;
      workspaceId?: unknown;
    };
    if (
      typeof parsed.apiKey !== "string" ||
      typeof parsed.podUrl !== "string"
    ) {
      return null;
    }
    return {
      apiKey: parsed.apiKey,
      podUrl: parsed.podUrl,
      workspaceId:
        typeof parsed.workspaceId === "string" || parsed.workspaceId == null
          ? (parsed.workspaceId ?? null)
          : null,
    };
  } catch {
    return null;
  }
}

export function extractFlowId(message: string): string | null {
  const match = message.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
  );
  return match?.[0] ?? null;
}

export function normalizeExternalConnectError(
  err: unknown
): ExternalConnectError & { flowId?: string } {
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    const message =
      typeof obj.message === "string"
        ? obj.message
        : typeof obj.error === "string"
          ? obj.error
          : "External connect request failed";
    const flowId =
      typeof obj.flowId === "string"
        ? obj.flowId
        : (extractFlowId(message) ?? undefined);
    return {
      error: message,
      message,
      flowId,
      ...(typeof obj.code === "string" ? { code: obj.code as never } : {}),
      ...(obj.registration && typeof obj.registration === "object"
        ? {
            registration: obj.registration as {
              flowId: string;
              outcome: string;
              verificationError?: string;
            },
          }
        : {}),
    };
  }
  const message =
    err instanceof Error ? err.message : "External connect request failed";
  const flowId = extractFlowId(message) ?? undefined;
  return { error: message, message, flowId };
}

export function normalizeHandshakeError(
  err: unknown
): NormalizedHandshakeError | null {
  if (!err || typeof err !== "object") return null;
  const maybeErr = err as {
    name?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const details =
    maybeErr.details && typeof maybeErr.details === "object"
      ? (maybeErr.details as Record<string, unknown>)
      : null;
  if (maybeErr.name !== "AuthHandshakeError" || !details) return null;
  return {
    code:
      typeof details.code === "string"
        ? details.code
        : "POD_HANDSHAKE_EXCHANGE_FAILED",
    stage: typeof details.stage === "string" ? details.stage : undefined,
    podUrl: typeof details.podUrl === "string" ? details.podUrl : undefined,
    status: typeof details.status === "number" ? details.status : undefined,
    detail: typeof details.detail === "string" ? details.detail : undefined,
    message:
      typeof maybeErr.message === "string"
        ? maybeErr.message
        : "Managed pod handshake failed",
  };
}

export function buildFlowTraceUrl(flowId: string): string {
  return `/events?correlationId=${encodeURIComponent(flowId)}`;
}

/**
 * @deprecated Use `buildIntegrationConnectUrl` with the pod-admin URL
 * instead. The legacy admin-ui SPA at `pod.<root>/admin/connect` was
 * retired in 2026-05; the connect surface now lives at
 * `pod-admin.<root>/connect`. The backend still 302s the legacy path,
 * so installed CLIs keep working — but new code should aim straight at
 * pod-admin to skip the round-trip.
 */
export function buildPodAdminConnectUrl(input: {
  podUrl: string;
  integration: IntegrationKind;
  redirectUri?: string;
  cpHandshakeToken?: string;
}): string {
  const url = new URL(`${input.podUrl.replace(/\/$/, "")}/admin/connect`);
  url.searchParams.set("integration", input.integration);
  if (input.redirectUri) {
    url.searchParams.set("redirect_uri", input.redirectUri);
  }
  if (input.cpHandshakeToken) {
    url.searchParams.set("cp_handshake_token", input.cpHandshakeToken);
  }
  return url.toString();
}

/**
 * Canonical integration-connect URL builder.
 *
 * Targets pod-admin's native `/connect` page directly. Prefer this over
 * `buildPodAdminConnectUrl` for any new CLI/Raycast/OpenClaw release
 * — the legacy form goes through a backend 302 hop.
 *
 * For `podUrl` callers, derive the pod-admin URL: replace the leading
 * `pod.` host segment with `pod-admin.` (same scheme, same root).
 */
export function buildIntegrationConnectUrl(input: {
  podAdminUrl: string;
  integration: IntegrationKind;
  redirectUri?: string;
  cpHandshakeToken?: string;
}): string {
  const url = new URL(`${input.podAdminUrl.replace(/\/$/, "")}/connect`);
  url.searchParams.set("integration", input.integration);
  if (input.redirectUri) {
    url.searchParams.set("redirect_uri", input.redirectUri);
  }
  if (input.cpHandshakeToken) {
    url.searchParams.set("cp_handshake_token", input.cpHandshakeToken);
  }
  return url.toString();
}

/**
 * Derive the pod-admin URL from a pod URL by swapping the leading
 * `pod.` host segment for `pod-admin.`. Returns null for inputs that
 * don't follow the `pod.<root>` convention (raw IP, localhost) — the
 * caller should fall back to `buildPodAdminConnectUrl` (legacy path) in
 * that case so the backend redirect handles routing.
 */
export function derivePodAdminUrl(podUrl: string): string | null {
  try {
    const u = new URL(podUrl);
    if (!u.hostname.startsWith("pod.")) return null;
    u.hostname = `pod-admin.${u.hostname.slice("pod.".length)}`;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export interface ConnectIntegrationInput {
  integration: IntegrationKind;
  workspaceId?: string;
}

export type ControlPlaneFetch = (
  path: string,
  method?: "GET" | "POST" | "DELETE",
  body?: string
) => Promise<{ ok: boolean; status: number; data: unknown }>;

export async function requestControlPlaneHandshakeToken(
  cpFetch: ControlPlaneFetch,
  targetUrl: string
): Promise<string | null> {
  const result = await cpFetch(
    "/pods/handshake",
    "POST",
    JSON.stringify({ targetUrl })
  );
  if (!result.ok) return null;
  const data = result.data as { token?: string } | null;
  return data?.token ?? null;
}

export type ControlPlaneRequest = (
  path: string,
  opts?: {
    method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
    body?: string | Record<string, unknown>;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: <T = unknown>() => Promise<T>;
}>;

export async function requestControlPlaneHandshakeTokenViaRequest(
  cpRequest: ControlPlaneRequest,
  targetUrl: string
): Promise<string | null> {
  const res = await cpRequest("/pods/handshake", {
    method: "POST",
    body: { targetUrl },
  });
  if (!res.ok) return null;
  const data = await res.json<{ token?: string }>();
  return data?.token ?? null;
}
