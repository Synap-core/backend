/**
 * SetupRequiredError — "this proposal cannot be applied until a human supplies
 * something", as a TYPED, DUCK-READABLE failure.
 *
 * ── WHY IT IS DUCK-TYPED ────────────────────────────────────────────────────
 * The classifier that turns an `approval_failed` row into a reviewable sentence
 * lives on the proposals side; the thrower lives deep in the capability
 * installer. Making the reader `instanceof`-depend on the thrower's module
 * would couple two lanes across a package boundary and break the moment the
 * error crosses a serialization hop (pg-boss payload, Hub REST body, a
 * `structuredClone`) — at which point `instanceof` silently answers `false` and
 * the classifier falls back to a raw sentence, which is exactly the defect this
 * replaces.
 *
 * So the CONTRACT is the SHAPE, not the class:
 *
 *   { failureClass: "missing_field" | "no_connection",
 *     missingFields: string[],
 *     connection?: { provider?: string; state?: string },
 *     message: string }
 *
 * A reader uses {@link isSetupRequiredLike}, which tests only those props. This
 * module imports NOTHING, so any lane may import it without a cycle — but no
 * lane HAS to.
 *
 * ── THE MESSAGE IS A SAFE SENTENCE ──────────────────────────────────────────
 * `message` names LABELS, never values. A required param is very often a
 * credential, and the whole point of this error is that the credential was NOT
 * supplied — so echoing "what we got" would either be empty or, worse, a key
 * the agent did inline into `params`. It never interpolates a param VALUE.
 */

/** The two reasons a capability install can need a human before it can apply. */
export const SETUP_FAILURE_CLASSES = [
  "missing_field",
  "no_connection",
] as const;

export type SetupFailureClass = (typeof SETUP_FAILURE_CLASSES)[number];

/** Connection facts a `no_connection` failure carries. Never a token, never a URL. */
export interface SetupRequiredConnection {
  /** Nango provider key, e.g. "google". Absent for a vault-kind credential. */
  provider?: string;
  /** `missing` | `expired` | `unavailable` — the catalog's connection state. */
  state?: string;
}

/**
 * The duck-typed contract. Declared as an interface (not only as the class) so a
 * reader can type its narrowing without importing the class.
 */
export interface SetupRequiredLike {
  failureClass: SetupFailureClass;
  /** Param NAMES (never values) that are required and unsatisfied. May be empty
   *  for a pure connection failure. */
  missingFields: string[];
  connection?: SetupRequiredConnection;
  message: string;
}

export class SetupRequiredError extends Error implements SetupRequiredLike {
  readonly failureClass: SetupFailureClass;
  readonly missingFields: string[];
  readonly connection?: SetupRequiredConnection;

  constructor(input: {
    failureClass: SetupFailureClass;
    /** Human LABELS for the sentence (falls back to the names). */
    labels?: string[];
    missingFields?: string[];
    connection?: SetupRequiredConnection;
    /** Override the derived sentence. Must stay value-free. */
    message?: string;
  }) {
    const missingFields = input.missingFields ?? [];
    const labels =
      input.labels && input.labels.length > 0 ? input.labels : missingFields;
    super(
      input.message ??
        defaultMessage(input.failureClass, labels, input.connection)
    );
    this.name = "SetupRequiredError";
    this.failureClass = input.failureClass;
    this.missingFields = missingFields;
    if (input.connection) this.connection = input.connection;
  }
}

function defaultMessage(
  failureClass: SetupFailureClass,
  labels: string[],
  connection?: SetupRequiredConnection
): string {
  if (failureClass === "no_connection") {
    const what = connection?.provider ?? "the required account";
    return connection?.state === "expired"
      ? `Needs setup: reconnect ${what} — its access expired or was revoked.`
      : `Needs setup: connect ${what}.`;
  }
  return labels.length > 0
    ? `Needs setup: ${labels.join(", ")}.`
    : "Needs setup.";
}

/**
 * Duck-typed narrowing — the ONE reader-side door. Deliberately does NOT use
 * `instanceof`: see the module docblock. An error that crossed a serialization
 * hop still answers `true` here, which is the entire reason this exists.
 */
export function isSetupRequiredLike(err: unknown): err is SetupRequiredLike {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return (
    typeof e.failureClass === "string" &&
    (SETUP_FAILURE_CLASSES as readonly string[]).includes(e.failureClass) &&
    Array.isArray(e.missingFields) &&
    e.missingFields.every((f) => typeof f === "string") &&
    typeof e.message === "string"
  );
}

/**
 * Treat `""` / whitespace / null / undefined as MISSING.
 *
 * The hole this closes: `createCapabilityFromDefinition` guarded only
 * `value === undefined`, so an empty string sailed through, interpolated into a
 * `vault[].value`, and installed a capability with a BLANK credential that then
 * read as a satisfied connection. A shared predicate, because the read-side
 * `setup.satisfied` computation must answer this question identically — two
 * copies of "is this filled in" is how a form says "done" over a value the
 * installer then rejects.
 */
export function isBlankParamValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}
