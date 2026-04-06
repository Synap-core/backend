/**
 * Audit Logging Middleware
 *
 * Logs every tRPC mutation as structured JSON for compliance and debugging.
 * Uses @synap-core/core logger — no DB table, just structured logs that can
 * be shipped to a log aggregator (Loki, Datadog, etc.) later.
 */

import { t } from "../init-trpc.js";
import { createLogger } from "@synap-core/core";

const auditLogger = createLogger({ module: "audit" });

/**
 * Keys whose values should be redacted from audit log input.
 * Case-insensitive matching.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "private_key",
  "privatekey",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
]);

/**
 * Recursively sanitize an object, replacing sensitive values with "[REDACTED]".
 * Handles nested objects and arrays. Returns a new object (no mutation).
 */
function sanitizeInput(value: unknown, depth = 0): unknown {
  // Prevent infinite recursion on deeply nested / circular structures
  if (depth > 5) return "[TRUNCATED]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    // Truncate very long strings (e.g. base64 file content)
    return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    // Only log first 10 items to keep log size reasonable
    const truncated = value
      .slice(0, 10)
      .map((v) => sanitizeInput(v, depth + 1));
    if (value.length > 10) truncated.push(`...[${value.length - 10} more]`);
    return truncated;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeInput(val, depth + 1);
    }
  }
  return sanitized;
}

/**
 * Audit log middleware.
 *
 * Runs after the procedure completes (success or error) and logs mutation
 * details as structured JSON. Queries are not logged to keep volume manageable.
 */
export const auditLogMiddleware = t.middleware(async (opts) => {
  const result = await opts.next();

  if (opts.type === "mutation") {
    const ctx = opts.ctx as {
      userId?: string | null;
      workspaceId?: string | null;
    };

    // getRawInput() is async in tRPC v11 — best-effort, don't block on failure
    let input: unknown;
    try {
      input = sanitizeInput(await opts.getRawInput());
    } catch {
      input = "[unavailable]";
    }

    auditLogger.info(
      {
        action: opts.path,
        userId: ctx.userId ?? null,
        workspaceId: ctx.workspaceId ?? null,
        success: result.ok,
        input,
        timestamp: new Date().toISOString(),
      },
      `AUDIT: ${opts.path}`
    );
  }

  return result;
});
