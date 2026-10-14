/**
 * /health's `authHealth`: is sign-in (Ory Kratos) ready? Same rule as `data`
 * (pod-data-status.ts): a body field, never a non-200 — canary swaps and
 * healthchecks gate on the HTTP status, and a backend that serves while Kratos
 * crash-loops is exactly the state the Control Plane could not see (W6-HEAL N3:
 * its health check only read `response.ok`). The pre-existing `auth: "ory-stack"`
 * string names the stack and is left as it is.
 */
import { createLogger } from "@synap-core/core";

import type { ErrorLog } from "./pod-data-status.js";

const authLogger = createLogger({ module: "pod-auth-status" });
const logToServer: ErrorLog = (err, msg) => authLogger.warn({ err }, msg);

export interface AuthHealth {
  /** ready · not_ready (Kratos answered non-200, or did not answer) · unknown (no Kratos to ask) */
  status: "ready" | "not_ready" | "unknown";
  checkedAt: string;
  /** A fixed public phrase; the detail is in the server log. */
  error?: string;
}

export interface AuthHealthDeps {
  /** Kratos public base URL; null = this pod runs without Kratos (LOCAL_MODE). */
  kratosPublicUrl: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  log?: ErrorLog;
}

export async function checkAuthHealth(
  deps: AuthHealthDeps
): Promise<AuthHealth> {
  const checkedAt = (deps.now ?? (() => new Date()))().toISOString();
  if (!deps.kratosPublicUrl) {
    return { status: "unknown", checkedAt, error: "no Kratos configured" };
  }
  const url = `${deps.kratosPublicUrl.replace(/\/$/, "")}/health/ready`;
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? 2000),
    });
    if (res.ok) return { status: "ready", checkedAt };
    (deps.log ?? logToServer)(
      new Error(`HTTP ${res.status}`),
      "GET /health: Kratos not ready"
    );
    return { status: "not_ready", checkedAt, error: "Kratos is not ready" };
  } catch (err) {
    (deps.log ?? logToServer)(err, "GET /health: Kratos unreachable");
    return { status: "not_ready", checkedAt, error: "Kratos did not answer" };
  }
}

/** Memoize for `ttlMs` so /health stays cheap under 10 s probes. */
export function cachedAuthHealth(
  deps: AuthHealthDeps,
  ttlMs = 30_000
): () => Promise<AuthHealth> {
  let last: { at: number; value: Promise<AuthHealth> } | null = null;
  return () => {
    const t = Date.now();
    if (!last || t - last.at > ttlMs)
      last = { at: t, value: checkAuthHealth(deps) };
    return last.value;
  };
}
