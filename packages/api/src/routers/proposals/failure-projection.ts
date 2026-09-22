/**
 * failure-projection — the floor that keeps `data.failure.detail` off every
 * USER-facing read door.
 *
 * ## The problem this solves
 *
 * A failed proposal now stores the REDACTED raw executor error as
 * `data.failure.detail`, because that text is what lets the AI explain the
 * failure in plain words. Redaction is best-effort — it narrows the blast
 * radius, it does not bound the audience. What bounds the audience is this:
 * every door that serializes a proposal's `data` passes it through
 * {@link projectProposalDataForViewer} first.
 *
 * ## Why a strip, and not "store it somewhere else"
 *
 * There is no somewhere else without a migration: every full-view door projects
 * `row.data` WHOLESALE (`{...row}` in `display.ts`, `withProposalClass` in the
 * Hub codec), so no key inside `data` is safe by choice of name. Stripping at
 * the projection is therefore the mechanism; what makes it trustworthy is that
 * the strip is ONE function, and which fields it strips is CLASSIFIED in the
 * type system rather than remembered.
 *
 * ## The classification floor
 *
 * Every member of `ProposalFailureMeta` is either PROJECTED (safe to show a
 * user) or AGENT_ONLY (stripped here). A new field that is neither makes
 * `_Classified` resolve to `never` and the BUILD fails — the idiom documented
 * in `.claude/rules/guards-and-tests.md`, used because the defect class here is
 * exactly "someone adds a field and forgets to handle it", and a test that
 * *might* notice is worth less than a compile error.
 *
 * The ONE reader of the unstripped value is `render-for-prompt.ts`, which reads
 * the row straight from the database on a server-side prompt path and never
 * answers a client.
 */

import type { ProposalFailureMeta } from "./failure-classification.js";

/** Failure fields that MAY be projected to a user. */
export const PROJECTED_FAILURE_FIELDS = [
  "errorClass",
  "providerRef",
  "missingFields",
] as const satisfies ReadonlyArray<keyof ProposalFailureMeta>;

/**
 * Failure fields that must NEVER reach a user-facing read door.
 *
 * `detail` is the redacted RAW error text. Redaction is best-effort against an
 * arbitrary upstream body; the agent needs it to explain the failure, a user
 * screen needs only the classified sentence in `rejectionReason`.
 */
export const AGENT_ONLY_FAILURE_FIELDS = [
  "detail",
] as const satisfies ReadonlyArray<keyof ProposalFailureMeta>;

type _Classified =
  Exclude<
    keyof ProposalFailureMeta,
    (typeof PROJECTED_FAILURE_FIELDS)[number]
  > extends (typeof AGENT_ONLY_FAILURE_FIELDS)[number]
    ? true
    : never;
/** A new, unclassified `ProposalFailureMeta` field ⇒ `never` ⇒ build stops. */
const _classified: _Classified = true;
void _classified;

/**
 * ## The SIBLING keys — a second, differently-shaped hole
 *
 * `projectProposalDataForViewer` only reaches INSIDE `data.failure`. But two
 * writers park error text on `data` BESIDE it, where nothing strips it and
 * nothing used to redact it:
 *
 *   · `services/proposals/stamp-materialized.ts` → `data.materializationError`
 *   · `routers/proposals/apply-approval.ts` → `data.planFailure` (whose
 *     `steps[].reason` and `compensation.notCompensated[].reason` are raw
 *     thrown text)
 *
 * They are NOT stripped, deliberately: a plan report with its reasons removed
 * is useless to the reviewer who has to decide what to do next. So they are
 * REDACTED AT WRITE instead (`redactDeepForStorage`), and classified here so
 * the decision is recorded rather than remembered.
 *
 * The compile-time floor below says every sibling key is classified; the
 * DERIVED half — that no writer has quietly added a THIRD key — is
 * `failure-sibling-redaction.test.ts`, which parses the writers' own
 * `.set({ data: { … } })` out of source rather than trusting this list.
 */
export interface ProposalFailureSiblings {
  /** `runMaterializationUnderReceipt` — the materializer's error message. */
  materializationError?: string;
  /** `apply-approval` — the all-or-none composite plan report. */
  planFailure?: {
    at: string;
    by: string;
    steps: unknown;
    compensation: unknown;
  };
}

/** Sibling keys that are shown to the user, having been redacted at write. */
export const REDACTED_AT_WRITE_SIBLINGS = [
  "materializationError",
  "planFailure",
] as const satisfies ReadonlyArray<keyof ProposalFailureSiblings>;

/** Sibling keys stripped outright. Empty today — kept so a future one must land somewhere. */
export const STRIPPED_SIBLINGS = [] as const satisfies ReadonlyArray<
  keyof ProposalFailureSiblings
>;

type _SiblingsClassified =
  Exclude<
    keyof ProposalFailureSiblings,
    (typeof REDACTED_AT_WRITE_SIBLINGS)[number]
  > extends (typeof STRIPPED_SIBLINGS)[number]
    ? true
    : never;
/** A new, unclassified sibling key ⇒ `never` ⇒ build stops. */
const _siblingsClassified: _SiblingsClassified = true;
void _siblingsClassified;

/**
 * Strip every AGENT_ONLY failure field from a proposal's `data` payload.
 *
 * Returns the SAME reference when there is nothing to strip — the overwhelmingly
 * common case (no failure at all), so a page of 50 proposals allocates nothing.
 * Never mutates its input.
 */
export function projectProposalDataForViewer<T>(data: T): T {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const failure = record.failure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) {
    return data;
  }
  const failureRecord = failure as Record<string, unknown>;
  const present = AGENT_ONLY_FAILURE_FIELDS.filter(
    (field) => field in failureRecord
  );
  if (present.length === 0) return data;
  const projected: Record<string, unknown> = { ...failureRecord };
  for (const field of present) delete projected[field];
  return { ...record, failure: projected } as T;
}

/** Row-level convenience: `{...row, data: projected}` for a projection door. */
export function projectProposalRowForViewer<
  T extends { data?: unknown } | Record<string, unknown>,
>(row: T): T {
  const data = (row as { data?: unknown }).data;
  const projected = projectProposalDataForViewer(data);
  return projected === data ? row : ({ ...row, data: projected } as T);
}
