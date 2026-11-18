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

import { isUuid } from "@synap-core/types/property-render";
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
  /**
   * What the card shows by default is what the tool DOES: the text, the
   * account in words. An id, a credential or an empty value is `detail`, said
   * once behind "Details".
   */
  detail: boolean;
  /**
   * The person may change it before approving (text only in v1): the stored
   * value is text, not a credential, not an id, not a link.
   */
  editable: boolean;
  /** The text as the agent proposed it, when `editable`. */
  raw: string | null;
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

/** An identifier: said once behind Details, never as the card's content. */
function isIdLike(key: string, text: string): boolean {
  const t = text.trim();
  if (isUuid(t)) return true;
  return /(^|[_\s-])ids?$|[a-z]Ids?$/.test(key) && !/\s/.test(t);
}

/** Every argument of the call: text first, then the rest, each with its reading. */
export function toolRunArguments(run: ProposalToolRun): ToolRunArgument[] {
  const all = run.parameters.map((param): ToolRunArgument => {
    const value = toolRunValue(param);
    const text = typeof param.value === "string" ? param.value : null;
    const idLike = text !== null && isIdLike(param.key, text);
    const detail = value.kind === "secret" || value.kind === "empty" || idLike;
    return {
      key: param.key,
      label: param.label,
      description: param.description ?? null,
      value,
      wide: isWide(value),
      detail,
      editable:
        text !== null && !param.secret && !idLike && value.kind !== "link",
      raw: text !== null && !param.secret ? text : null,
    };
  });
  // The text the tool will send leads; the order within a group is the pod's.
  const lead = all.filter((a) => a.editable);
  return [...lead, ...all.filter((a) => !a.editable)];
}

/** The arguments the card shows, and those it keeps behind Details. */
export function toolRunSplit(run: ProposalToolRun): {
  shown: ToolRunArgument[];
  detail: ToolRunArgument[];
} {
  const all = toolRunArguments(run);
  return {
    shown: all.filter((a) => !a.detail),
    detail: all.filter((a) => a.detail),
  };
}

/**
 * The drafts that actually differ from what was proposed: the ONLY thing an
 * "Approve with your changes" sends. An untouched or restored text is no
 * change, and an argument that is not editable text is never sent.
 */
export function changedDrafts(
  run: ProposalToolRun,
  drafts: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of toolRunArguments(run)) {
    const draft = drafts[arg.key];
    if (arg.editable && draft !== undefined && draft !== arg.raw) {
      out[arg.key] = draft;
    }
  }
  return out;
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
