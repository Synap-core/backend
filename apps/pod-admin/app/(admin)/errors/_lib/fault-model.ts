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
