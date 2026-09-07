/**
 * SESSION KIND — which of the three populations a `focus_sessions` row belongs
 * to. One table, three genuinely different things, and a list door that mixes
 * them is unreadable for the same reason the triage lens exists.
 *
 *   - `work`    — a unit of work a PERSON owns: origin `human`, or NULL (an
 *                 un-migrated row: readers must not lose it), or an agent
 *                 session a person accepted from triage. The default lens.
 *   - `run`     — a machine execution that happens to be recorded as a session:
 *                 a playbook run or an automation run. Minted by
 *                 `openRunSession` (`@synap/database`), which stamps the run
 *                 ids the predicate below keys on.
 *   - `receipt` — the session an agent write is filed under so a package of
 *                 proposals has one reviewable container. Minted by
 *                 `resolveOrCreateAgentProposalSession`, which stamps
 *                 `metadata.kind = 'agent-proposal-package'` and synthesizes a
 *                 goal ("Run capability X", "Agent create · entity").
 *
 * ORDER IS LOAD-BEARING: a receipt is ALSO agent-origin, so `receipt` is
 * checked BEFORE `run`. Reversing the two would file every receipt as a run and
 * the agent-write container would vanish from the lens built to review it.
 *
 * NOT STORED, for the reason `triage.ts` and `session-blocked-by.ts` give: the
 * row already carries `origin`, `playbookId` and its metadata bag; a fourth
 * column holding a conclusion those three already imply is a copy that can be
 * wrong. It is DERIVED every time.
 *
 * The predicate exists exactly TWICE and both copies are in this file — once as
 * SQL (so a list door narrows in the query, never after the `limit`, which is
 * the whole point: a page of runs must not consume the 50 slots a person's work
 * needs) and once in TypeScript (`projectSessionKind`, attached to every row so
 * no consumer re-derives it). A hand-mirrored copy in a router is how the two
 * fork. `session-kind.test.ts` runs the fixtures through the TypeScript half
 * and asserts the rendered SQL of the other reads the same origins, column and
 * metadata keys — a text-parity check, NOT an execution of both halves (there
 * is no database under the unit gate).
 */

import {
  and,
  inArray,
  isNull,
  isNotNull,
  not,
  or,
  drizzleSql,
  focusSessions,
  automationRuns,
} from "@synap/database";
import type { SQL } from "@synap/database";

