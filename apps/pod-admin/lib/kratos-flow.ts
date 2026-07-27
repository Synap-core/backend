/**
 * Kratos browser-flow client for pod-admin.
 *
 * Pod-admin runs on `pod-admin.<root>` while Kratos public endpoints live on
 * `pod.<root>/.ory/kratos/public`. The Kratos session cookie is scoped to the
 * parent domain, so `credentials: "include"` carries it across the subdomain
 * boundary. Kratos must be configured to allow the pod-admin origin in CORS.
 *
 * Scope is intentionally minimal: only what the login page needs (flow create,
 * flow fetch, flow submit). Recovery / settings / verification are not handled
 * here — those still live in the pod's bootstrap surface.
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

export interface KratosUiNode {
  type: string;
  group?: string;
  messages?: { type: string; text: string }[];
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
  messages?: { type: string; text: string }[];
}

export interface KratosFlow {
  id: string;
  type?: string;
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
  returnTo?: string
): Promise<CreateLoginFlowResult> {
  // `return_to` brings the browser back here after a federated (oidc) round-trip
  // through the Control Plane. It must be an allowed Kratos return URL — the
  // pod-admin origin is allow-listed in the pod's kratos.yml. Kratos ignores it
  // for a plain password login, so it is always safe to pass.
  const url = new URL(`${kratosPublic()}/self-service/login/browser`);
  if (returnTo) url.searchParams.set("return_to", returnTo);
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

export async function fetchLoginFlow(flowId: string): Promise<KratosFlow> {
  const res = await fetch(
    `${kratosPublic()}/self-service/login/flows?id=${encodeURIComponent(flowId)}`,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
    }
  );
  if (!res.ok) {
    let body: { error?: { message?: string; reason?: string } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* ignore */
    }
    throw new Error(
      body.error?.message ?? `Login flow ${flowId} not found (${res.status})`
    );
  }
  return readJsonResponse<KratosFlow>(
    res,
    "Pod authentication returned an unexpected response. Verify this Pod's API and Pod Admin deployment addresses."
  );
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

export function collectErrorMessages(flow: KratosFlow): string[] {
  const ui = (flow.ui.messages ?? [])
    .filter((m) => m.type === "error")
    .map((m) => m.text);
  const node = flow.ui.nodes
    .flatMap((n) => n.messages ?? [])
    .filter((m) => m.type === "error")
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
