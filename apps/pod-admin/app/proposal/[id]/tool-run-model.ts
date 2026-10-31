/**
 * A tool run's arguments as the reviewer reads them — pure, so every rule is
 * tested apart from the markup. The pod hands the call (`review.toolRun`,
 * `describeToolRun`): its action, its tool, each argument with its label and
 * the value the agent passed. This decides only how each value READS:
 *
 *   - a short value inline, a web address as a link;
 *   - a value of several lines (a cloud-init script, a prompt) as code, whole —
 *     folded after `CODE_LINES_SHOWN` lines, never cut: approving it sends
 *     every line (founder dogfood 2026-10-30, proposal 4b5e040e, whose 60-line
 *     `userData` the old card reduced to the words "User data");
 *   - a list of words as chips; any other structure as its JSON, whole;
 *   - a secret as a mark: the pod never sent its value.
 */

import type {
  ProposalToolRun,
  ProposalToolRunParameter,
} from "@synap-core/types/proposals/capability-run";

export type ToolRunValue =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "code"; text: string; lines: number }
  | { kind: "list"; items: string[] }
  | { kind: "yes" | "no" | "empty" | "secret" };

export interface ToolRunArgument {
  key: string;
  label: string;
  description: string | null;
  value: ToolRunValue;
  /** Takes the section's whole width (code, long text). */
  wide: boolean;
}

/** A single-line text past this many characters takes the whole width. */
const WIDE_TEXT_CHARS = 80;

function code(text: string): ToolRunValue {
  return { kind: "code", text, lines: text.split("\n").length };
}

/** One value, in the reading its shape gives it. */
export function toolRunValue(
  param: Pick<ProposalToolRunParameter, "value" | "secret">
): ToolRunValue {
  if (param.secret) return { kind: "secret" };
  const v = param.value;
  if (v === null || v === undefined) return { kind: "empty" };
  if (typeof v === "boolean") return { kind: v ? "yes" : "no" };
  if (typeof v === "number" || typeof v === "bigint") {
    return { kind: "text", text: String(v) };
  }
  if (typeof v === "string") {
    if (v.trim() === "") return { kind: "empty" };
    if (v.includes("\n")) return code(v);
    const t = v.trim();
    return /^https?:\/\/\S+$/i.test(t)
      ? { kind: "link", href: t, text: t.replace(/^https?:\/\//i, "") }
      : { kind: "text", text: v };
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: "empty" };
    if (
      v.every((item) => typeof item === "string" || typeof item === "number")
    ) {
      return { kind: "list", items: v.map(String) };
    }
  }
  if (typeof v === "object" && Object.keys(v as object).length === 0) {
    return { kind: "empty" };
  }
  return code(JSON.stringify(v, null, 2));
}

function isWide(value: ToolRunValue): boolean {
  return (
    value.kind === "code" ||
    (value.kind === "text" && value.text.length > WIDE_TEXT_CHARS)
  );
}

/** Every argument of the call, in the pod's order, each with its reading. */
export function toolRunArguments(run: ProposalToolRun): ToolRunArgument[] {
  return run.parameters.map((param) => {
    const value = toolRunValue(param);
    return {
      key: param.key,
      label: param.label,
      description: param.description ?? null,
      value,
      wide: isWide(value),
    };
  });
}

/** The call in the review's own read (`review.toolRun`), or `null`. */
export function reviewToolRun(review: unknown): ProposalToolRun | null {
  const run =
    review && typeof review === "object"
      ? (review as { toolRun?: unknown }).toolRun
      : undefined;
  if (!run || typeof run !== "object") return null;
  const r = run as Partial<ProposalToolRun>;
  return typeof r.action === "string" && Array.isArray(r.parameters)
    ? (r as ProposalToolRun)
    : null;
}
