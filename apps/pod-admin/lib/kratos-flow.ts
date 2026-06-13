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

const ENV_POD_URL = process.env.NEXT_PUBLIC_POD_URL?.trim() ?? "";

/**
 * Resolve the public pod URL at request time. The env var is preferred, but
 * when the docker image was built without `NEXT_PUBLIC_POD_URL` we derive
 * `pod.<root>` from `pod-admin.<root>`. This mirrors the runtime fallback
 * in `app/providers.tsx` and keeps a stale build from baking `undefined`
 * into the bundle.
 */
function publicPodUrl(): string {
  if (ENV_POD_URL) return ENV_POD_URL;
  if (typeof window === "undefined") return "";
  try {
    const u = new URL(window.location.origin);
    if (u.hostname.startsWith("pod-admin.")) {
      const root = u.hostname.slice("pod-admin.".length);
      return `${u.protocol}//pod.${root}`;
    }
    return window.location.origin;
  } catch {
    return window.location.origin;
  }
}

function kratosPublic(): string {
  return `${publicPodUrl().replace(/\/$/, "")}/.ory/kratos/public`;
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

export async function createLoginFlow(): Promise<CreateLoginFlowResult> {
  const res = await fetch(`${kratosPublic()}/self-service/login/browser`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    redirect: "follow",
  });

  if (res.status === 200) {
    const flow = (await res.json()) as KratosFlow;
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
  return (await res.json()) as KratosFlow;
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

  const isJson = (res.headers.get("content-type") ?? "").includes(
    "application/json"
  );
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