/** The three populations. `all` is a filter sentinel, never a value. */
export const SESSION_KINDS = ["work", "run", "receipt"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

/** `focus_sessions.origin` values that mean "a machine executed this". */
const RUN_ORIGINS = ["playbook", "automation"] as const;

/**
 * The two automation keys, and why BOTH are read.
 *
 * `openRunSession` stamps `metadata.automationId` (the automation DEFINITION)
 * and `metadata.automationRunId` (that particular RUN) independently — the
 * executor supplies both, other callers supply only the first. The run reaper
 * keys on `automationRunId` and the runs ledger keyed on `automationId`, which
 * is exactly how the two surfaces came to classify the same row differently.
 * A predicate that reads one key is blind to every row written by a producer
 * that stamps the other, so this one reads both.
 */
const AUTOMATION_KEYS = ["automationRunId", "automationId"] as const;

/** The marker `resolveOrCreateAgentProposalSession` stamps on a receipt. */
export const AGENT_PROPOSAL_PACKAGE_KIND = "agent-proposal-package";

// ── SQL half ───────────────────────────────────────────────────────────────

/** Receipt: the agent-write container. */
function receiptWhere(): SQL {
  return drizzleSql`${focusSessions.metadata} #>> '{kind}' = ${AGENT_PROPOSAL_PACKAGE_KIND}` as SQL;
}

/**
 * NOT a receipt. Spelled with `IS DISTINCT FROM` rather than `NOT (… = …)`:
 * `metadata` is nullable and `#>>` on a missing key yields NULL, so the plain
 * negation is NULL and the row would vanish from every lens — the same NULL
 * trap `notTriagePendingWhere` documents.
 */
function notReceiptWhere(): SQL {
  return drizzleSql`${focusSessions.metadata} #>> '{kind}' IS DISTINCT FROM ${AGENT_PROPOSAL_PACKAGE_KIND}` as SQL;
}

/**
 * `metadata #>> '{key}' IS [NOT] NULL`, from the SAME key list the TypeScript
 * half reads — so a third automation key can never reach one half only.
 */
function metadataKeyWhere(
  key: (typeof AUTOMATION_KEYS)[number],
  test: "IS NULL" | "IS NOT NULL"
): SQL {
  return drizzleSql`${focusSessions.metadata} #>> ${drizzleSql.raw(`'{${key}}'`)} ${drizzleSql.raw(test)}` as SQL;
}

/**
 * Accepted from triage ⇒ a PERSON took it on, whatever opened it. The header
 * promises this and `triage.ts` stamps it; without this clause an accepted
 * automation-drafted session would stay a `run` forever and vanish from the
 * work index the moment someone accepted it.
 */
const ACCEPTED_PATH = drizzleSql.raw(`'{triage,acceptedAt}'`);

/** Run signals, before the receipt override. */
function runSignalWhere(): SQL {
  return and(
    drizzleSql`${focusSessions.metadata} #>> ${ACCEPTED_PATH} IS NULL`,
    or(
      inArray(focusSessions.origin, [...RUN_ORIGINS]),
      isNotNull(focusSessions.playbookId),
      ...AUTOMATION_KEYS.map((key) => metadataKeyWhere(key, "IS NOT NULL"))
    )
  ) as SQL;
}

/** No run signal. `isNull(origin)` is explicit — see `notReceiptWhere`. */
function noRunSignalWhere(): SQL {
  return or(
    drizzleSql`${focusSessions.metadata} #>> ${ACCEPTED_PATH} IS NOT NULL`,
    and(
      or(
        isNull(focusSessions.origin),
        not(inArray(focusSessions.origin, [...RUN_ORIGINS]))
      ),
      isNull(focusSessions.playbookId),
      ...AUTOMATION_KEYS.map((key) => metadataKeyWhere(key, "IS NULL"))
    )
  ) as SQL;
}

/** SQL: rows of exactly one kind. Apply as a WHERE clause, never a post-filter. */
export function sessionKindWhere(kind: SessionKind): SQL {
  if (kind === "receipt") return receiptWhere();
  if (kind === "run") return and(notReceiptWhere(), runSignalWhere()) as SQL;
  return and(notReceiptWhere(), noRunSignalWhere()) as SQL;
}

// ── TypeScript half ────────────────────────────────────────────────────────

/** The row shape the derivation needs — anything session-like satisfies it. */
export interface SessionKindProjectable {
  origin?: string | null;
  playbookId?: string | null;
  metadata?: unknown;
}

function metadataValue(metadata: unknown, key: string): unknown {
  const bag = (metadata ?? {}) as Record<string, unknown>;
  return bag[key];
}

/**
 * THE derivation, in TypeScript — this and the SQL above must agree, which is
 * why they live in one file.
 */
export function projectSessionKind(row: SessionKindProjectable): SessionKind {
  if (metadataValue(row.metadata, "kind") === AGENT_PROPOSAL_PACKAGE_KIND) {
    return "receipt";
  }
  const triage = metadataValue(row.metadata, "triage") as
    { acceptedAt?: unknown } | null | undefined;
  if (triage?.acceptedAt != null) return "work";
  const isRun =
    (!!row.origin && (RUN_ORIGINS as readonly string[]).includes(row.origin)) ||
    !!row.playbookId ||
    // Presence, not type: `#>> '{…}' IS NOT NULL` in the SQL half is true for a
    // JSON value of ANY type, so a string test here would fork.
    AUTOMATION_KEYS.some((k) => metadataValue(row.metadata, k) != null);
  return isRun ? "run" : "work";
}

/**
 * SQL: sessions belonging to one automation DEFINITION.
 *
 * `metadata.automationId` is the definition id (`openRunSession` stamps it, and
 * mirrors it onto the legacy `templateId` column) — the primary match.
 *
 * But `openRunSession`'s channel-reuse path (`utils/open-run-session.ts`)
 * merges ONLY `automationRunId` onto a reused session's metadata, never
 * `automationId` — a session opened for one source (or a stale automation) and
 * later reused by a DIFFERENT automation's run ends up carrying the new run's
 * `automationRunId` with no `automationId` naming the new definition at all. A
 * plain `metadata.automationId = X` filter is blind to exactly that row, even
 * though it is unambiguously a run of automation X. So this also matches via
 * the `automation_runs` ledger, which always carries the definition id
 * (`automation_runs.automation_id`) keyed by the run id
 * (`metadata.automationRunId`) — the same lookup the run reaper already does
 * by `automationRunId`. Lives here because it reads the same metadata bag the
 * kind predicate does.
 */
export function sessionAutomationWhere(automationId: string): SQL {
  return or(
    drizzleSql`${focusSessions.metadata} #>> '{automationId}' = ${automationId}`,
    drizzleSql`(${focusSessions.metadata} #>> '{automationRunId}') IN (
      SELECT ${automationRuns.id}::text FROM ${automationRuns}
      WHERE ${automationRuns.automationId} = ${automationId}
    )`
  ) as SQL;
}

/** Attach the projection to a page of rows (no extra query — pure). */
export function attachSessionKind<T extends SessionKindProjectable>(
  rows: readonly T[]
): Array<T & { kind: SessionKind }> {
  return rows.map((r) => ({ ...r, kind: projectSessionKind(r) }));
}
