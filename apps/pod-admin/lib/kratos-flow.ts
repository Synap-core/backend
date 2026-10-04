/**
 * Kratos browser-flow client for pod-admin.
 *
 * Pod-admin runs on `pod-admin.<root>` while Kratos public endpoints live on
 * `pod.<root>/.ory/kratos/public`. The Kratos session cookie is scoped to the
 * parent domain, so `credentials: "include"` carries it across the subdomain
 * boundary. Kratos must be configured to allow the pod-admin origin in CORS.
 *
 * Covers the flows pod-admin renders: login (`/login`), recovery
 * (`/recovery`) and settings (`/settings/security`), plus the signed-in
 * user's own session list. Verification is off on pods until the courier
 * delivers mail.
 */

import {
  POD_PUBLIC_URL_CONFIGURATION_ERROR,
  publicPodUrl as runtimePublicPodUrl,
} from "./public-pod-url";

/**
 * Resolve the public Pod API URL from server-injected runtime configuration.
 * This keeps a reusable Pod Admin image correct after hostname transitions.
 */
function publicPodUrl(): string {
  return runtimePublicPodUrl();
}

function kratosPublic(): string {
  const podUrl = publicPodUrl();
  if (!podUrl) throw new Error(POD_PUBLIC_URL_CONFIGURATION_ERROR);
  return `${podUrl.replace(/\/$/, "")}/.ory/kratos/public`;
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("json");
}

async function readJsonResponse<T>(
  response: Response,
  failureMessage: string
): Promise<T> {
  if (!isJsonResponse(response)) {
    throw new Error(failureMessage);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(failureMessage);
  }
}

/**
 * Rewrite a Kratos absolute action URL (Kratos sometimes returns its
 * container-internal hostname like `http://kratos:4433/...`) so the browser
 * posts to the pod's public origin instead.
 */
