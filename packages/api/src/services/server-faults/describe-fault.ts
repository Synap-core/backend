/**
 * What a server fault WAS, in a shape a person can read and a row can hold:
 * the original error's name, message and stack, and its `cause` chain.
 *
 * WHY: a 5xx's client body is generic on purpose (`middleware/error-egress.ts`),
 * so the log and the `server_faults` row are the only places the cause lives.
 * Before this, the REST door logged the WRAPPER `toSynapError` made ("An
 * unexpected error occurred", the wrapper's own stack) and the real cause sat
 * nested under `err.context.originalError` as a string, where a reader missed
 * it (errorId a74f6adc, 2026-11-02: a ZodError "Too big … playbooks[0].stages[2]
 * .goal" was there, unread).
 *
 * Redaction, here once for the log and the row alike:
 *  - a Drizzle query error's message is `Failed query: <sql>\nparams: <values>`;
 *    the SQL is kept (it names the table and the clause that failed), the
 *    bound values are cut: they can be anything a caller sent (a token, an
 *    email, a body field);
 *  - every text is capped, so one runaway message cannot fill a row or a log line;
 *  - the chain stops at {@link MAX_CAUSE_DEPTH} and at a cycle.
 * A request body never reaches this function; the path is redacted by the caller.
 */

export interface DescribedError {
  name: string;
  message: string;
  stack: string | null;
}

export interface DescribedFault extends DescribedError {
  /** The `cause` chain, outermost first (the error's cause, then its cause …). */
  causes: DescribedError[];
}

export const MAX_CAUSE_DEPTH = 5;
const MAX_MESSAGE = 4_000;
const MAX_STACK = 8_000;

/**
 * Cut a Drizzle query error's bound values (keep its SQL), a URL's credential
 * query parameters and a bearer token: the values a message most often
 * carries that are someone's secret.
 */
export function redactFaultText(text: string): string {
  return text
    .replace(/\nparams: [\s\S]*$/, "\nparams: [redacted]")
    .replace(
      /([?&](?:api[_-]?key|key|token|access_token|secret|password|signature|sig|code)=)[^&\s"'#]+/gi,
      "$1[redacted]"
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]");
}

function cap(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}… [${text.length - max} more characters]`
    : text;
}

function isErrorLike(v: unknown): v is Error {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { message?: unknown }).message === "string" &&
    (v instanceof Error || typeof (v as { name?: unknown }).name === "string")
  );
}

function describeOne(v: unknown): DescribedError {
  if (isErrorLike(v)) {
    const name =
      (typeof v.name === "string" && v.name) || v.constructor?.name || "Error";
    return {
      name,
      message: cap(redactFaultText(v.message), MAX_MESSAGE),
      stack:
        typeof v.stack === "string"
          ? cap(redactFaultText(v.stack), MAX_STACK)
          : null,
    };
  }
  return {
    name: typeof v,
    message: cap(redactFaultText(String(v)), MAX_MESSAGE),
    stack: null,
  };
}

/**
 * A `SynapError` made by `toSynapError` keeps the original ONLY as strings in
 * `context.originalError` / `context.stack`. Read them back as a cause, so a
 * handler that wrapped its own error still shows what failed.
 */
function wrappedOriginal(v: unknown): DescribedError | null {
  const ctx = (v as { context?: unknown } | null)?.context;
  if (!ctx || typeof ctx !== "object") return null;
  const { originalError, stack } = ctx as {
    originalError?: unknown;
    stack?: unknown;
  };
  if (typeof originalError !== "string") return null;
  const stackText = typeof stack === "string" ? stack : null;
  // The stack's first line names the original's class ("ZodError: …").
  const named = stackText ? /^([A-Za-z_$][\w$]*):/.exec(stackText) : null;
  return {
    name: named?.[1] ?? "Error",
    message: cap(redactFaultText(originalError), MAX_MESSAGE),
    stack: stackText ? cap(redactFaultText(stackText), MAX_STACK) : null,
  };
}

/** Describe `err` and its cause chain (bounded, cycle-safe). */
export function describeFault(err: unknown): DescribedFault {
  const head = describeOne(err);
  const causes: DescribedError[] = [];
  const wrapped = wrappedOriginal(err);
  if (wrapped) causes.push(wrapped);

  const seen = new Set<unknown>([err]);
  let next: unknown = (err as { cause?: unknown } | null)?.cause;
  while (
    next !== undefined &&
    next !== null &&
    causes.length < MAX_CAUSE_DEPTH &&
    !seen.has(next)
  ) {
    seen.add(next);
    causes.push(describeOne(next));
    const inner = wrappedOriginal(next);
    if (inner && causes.length < MAX_CAUSE_DEPTH) causes.push(inner);
    next = (next as { cause?: unknown }).cause;
  }
  return { ...head, causes };
}
