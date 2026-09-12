/**
 * MCP error door — the ONE seam that turns a thrown tool error into a
 * spec-compliant `isError: true` tool RESULT instead of a JSON-RPC -32603
 * "Internal error" protocol crash.
 *
 * Why this exists: a thrown error escapes the SDK as a protocol-level failure,
 * which clients render as a hard tool break the model cannot recover from. An
 * `isError: true` result is TEXT the model reads — so it can correct itself and
 * retry. Every message here therefore names the problem AND the next action
 * (same contract as the unknown-tool error in adapter.ts and the soft
 * "no skill found" string in services/capability-briefs/load-skill.ts).
 *
 * Disclosure rule: raw driver output (SQL text, schema, bound parameters) and
 * stack traces NEVER reach the caller — they are logged pod-side and replaced
 * with a safe, actionable sentence.
 *
 * NOT an error path: a governed write returning `{status:"proposed"}` is a
 * SUCCESS result. It never throws, so it never reaches this module.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "@synap-core/core";

const logger: any = createLogger({ module: "mcp-tool-errors" });

/** Build a spec-compliant recoverable tool error (text the model can act on). */
export function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lens args that land in a `uuid` DB column (workspaces.id / projects.id).
 * A non-UUID string here reaches postgres and throws 22P02
 * (invalid_text_representation), whose driver error embeds the whole query —
 * so we reject it up front with a message that names the recovery call.
 */
const UUID_ARGS = ["workspaceId", "projectId"] as const;

/**
 * Reject obviously-malformed UUID lens args BEFORE they reach the driver.
 * Returns null when the args are fine.
 */
export function validateUuidArgs(
  args: Record<string, unknown>,
  toolName: string
): CallToolResult | null {
  for (const key of UUID_ARGS) {
    const value = args[key];
    if (typeof value === "string" && !UUID_RE.test(value)) {
      return toolError(
        `Tool '${toolName}' got an invalid ${key}: "${value}" is not a UUID. ` +
          `Call synap_orient() with no arguments to list the ${key === "workspaceId" ? "workspaces" : "projects"} you can access, then retry with one of their ids.`
      );
    }
  }
  return null;
}

/**
 * Driver / query errors, whose `message` embeds SQL and bound parameters.
 *
 * The `query` probe is the load-bearing one: drizzle-orm 0.45.2's
 * DrizzleQueryError (node_modules/drizzle-orm/errors.cjs:35-44) builds its
 * message as `Failed query: ${query}\nparams: ${params}` and sets `this.query`
 * — but never sets `name`, so it reports as a plain "Error". A name-only check
 * would miss it and leak the whole statement. That leak is the observed bug:
 * a non-UUID workspaceId dumped the full query + schema to the agent.
 * `severity`/SQLSTATE `code` catch postgres.js's PostgresError directly.
 */
function isDriverError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    e.name === "PostgresError" ||
    typeof e.severity === "string" ||
    typeof e.query === "string" ||
    (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code))
  );
}

/**
 * Postgres INTEGRITY violations (SQLSTATE class 23) — a DETERMINISTIC rejection,
 * not a transient fault.
 *
 * 23503 foreign_key_violation · 23505 unique_violation · 23502 not_null_violation
 * · 23514 check_violation · 23P01 exclusion_violation.
 *
 * WHY THIS IS ITS OWN BRANCH (measured 2026-09-12): every structured
 * `synap_capture` create died on `entities_source_proposal_id_fkey` and the
 * generic storage-fault text told the model "Retry once". That advice is WRONG
 * for 23xxx: the same arguments against the same data will fail identically
 * forever, so a retry is pure waste and — worse — makes a permanent defect read
 * as flakiness to whoever reads the logs. The honest sentence names the class,
 * says a retry changes nothing, and points at the one action that does help.
 *
 * DISCLOSURE: the CONSTRAINT NAME only. Never the query, the bound parameters,
 * the failing row, or postgres's `detail` (which quotes the offending values).
 * The name is schema vocabulary the agent can act on; the rest is caller data.
 */