function resolveActionUrl(action: string): string {
  try {
    const u = new URL(action);
    const api = new URL(kratosPublic());
    return `${api.origin}${u.pathname}${u.search}`;
  } catch {
    return action;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A Kratos UI message. `id` is what callers branch on (see
 * `@synap-core/types/kratos-messages` and `lib/sign-in-state.ts`); `text` is
 * English fallback copy.
 */
export interface KratosMessage {
  id?: number;
  type: string;
  text: string;
  context?: Record<string, unknown>;
}

export interface KratosUiNode {
  type: string;
  group?: string;
  messages?: KratosMessage[];
  attributes?: Record<string, string | boolean | number | undefined>;
  /**
   * Presentation metadata. For an oidc method button Kratos puts the provider's
   * configured `label` here (e.g. "Synap Cloud") — NOT in `attributes.label` —
   * so the caller must read this to show a human name instead of the raw
   * provider id.
   */
  meta?: { label?: { text?: string; id?: number } };
}

export interface KratosUi {
  action: string;
  method: string;
  nodes: KratosUiNode[];
  messages?: KratosMessage[];
}

export interface KratosFlow {
  id: string;
  type?: string;
  /** Recovery: choose_method | sent_email | passed_challenge. Settings: show_form | success. */
  state?: string;
  ui: KratosUi;
  return_to?: string;
}

export interface KratosSession {
  id: string;
  active: boolean;
  identity: {
    id: string;
    traits?: { email?: string; name?: string };
  };
}

export interface CreateLoginFlowResult {
  flow?: KratosFlow;
  /** Set when Kratos detects an existing session and refuses to create a flow. */
  existingSession?: KratosSession;
}

export interface SubmitLoginFlowResult {
  /** Validation failed — re-render with the returned flow's messages. */
  flow?: KratosFlow;
  /** Auth succeeded. */
  session?: KratosSession;
  /**
   * Kratos needs the browser to leave for another origin to continue — the
   * federated "Continue with Synap Cloud" (oidc) submit answers with HTTP 422
   * `browser_location_change_required` carrying `redirect_browser_to`, the
   * Control Plane authorization URL. The caller navigates the top-level browser
   * there; the CP round-trips back to the pod's Kratos callback, which sets the
   * (parent-domain) session cookie and returns to `return_to`.
   */
  redirectBrowserTo?: string;
  /** Unrecoverable: caller should recreate the flow (CSRF, expired, etc.). */
  structuralError?: {
    id?: string;
    code?: number;
    message?: string;
    reason?: string;
  };
}

/** Kratos error ids that indicate the current flow must be discarded. */
export const FLOW_RESET_ERROR_IDS = new Set<string>([
  "security_csrf_violation",
  "security_identity_mismatch",
  "self_service_flow_expired",
  "self_service_flow_return_to_forbidden",
  "session_already_available",
]);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function whoami(): Promise<KratosSession | null> {
  try {
    const res = await fetch(`${kratosPublic()}/sessions/whoami`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as KratosSession;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

export async function createLoginFlow(
  returnTo?: string,
  opts: { refresh?: boolean } = {}
): Promise<CreateLoginFlowResult> {
  // `return_to` brings the browser back here after a federated (oidc) round-trip
  // through the Control Plane. It must be an allowed Kratos return URL — the
  // pod-admin origin is allow-listed in the pod's kratos.yml. Kratos ignores it
  // for a plain password login, so it is always safe to pass.
  const url = new URL(`${kratosPublic()}/self-service/login/browser`);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  // `refresh=true`: re-authenticate an EXISTING session (settings needs a
  // sign-in within the privileged window) instead of refusing with
  // `session_already_available`.
  if (opts.refresh) url.searchParams.set("refresh", "true");
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: { Accept: "application/json" },
    redirect: "follow",
  });

  if (res.status === 200) {
    const flow = await readJsonResponse<KratosFlow>(
      res,
      "Pod authentication returned an unexpected response. Verify this Pod's API and Pod Admin deployment addresses."
    );
    return { flow };
  }

  let body: { id?: string; message?: string; reason?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not JSON */
  }

  if (res.status === 400 && body.id === "session_already_available") {
    const session = await whoami();
    if (session) return { existingSession: session };
  }

  throw new Error(
    body.message
      ? `${body.message}${body.reason ? `: ${body.reason}` : ""}`
      : `Failed to create login flow (${res.status})`
  );
}

/** Every self-service flow kind a `?flow=` id can belong to. */
export type AnySelfServiceFlowKind =
  | "login"
  | "registration"
  | "recovery"
  | "settings";

/**
 * Fetch the flow behind a `?flow=` id. Kratos sends recovery and settings
 * flows to their own pages, but a pod whose kratos.yml predates those pages
 * points EVERY self-service ui_url at /login — and a refused Synap Cloud first
 * sign-in lands here with a REGISTRATION flow id. Each endpoint answers 404 for
 * a flow of another kind, so ONLY a 404 falls through to the next kind (login →
 * registration → recovery → settings); any other failure is reported as-is.
 */
export async function fetchSelfServiceFlow(
  flowId: string
): Promise<{ flow: KratosFlow; kind: AnySelfServiceFlowKind }> {
  const kinds: AnySelfServiceFlowKind[] = [
    "login",
    "registration",
    "recovery",
    "settings",
  ];
  for (const kind of kinds) {
    const res = await fetch(
      `${kratosPublic()}/self-service/${kind}/flows?id=${encodeURIComponent(flowId)}`,
      { credentials: "include", headers: { Accept: "application/json" } }
    );
    if (res.ok) {
      return {
        kind,
        flow: await readJsonResponse<KratosFlow>(res, UNEXPECTED_RESPONSE),
      };
    }
    if (res.status !== 404) {
      let body: { error?: { message?: string } } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        /* not JSON */
      }
      throw new Error(
        body.error?.message ??
          `${kind === "login" ? "Login" : "Sign-in"} flow ${flowId} could not be loaded (${res.status})`
      );
    }
  }
  throw new Error(`Sign-in flow ${flowId} not found (404)`);
}

/**
 * Where a non-login flow id belongs. /login receives recovery and settings ids
 * from a pod whose kratos.yml predates /recovery and /settings/security; the
 * login page forwards them instead of rendering a login form over them.
 */
export function pageForFlow(
  kind: AnySelfServiceFlowKind,
  flowId: string
): string | null {
  const id = encodeURIComponent(flowId);
  if (kind === "recovery") return `/recovery?flow=${id}`;
  if (kind === "settings") return `/settings/security?flow=${id}`;
  return null;
}

const UNEXPECTED_RESPONSE =
  "Pod authentication returned an unexpected response. Verify this Pod's API and Pod Admin deployment addresses.";

/** Fetch a flow of a KNOWN kind (the page already knows which one it renders). */
export async function fetchFlow(
  kind: "recovery" | "settings",
  flowId: string
): Promise<KratosFlow> {
  const res = await fetch(
    `${kratosPublic()}/self-service/${kind}/flows?id=${encodeURIComponent(flowId)}`,
    { credentials: "include", headers: { Accept: "application/json" } }
  );
  if (res.ok) return readJsonResponse<KratosFlow>(res, UNEXPECTED_RESPONSE);
  let body: { error?: { id?: string; message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not JSON */
  }
  throw new FlowLoadError(
    body.error?.message ?? `This ${kind} link could not be loaded (${res.status})`,
    res.status,
    body.error?.id
  );
}

export class FlowLoadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly id?: string
  ) {
    super(message);
  }
}

export type CreateFlowResult =
  | { flow: KratosFlow }
  | { existingSession: true }
  | { signInRequired: true };

/**
 * Start a recovery or settings BROWSER flow. Recovery refuses while signed in
 * (`session_already_available`); settings needs a session (401).
 */
export async function createBrowserFlow(
  kind: "recovery" | "settings",
  returnTo?: string
): Promise<CreateFlowResult> {
  const url = new URL(`${kratosPublic()}/self-service/${kind}/browser`);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (res.ok) {
    return { flow: await readJsonResponse<KratosFlow>(res, UNEXPECTED_RESPONSE) };
  }
  let body: { error?: { id?: string; message?: string; reason?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* not JSON */
  }
  if (body.error?.id === "session_already_available") {
    return { existingSession: true };
  }
  if (res.status === 401 || body.error?.id === "session_inactive") {
    return { signInRequired: true };
  }
  throw new Error(
    body.error?.message
      ? `${body.error.message}${body.error.reason ? `: ${body.error.reason}` : ""}`
      : `Failed to start ${kind} (${res.status})`
  );
}

export type SubmitFlowResult =
  | { kind: "flow"; flow: KratosFlow }
  | { kind: "session"; session: KratosSession }
  | { kind: "redirect"; to: string }
  /** Settings needs a recent sign-in (Kratos `session_refresh_required`). */
  | { kind: "refresh_required" }
  | {
      kind: "error";
      error: { id?: string; code?: number; message?: string; reason?: string };
    };

/**
 * Submit any self-service flow and classify the answer. Refresh-required is
 * checked BEFORE following `redirect_browser_to`: Kratos points that redirect
 * at a refresh login on /login, which a signed-in browser would bounce off.
 */
export async function submitSelfServiceFlow(
  flow: KratosFlow,
  body: Record<string, unknown>
): Promise<SubmitFlowResult> {
  const action = resolveActionUrl(flow.ui.action);
  const method = (flow.ui.method || "POST").toUpperCase();
  const res = await fetch(action, {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const isJson = isJsonResponse(res);
  let data: unknown = null;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
  }
  const d = (typeof data === "object" && data !== null ? data : {}) as {
    session?: KratosSession;
    redirect_browser_to?: string;
    ui?: unknown;
    error?: { id?: string; code?: number; message?: string; reason?: string };
  };

  if (res.ok && d.session) return { kind: "session", session: d.session };
  if (d.error?.id === "session_refresh_required") {
    return { kind: "refresh_required" };
  }
  // Federated (oidc) submit, and a completed recovery code, answer HTTP 422
  // `browser_location_change_required` with the target in
  // `redirect_browser_to` (on some builds inside `error.reason`).
  let redirect = d.redirect_browser_to;
  if (!redirect && d.error?.reason) {
    const m = d.error.reason.match(/https?:\/\/\S+/);
    if (m) redirect = m[0];
  }
  if (redirect) return { kind: "redirect", to: redirect };
  if (typeof d.ui === "object" && d.ui !== null) {
    return { kind: "flow", flow: data as KratosFlow };
  }
  if (d.error) {
    return {
      kind: "error",
      error: {
        id: d.error.id,
        code: d.error.code ?? res.status,
        message: d.error.message ?? `Request failed (${res.status})`,
        reason: d.error.reason,
      },
    };
  }
  throw new Error(`Request failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// The signed-in user's own sessions (Kratos public API)
// ---------------------------------------------------------------------------

export interface KratosSessionListItem {
  id: string;
  authenticated_at?: string;
  devices?: Array<{ user_agent?: string; location?: string }>;
}

/** Your OTHER active sessions (Kratos `GET /sessions` excludes the current one). Throws on failure. */
export async function listOtherSessions(): Promise<KratosSessionListItem[]> {
  const res = await fetch(`${kratosPublic()}/sessions`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Could not list sessions (${res.status})`);
  return readJsonResponse<KratosSessionListItem[]>(res, UNEXPECTED_RESPONSE);
}

/** Sign out every OTHER session of yours (Kratos `DELETE /sessions`). Returns how many. */
export async function revokeOtherSessions(): Promise<number> {
  const res = await fetch(`${kratosPublic()}/sessions`, {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Could not sign out other devices (${res.status})`);
  try {
    const body = (await res.json()) as { count?: number };
    return typeof body.count === "number" ? body.count : 0;
  } catch {
    return 0;
  }
}

export async function submitLoginFlow(
  flow: KratosFlow,
  body: Record<string, unknown>
): Promise<SubmitLoginFlowResult> {
  const action = resolveActionUrl(flow.ui.action);
  const method = (flow.ui.method || "POST").toUpperCase();

  const res = await fetch(action, {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const isJson = isJsonResponse(res);
  let data: unknown = null;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
  }

  if (
    isJson &&
    res.ok &&
    typeof data === "object" &&
    data !== null &&
    "session" in data
  ) {
    const session = (data as { session?: KratosSession }).session;
    if (session) return { session };
  }

  // Federated (oidc) submit → Kratos asks the browser to leave for the Control
  // Plane. It answers HTTP 422 `browser_location_change_required` with the target
  // in top-level `redirect_browser_to` (and, on some builds, inside
  // `error.reason`). Surface it so the caller can navigate the browser.
  if (isJson && typeof data === "object" && data !== null) {
    const d = data as {
      redirect_browser_to?: string;
      error?: { id?: string; reason?: string };
    };
    let redirect = d.redirect_browser_to;
    if (!redirect && d.error?.reason) {
      const m = d.error.reason.match(/https?:\/\/\S+/);
      if (m) redirect = m[0];
    }
    if (redirect) return { redirectBrowserTo: redirect };
  }

  if (
    isJson &&
    typeof data === "object" &&
    data !== null &&
    "ui" in data &&
    typeof (data as KratosFlow).ui === "object"
  ) {
    return { flow: data as KratosFlow };
  }

  if (isJson && typeof data === "object" && data !== null && "error" in data) {
    const err = (
      data as {
        error?: {
          id?: string;
          code?: number;
          message?: string;
          reason?: string;
        };
      }
    ).error;

    if (err?.id === "session_already_available") {
      const session = await whoami();
      if (session) return { session };
    }

    return {
      structuralError: {
        id: err?.id,
        code: err?.code ?? res.status,
        message: err?.message ?? `Sign-in failed (${res.status})`,
        reason: err?.reason,
      },
    };
  }

  throw new Error(`Sign-in failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Error texts to show as a banner. `exclude` drops messages the caller renders
 * as an explicit state instead (see `isStateMessage` in `sign-in-state.ts`).
 */
export function collectErrorMessages(
  flow: KratosFlow,
  exclude?: (m: KratosMessage) => boolean
): string[] {
  const keep = (m: KratosMessage) =>
    m.type === "error" && !(exclude && exclude(m));
  const ui = (flow.ui.messages ?? []).filter(keep).map((m) => m.text);
  const node = flow.ui.nodes
    .flatMap((n) => n.messages ?? [])
    .filter(keep)
    .map((m) => m.text);
  return [...ui, ...node];
}

export function extractInitialValues(flow: KratosFlow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of flow.ui.nodes) {
    const name = n.attributes?.name;
    if (typeof name !== "string") continue;
    if (n.type !== "input") continue;
    const v = n.attributes?.value;
    if (typeof v === "string" && v) out[name] = v;
  }
  return out;
}

/**
 * After a flow refresh, hidden values (CSRF token in particular) rotate.
 * Preserve user-entered fields but pick up any new hidden defaults.
 */
export function mergeHiddenValues(
  prev: Record<string, string>,
  nextFlow: KratosFlow
): Record<string, string> {
  const merged = { ...prev };
  for (const n of nextFlow.ui.nodes) {
    const name = n.attributes?.name;
    if (typeof name !== "string") continue;
    if (n.attributes?.type === "hidden") {
      const v = n.attributes.value;
      if (typeof v === "string") merged[name] = v;
    }
  }
  return merged;
}
