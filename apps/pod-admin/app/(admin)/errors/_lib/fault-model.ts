/**
 * What a stored server fault (`system.listServerFaults` / `getServerFault`,
 * table `server_faults`) reads as: the CAUSE first, because that is what a
 * person opening an errorId came for.
 *
 * Pure, so the rules run in a test. The error texts are content (what the
 * code threw): shown as written, only made readable (a validation error's
 * JSON list of issues becomes "field.path: message" lines).
 */

export interface FaultCauseLike {
  name: string;
  message: string;
  stack?: string | null;
}

export interface FaultLike {
  errorId: string;
  occurredAt: Date | string;
  door: string;
  method: string | null;
  path: string | null;
  status: number;
  errorName: string;
  message: string;
  stack: string | null;
  causes: FaultCauseLike[];
}

/**
 * A validation library's error message is often the JSON of its issues (zod:
 * `[{ "path": ["playbooks", 0, "goal"], "message": "Too big…" }]`). Read it as
 * one line per issue, `playbooks[0].goal: Too big…`; any other text as is.
 */
export function readableMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  const issues = Array.isArray(parsed) ? parsed : [parsed];
  const lines: string[] = [];
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") return text;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== "string") return text;
    const where = Array.isArray(path) ? pathText(path) : "";
    lines.push(where ? `${where}: ${message}` : message);
  }
  return lines.length > 0 ? lines.join("\n") : text;
}

function pathText(path: unknown[]): string {
  return path
    .map((seg, i) =>
      typeof seg === "number"
        ? `[${seg}]`
        : i === 0
          ? String(seg)
          : `.${String(seg)}`
    )
    .join("");
}

/**
 * The error that explains the fault: the innermost cause (the first thing
 * that failed), else the error itself. A wrapper ("An unexpected error
 * occurred") never wins over what it wrapped.
 */
export function rootCause(fault: FaultLike): FaultCauseLike {
  return fault.causes.length > 0
    ? fault.causes[fault.causes.length - 1]!
    : { name: fault.errorName, message: fault.message, stack: fault.stack };
}

/** One line for a list row: the root cause's name and first readable line. */
export function faultHeadline(fault: FaultLike, max = 160): string {
  const cause = rootCause(fault);
  const first = readableMessage(cause.message).split("\n")[0]!.trim();
  const line = first ? `${cause.name}: ${first}` : cause.name;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The request the fault answered: `POST /api/hub/packages/apply`, `mutation entities.create`. */
export function faultRequest(fault: FaultLike): string {
  return [fault.method, fault.path].filter(Boolean).join(" ") || "—";
}

/**
 * The proposal an approval's fault belongs to (`door: "proposal"`, recorded by
 * `recordProposalFault` with the path `/proposal/<id>`), or null for any other
 * fault. No HTTP request happened for it: the path is a pointer to the
 * proposal, which the page opens as a link, never shows as a request.
 */
export function faultProposalId(fault: FaultLike): string | null {
  if (fault.door !== "proposal" || !fault.path) return null;
  const m = /^\/proposal\/([^/?#\s]+)$/.exec(fault.path);
  // Written raw (`/proposal/${proposalId}`, a uuid): read raw.
  return m ? m[1]! : null;
}

/**
 * The HTTP status to show, or null when the fault answered no HTTP request:
 * an approval's status is derived from its error class (`CLASS_TRPC_CODE`) to
 * keep the column's meaning, and reading it as "HTTP 500" would claim a
 * request that never was.
 */
export function faultHttpStatus(fault: FaultLike): number | null {
  return fault.door === "proposal" ? null : fault.status;
}
