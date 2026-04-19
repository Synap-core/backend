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
 * Handles edge cases:
 * - 400 "session_already_available" → user has existing session
 * - 400 "flow expired" → try again
 * - 503 Kratos unavailable
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

  // Parse error response
  let errorInfo: { id?: string; message?: string; reason?: string } = {};
  try {
    errorInfo = (await res.json()) as typeof errorInfo;
  } catch {
    // Not JSON
  }

  // Session already exists - get existing session
  if (res.status === 400 && errorInfo?.id === "session_already_available") {
    const session = await whoami().catch(() => null);
    if (session) {
      return { existingSession: session };
    }
    // Can't get session - might be transient, try again
  }

  // Flow expired or invalid - suggest recreating
  if (res.status === 400 && (errorInfo?.reason?.includes("flow") || errorInfo?.message?.includes("flow"))) {
    throw makeError(
      errorInfo.message || "Flow expired. Please try again.",
      400,
      "flow_expired"
    );
  }

  // Service unavailable
  if (res.status === 503) {
    throw makeError(
      errorInfo.message || "Authentication service temporarily unavailable",
      503,
      "service_unavailable"
    );
  }

  // Generic error
  throw makeError(
    errorInfo?.message 
      ? `${errorInfo.message}${errorInfo.reason ? `: ${errorInfo.reason}` : ''}`
      : `Failed to create ${kind} flow (${res.status})`,
    res.status,
    errorInfo?.id
  );
}

/**
 * Fetch an existing flow by ID. Kratos's `/flows` endpoint is per-kind, so we
 * try each kind until one matches — the flow ID alone doesn't reveal its kind.
 * 
 * Handles edge cases:
 * - 400 with "flow query parameter is missing or malformed" → flow expired/invalid
 * - 404 → flow not found
 * - 410 → flow expired
 */
export async function fetchFlowById(flowId: string): Promise<KratosFlow> {
  let lastStatus = 0;
  let lastError: string | undefined;

  for (const kind of FLOW_KINDS) {
    const res = await fetch(
      `${kratosPublic()}/self-service/${kind}/flows?id=${encodeURIComponent(flowId)}`,
      { 
        credentials: "include", 
        headers: { Accept: "application/json" }
      }
    );
    
    if (res.ok) {
      const flow = (await res.json()) as KratosFlow;
      // Verify the flow type matches to avoid confusion
      if (!flow.type || flow.type === kind) {
        return flow;
      }
      // Type mismatch - continue searching
    }
    
    lastStatus = res.status;
    
    // Capture error message for better diagnostics
    if (res.status >= 400) {
      try {
        const errBody = await res.json().catch(() => ({}));
        lastError = errBody?.error?.message || errBody?.error?.reason;
      } catch {
        lastError = undefined;
      }
    }
  }

  // If we get here, flow wasn't found in any kind
  // Provide specific error messages for common cases
  if (lastStatus === 400) {
    throw makeError(
      lastError || `Flow expired or invalid (400)`,
      400,
      "flow_expired_or_invalid"
    );
  }
  
  if (lastStatus === 404 || lastStatus === 410) {
    throw makeError(
      lastError || `Flow not found (${lastStatus})`,
      lastStatus,
      "flow_not_found"
    );
  }

  throw makeError(
    `Could not load flow ${flowId} (last status ${lastStatus})${lastError ? `: ${lastError}` : ''}`,
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
 * 
 * Handles edge cases:
 * - 400 "flow query parameter is missing or malformed" → flow expired
 * - 403 CSRF → need new flow
 * - 410 Gone → flow expired
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

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  
  let data: unknown = null;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      // Not valid JSON
    }
  }

  // Type guard helpers
  const isFlowWithSession = (d: unknown): d is KratosFlow & { session?: KratosSession } => {
    return typeof d === "object" && d !== null && "session" in d;
  };
  
  const isFlowWithIdentity = (d: unknown): d is { identity?: unknown; id?: string } => {
    return typeof d === "object" && d !== null && "identity" in d;
  };
  
  const isFlowWithUi = (d: unknown): d is KratosFlow => {
    return typeof d === "object" && d !== null && "ui" in d && typeof (d as KratosFlow).ui === "object";
  };
  
  const isErrorResponse = (d: unknown): d is { error?: { id?: string; code?: number; message?: string; reason?: string } } => {
    return typeof d === "object" && d !== null && "error" in d;
  };

  // Success: session returned
  if (isJson && res.ok && isFlowWithSession(data) && data.session) {
    return { session: data.session };
  }

  // Success for registration: identity returned
  if (
    isJson &&
    res.ok &&
    isFlowWithIdentity(data) &&
    isFlowWithIdentity(data).identity
  ) {
    const d = data as { identity: KratosSession["identity"]; id?: string };
    return {
      session: { id: d.id ?? "session", active: true, identity: d.identity },
    };
  }

  // Validation error — Kratos returned the flow with per-node messages.
  if (isJson && isFlowWithUi(data)) {
    return { flow: data as KratosFlow };
  }

  // Check for specific error conditions
  if (isJson && isErrorResponse(data)) {
    const err = data.error;
    
    // Check for flow expired/invalid conditions
    if (err?.reason?.includes("flow query parameter")) {
      return { 
        structuralError: {
          id: "flow_expired",
          code: 400,
          message: "Flow expired or invalid. Please try again.",
          reason: err.reason
        }
      };
    }
    
    // CSRF or other unrecoverable errors
    if (err?.id === "security_csrf_violation") {
      return { 
        structuralError: {
          id: err.id,
          code: err.code || 403,
          message: err.message || "Security check failed. Please try again.",
          reason: err.reason
        }
      };
    }
    
    if (err?.id === "self_service_flow_expired") {
      return { 
        structuralError: {
          id: err.id,
          code: err.code || 410,
          message: err.message || "Flow expired. Please try again.",
          reason: err.reason
        }
      };
    }

    // Session already available - user is already logged in
    if (err?.id === "session_already_available") {
      // Try to get the existing session
      const session = await whoami().catch(() => null);
      if (session) {
        return { session };
      }
      // If we can't get session, return structural error
      return { 
        structuralError: {
          id: err.id,
          code: err.code || 400,
          message: err.message || "Already logged in",
          reason: err.reason
        }
      };
    }

    // Return the structural error for caller to handle
    return { 
      structuralError: {
        id: err?.id,
        code: err?.code || res.status,
        message: err?.message || `Error (${res.status})`,
        reason: err?.reason
      }
    };
  }

  // Non-JSON or unexpected response
  throw makeError(
    `Flow submission failed (${res.status}): ${isJson ? JSON.stringify(data).slice(0, 200) : 'Non-JSON response'}`,
    res.status
  );
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
