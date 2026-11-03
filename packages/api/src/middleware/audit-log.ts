/**
 * Audit Logging Middleware
 *
 * Logs every tRPC mutation as structured JSON for compliance and debugging.
 * Uses @synap-core/core logger — no DB table, just structured logs that can
 * be shipped to a log aggregator (Loki, Datadog, etc.) later.
 */

import { t } from "../init-trpc.js";
import { createLogger } from "@synap-core/core";
import { redactPayloadForLog } from "../utils/redact-secrets.js";

const auditLogger = createLogger({ module: "audit" });

/** Longest string kept in an audit line (e.g. base64 file content). */
const AUDIT_STRING_MAX = 500;
const AUDIT_DEPTH_LIMIT = 5;
const AUDIT_ARRAY_MAX = 10;

/**
 * A copy of a mutation's input that is SAFE TO LOG and short enough to keep.
 *
 * The redaction is the pod's one log redactor, {@link redactPayloadForLog}
 * (`utils/redact-secrets.ts`). This file used to keep its own exact-match key
 * list, so `secretsVault.create`'s typed secret (`input.value`) and every
 * compound key (`clientSecret`, `githubToken`) reached the logs in plaintext
 * (CP ticket 84f82ed3). What is left here is only the SHAPE of a log line:
 * strings, arrays and depth are cut, after the redaction, so a secret cannot
 * survive by being long.
 */
export function sanitizeAuditInput(path: string, input: unknown): unknown {
  return shapeForLog(redactPayloadForLog(input, path), 0);
}

function shapeForLog(value: unknown, depth: number): unknown {
  // Prevent infinite recursion on deeply nested / circular structures
  if (depth > AUDIT_DEPTH_LIMIT) return "[TRUNCATED]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    // Truncate very long strings (e.g. base64 file content)
    return value.length > AUDIT_STRING_MAX
      ? `${value.slice(0, AUDIT_STRING_MAX)}...[truncated]`
      : value;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    // Only log first 10 items to keep log size reasonable
    const truncated: unknown[] = value
      .slice(0, AUDIT_ARRAY_MAX)
      .map((v) => shapeForLog(v, depth + 1));
    if (value.length > AUDIT_ARRAY_MAX) {
      truncated.push(`...[${value.length - AUDIT_ARRAY_MAX} more]`);
    }
    return truncated;
  }

  const shaped: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(shaped, key, {
      value: shapeForLog(val, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return shaped;
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
      input = sanitizeAuditInput(opts.path, await opts.getRawInput());
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