const INTEGRITY_SQLSTATE_RE = /^23[0-9A-Z]{3}$/;
/** Defensive: an identifier, capped — never a free-text field echoed onward. */
const CONSTRAINT_NAME_RE = /^[A-Za-z0-9_.$]{1,120}$/;

function integrityViolation(
  err: unknown
): { code: string; constraint?: string } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  if (typeof e.code !== "string" || !INTEGRITY_SQLSTATE_RE.test(e.code))
    return null;
  // postgres.js spells it `constraint_name`; node-postgres spells it
  // `constraint`. Accept both rather than betting on the driver.
  const raw = e.constraint_name ?? e.constraint;
  const constraint =
    typeof raw === "string" && CONSTRAINT_NAME_RE.test(raw) ? raw : undefined;
  return constraint ? { code: e.code, constraint } : { code: e.code };
}

/** Flatten a ZodError into a capped, readable issue list (never the raw dump). */
function zodIssues(err: unknown): string[] | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; issues?: unknown };
  if (e.name !== "ZodError" || !Array.isArray(e.issues)) return null;
  return e.issues.slice(0, 5).map((i) => {
    const issue = i as { path?: unknown[]; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
    return path ? `${path}: ${issue.message}` : String(issue.message);
  });
}

/**
 * Map ANY thrown value to a safe, actionable `isError: true` result.
 * Driver errors are logged in full pod-side and never disclosed.
 */
export function toSafeToolError(
  err: unknown,
  toolName: string
): CallToolResult {
  // Unwrap one level of `cause` so a wrapped driver error is still caught.
  const cause = (err as { cause?: unknown } | null)?.cause;

  // Integrity violations are checked FIRST: they also satisfy isDriverError
  // (they carry a SQLSTATE), so the generic storage branch below would otherwise
  // swallow them and hand back the wrong "Retry once" advice.
  const integrity = integrityViolation(err) ?? integrityViolation(cause);
  if (integrity) {
    logger.error(
      { err, toolName, sqlstate: integrity.code },
      "MCP tool failed a data-integrity rule (deterministic — not retryable)"
    );
    return toolError(
      `Tool '${toolName}' was rejected by a data-integrity rule in the pod's database` +
        (integrity.constraint ? ` (${integrity.constraint})` : "") +
        `. Nothing was written. This is DETERMINISTIC — the same call will fail identically on retry, so do not retry it. ` +
        `Either the arguments reference something that does not exist or conflicts with an existing row, or this is a pod-side defect. ` +
        `Check the ids you passed resolve (synap_get_entity / synap_orient); if they do, call synap_diagnose() and report ` +
        (integrity.constraint
          ? `the constraint name above`
          : `this tool call`) +
        ` rather than retrying.`
    );
  }

  if (isDriverError(err) || isDriverError(cause)) {
    logger.error({ err, toolName }, "MCP tool failed with a driver error");
    return toolError(
      `Tool '${toolName}' failed against the pod's storage layer. This is a pod-side fault, not something your arguments caused — the details were logged. ` +
        `Retry once; if it persists, call synap_diagnose() and report the incident.`
    );
  }

  const issues = zodIssues(err);
  if (issues) {
    logger.warn({ err, toolName }, "MCP tool rejected invalid arguments");
    return toolError(
      `Tool '${toolName}' rejected the arguments: ${issues.join("; ")}. ` +
        `Some fields listed may belong to a variant you didn't intend — re-read the tool's inputSchema, and call synap_list_profiles() to confirm a profileSlug before retrying.`
    );
  }

  // Intentional handler errors (scope denials, unknown tool, not-found) already
  // carry actionable prose. `.message` never contains a stack trace.
  const message = err instanceof Error ? err.message : String(err);
  logger.warn({ err, toolName }, "MCP tool error");
  return toolError(message.slice(0, 500));
}
