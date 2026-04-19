/**
 * Kratos client — thin same-origin wrapper around Ory Kratos public endpoints.
 *
 * Mirrors the flow-creation / flow-fetch / flow-submit pattern from the browser
 * Electron app (see browser/electron/main/connection/connection-manager.ts), but
 * simpler: admin-ui runs in a real browser and is same-origin with the pod, so
 * cookies and CSRF are handled automatically by `credentials: "include"`.
 *
 * All endpoints live under `${API_URL}/.ory/kratos/public/`.
 */

import { API_URL } from "./trpc";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlowKind =
  | "login"
  | "registration"
  | "recovery"
  | "verification"
  | "settings";

export const FLOW_KINDS: FlowKind[] = [
  "login",
  "registration",
  "recovery",
  "verification",
  "settings",
];

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
  type?: FlowKind;
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

export interface KratosError extends Error {
  status: number;
  code?: string;
}

function makeError(
  message: string,
  status: number,
  code?: string
): KratosError {
  const err = new Error(message) as KratosError;
  err.status = status;
  if (code) err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function kratosPublic(): string {
  return `${API_URL.replace(/\/$/, "")}/.ory/kratos/public`;
}

/** Rewrite a Kratos absolute action URL (e.g. http://kratos:4433/...) to same-origin. */
export function resolveActionUrl(action: string): string {
  const base = kratosPublic();
  try {
    const u = new URL(action);
    const api = new URL(base);
    return `${api.origin}${u.pathname}${u.search}`;
  } catch {
    // action was already relative — keep it
    return action;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function whoami(
  signal?: AbortSignal
): Promise<KratosSession | null> {
  const res = await fetch(`${kratosPublic()}/sessions/whoami`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    signal,
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    throw makeError(`whoami failed (${res.status})`, res.status);
  }
  return (await res.json()) as KratosSession;
}

/**
 * Trigger the Kratos browser logout flow and follow the returned logout_url.
 * Returns true when the logout URL was navigated, false when we could not
 * obtain one (caller should clear local state and reload).
 */
export async function logout(): Promise<boolean> {
  try {
    const res = await fetch(`${kratosPublic()}/self-service/logout/browser`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { logout_url?: string };
    if (data.logout_url) {
      window.location.assign(data.logout_url);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Flow creation
// ---------------------------------------------------------------------------

export interface CreateFlowResult {
  flow?: KratosFlow;
  /** Set when Kratos detects an existing session and refuses to create a flow. */
  existingSession?: KratosSession;
}

/**
 * Create a new Kratos self-service flow of the given kind.
 *
 * Calls `/self-service/{kind}/browser` with `Accept: application/json`.
 * Kratos v1.3+ returns the flow JSON directly (200) in this case and sets
 * any required cookies. Same-origin keeps cookies automatic.
 *
 * When a session already exists, Kratos returns 400 with code
 * `session_already_available` — we surface the existing session so the caller
 * can short-circuit.
 */
export async function createFlow(kind: FlowKind): Promise<CreateFlowResult> {
  const res = await fetch(`${kratosPublic()}/self-service/${kind}/browser`, {
    credentials: "include",
    headers: { Accept: "application/json" },
    redirect: "follow",
  });

  if (res.status === 200) {
    const flow = (await res.json()) as KratosFlow;
    return { flow };
  }

  if (res.status === 400) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { id?: string };
    };
    if (body?.error?.id === "session_already_available") {
      const session = await whoami().catch(() => null);
      if (session) return { existingSession: session };
    }
    throw makeError(
      `Failed to create ${kind} flow (400)`,
      400,
      body?.error?.id
    );
  }

  throw makeError(`Failed to create ${kind} flow (${res.status})`, res.status);
}

/**
 * Fetch an existing flow by ID. Kratos's `/flows` endpoint is per-kind, so we
 * try each kind until one matches — the flow ID alone doesn't reveal its kind.
 */
export async function fetchFlowById(flowId: string): Promise<KratosFlow> {
  let lastStatus = 0;
  for (const kind of FLOW_KINDS) {
    const res = await fetch(
      `${kratosPublic()}/self-service/${kind}/flows?id=${encodeURIComponent(flowId)}`,
      { credentials: "include", headers: { Accept: "application/json" } }
    );
    if (res.ok) return (await res.json()) as KratosFlow;
    lastStatus = res.status;
  }
  throw makeError(
    `Could not load flow ${flowId} (last status ${lastStatus})`,
    lastStatus
  );
}

// ---------------------------------------------------------------------------
// Flow submission
// ---------------------------------------------------------------------------

export interface SubmitFlowResult {
  /** Kratos returned an updated flow with validation messages — re-render form. */
  flow?: KratosFlow;
  /** Kratos returned a session — auth succeeded. */
  session?: KratosSession;
  /**
   * Kratos returned a structural error (no flow body) — e.g. CSRF violation,
   * expired flow. Caller should typically recreate the flow.
   */
  structuralError?: {
    id?: string;
    code?: number;
    message?: string;
    reason?: string;
  };
}

/** Kratos error ids that indicate the current flow is unrecoverable and a new
 *  flow must be created. */
export const FLOW_RESET_ERROR_IDS = new Set([
  "security_csrf_violation",
  "security_identity_mismatch",
  "self_service_flow_expired",
  "self_service_flow_return_to_forbidden",
  "session_already_available",
]);

/**
 * Submit a Kratos flow. Posts to the action URL from the flow (normalized to
 * same-origin via `resolveActionUrl`). Returns one of:
 *   - `session`  → auth succeeded
 *   - `flow`     → validation failed (e.g. bad credentials) — re-render form
 *   - `structuralError` → CSRF / expired / session-already-available, caller
 *                         should recreate the flow
 */
export async function submitFlow(
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

  const data = (await res.json().catch(() => null)) as
    | (KratosFlow & { session?: KratosSession })
    | { session?: KratosSession; identity?: KratosSession["identity"] }
    | {
        error: {
          id?: string;
          code?: number;
          message?: string;
          reason?: string;
        };
      }
    | null;

  if (res.ok && data && "session" in data && data.session) {
    return { session: data.session };
  }

  // Some Kratos versions return 200 with just `identity` for registration.
  if (
    res.ok &&
    data &&
    "identity" in data &&
    (data as { identity?: unknown }).identity
  ) {
    const d = data as { identity: KratosSession["identity"]; id?: string };
    return {
      session: { id: d.id ?? "session", active: true, identity: d.identity },
    };
  }

  // Validation error — Kratos returned the flow with per-node messages.
  if (data && "ui" in data && data.ui?.nodes) {
    return { flow: data as KratosFlow };
  }

  // Structural error — no flow body, just {error: {...}}. Common shapes:
  //   CSRF:     {id:"security_csrf_violation", code:403, message:"…"}
  //   Expired:  {id:"self_service_flow_expired", code:410, message:"…"}
  //   Session:  {id:"session_already_available", code:400, message:"…"}
  if (data && "error" in data && data.error) {
    return { structuralError: data.error };
  }

  throw makeError(`Flow submission failed (${res.status})`, res.status);
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/** Collect error messages from a flow (ui-level + node-level). */
export function collectErrorMessages(flow: KratosFlow): string[] {
  const uiMsgs = (flow.ui.messages ?? [])
    .filter((m) => m.type === "error")
    .map((m) => m.text);
  const nodeMsgs = flow.ui.nodes
    .flatMap((n) => n.messages ?? [])
    .filter((m) => m.type === "error")
    .map((m) => m.text);
  return [...uiMsgs, ...nodeMsgs];
}

/** Pull initial form values (hidden defaults, CSRF token) from a flow's nodes. */
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
