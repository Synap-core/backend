/**
 * A Zod refusal read as FIELD ERRORS — the one projection both write doors
 * hand to clients (tRPC `error.data.fieldErrors`, Hub REST 400 `fieldErrors`).
 *
 * Shape: `{ "<dotted path>": ["<message>", …] }`. The path is the issue's path
 * joined with "." (`items.0.title`); an issue about the input as a whole (empty
 * path) is keyed `""`. Only zod's messages travel: never `issue.input`, never a
 * received value, so a refusal cannot echo what the caller sent.
 *
 * Duck-typed (`name === "ZodError"` + an `issues` array), like the MCP door's
 * `zodIssues` (routers/mcp/tool-errors.ts): a ZodError from another zod copy
 * still reads.
 */

import type { FieldErrors } from "@synap-core/types/errors";

export interface ZodIssueLike {
  path?: readonly PropertyKey[];
  message?: unknown;
}

export function zodIssuesOf(err: unknown): ZodIssueLike[] | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; issues?: unknown };
  if (e.name !== "ZodError" || !Array.isArray(e.issues)) return null;
  return e.issues as ZodIssueLike[];
}

function pathOf(issue: ZodIssueLike): string {
  return Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
}

function messageOf(issue: ZodIssueLike): string {
  return typeof issue.message === "string" && issue.message
    ? issue.message
    : "Invalid value";
}

export function zodFieldErrors(issues: readonly ZodIssueLike[]): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    (out[pathOf(issue)] ??= []).push(messageOf(issue));
  }
  return out;
}

/**
 * The same issues as ONE human sentence (`title: Too small, kind: Required`),
 * for the `message` beside `fieldErrors` — never zod's JSON dump of the issue
 * array, which is what `ZodError.message` is.
 */
export function zodIssuesSentence(issues: readonly ZodIssueLike[]): string {
  const parts = issues.map((issue) => {
    const path = pathOf(issue);
    return path ? `${path}: ${messageOf(issue)}` : messageOf(issue);
  });
  return parts.join(", ") || "Validation failed";
}
