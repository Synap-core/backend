/**
 * Session Titler — names focus sessions nobody named, the way chat products
 * auto-title a conversation.
 *
 * Every 10 minutes, three bounded passes:
 *
 * 1. BACKFILL (no LLM). Runs and captures written before creators derived a
 *    `title` get one now, from the same `buildDerivedSessionTitle` the creators
 *    use — a playbook run from its playbook's name + subject, every other run
 *    from its goal (ids and raw links stripped). Marked `derived`.
 * 2. EARLY. A work session (or an agent's write receipt) that is a few minutes
 *    old and has something real in it — a message in its room, a proposal, a
 *    declared output — gets ONE generated name from the IS.
 * 3. CLOSE. A closed session whose name is still automation's gets ONE
 *    outcome-aware rename from its closing summary.
 *
 * Playbook and automation runs are never generated for: their derived name is
 * already the right one. A title a person or the working agent chose
 * (`titleSource` human|agent, or a legacy titled row) is never selected, and
 * every write is a conditional UPDATE that re-checks the title AND its source
 * it read — a rename that lands while the IS is answering always wins.
 *
 * IS unreachable ⇒ logged, the pass stops, nothing is stamped: the session
 * keeps its derived name and is picked up again next tick. An IS that ANSWERED
 * with nothing usable is stamped as attempted, so one unnameable session does
 * not burn a call every tick forever.
 */

import {
  db,
  and,
  eq,
  drizzleSql,
  focusSessions,
  playbooks,
  entities,
  messages,
  proposals,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  buildDerivedSessionTitle,
  sanitizeGeneratedTitle,
  type SessionTitleSource,
} from "@synap-core/types/focus-sessions";
import {
  getDefaultActiveService,
  requestSessionTitle,
  type SessionTitleRequest,
  type SessionTitleResult,
} from "@synap/intelligence-client";

const logger = createLogger({ module: "session-titler" });

export const SESSION_TITLER_QUEUE = "session-titler";
export const SESSION_TITLER_CRON = "*/10 * * * *"; // every 10 minutes

/** Sessions sent to the IS per phase per tick. */
export const TITLER_BATCH = 25;
/** Rows given a derived name per tick (no LLM — cheap). */
export const TITLER_BACKFILL_BATCH = 100;
/** A session younger than this has not said what it is yet. */
const EARLY_MIN_AGE_MINUTES = 2;
/** Only recently closed sessions are retitled — history is left as it is. */
const CLOSE_LOOKBACK_DAYS = 7;
const CONTEXT_MAX = 2000;

/** `metadata.source` of an agent's write receipt (resolve-or-create-agent-proposal-session). */
const RECEIPT_SOURCE = "agent-write";

type TitleRequester = (
  payload: SessionTitleRequest
) => Promise<SessionTitleResult>;

// ── Predicates (SQL, exported so the PGlite test drives the real ones) ──────

/**
 * `canAutoRetitle` in SQL: the stored source is automation's, or a legacy
 * row with no title (nobody named it). A legacy TITLED row reads as `agent`.
 */
const NAMED_BY_AUTOMATION = drizzleSql`(
  ${focusSessions.metadata}->>'titleSource' IN ('generated', 'derived')
  OR (${focusSessions.metadata}->>'titleSource' IS NULL AND ${focusSessions.title} IS NULL)
)`;

/**
 * A playbook or automation run — named right at creation, never generated for.
 * Negated as `IS NOT TRUE`, never `NOT`: `origin`/`source` are NULL on a work
 * session, the OR is then NULL, and `NOT NULL` would exclude every one of them.
 */
const TEMPLATE_RUN = drizzleSql`(
  ${focusSessions.playbookId} IS NOT NULL
  OR ${focusSessions.origin} IN ('playbook', 'automation')
  OR ${focusSessions.metadata}->>'source' = 'automation'
)`;

/** A work session (no run source) or an agent's write receipt. */
const WORK_OR_RECEIPT = drizzleSql`(
  ${focusSessions.metadata}->>'source' IS NULL
  OR ${focusSessions.metadata}->>'source' = ${RECEIPT_SOURCE}
)`;

/** Something real happened: a message in its room, a proposal, a declared output. */
const HAS_SIGNAL = drizzleSql`(
  EXISTS (SELECT 1 FROM ${proposals} WHERE ${proposals.sessionId} = ${focusSessions.id})
  OR (${focusSessions.channelId} IS NOT NULL
      AND EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.channelId} = ${focusSessions.channelId}))
  OR jsonb_array_length(COALESCE(${focusSessions.expectedOutputs}, '[]'::jsonb)) > 0
)`;

export const EARLY_TITLE_CANDIDATE = and(
  drizzleSql`${focusSessions.status} IN ('active', 'paused', 'forming')`,
  NAMED_BY_AUTOMATION,
  // Early is once: a generated name is not regenerated before close.
  drizzleSql`COALESCE(${focusSessions.metadata}->>'titleSource', '') <> 'generated'`,
  drizzleSql`${focusSessions.metadata}->>'titleEarlyAttemptedAt' IS NULL`,
  drizzleSql`${TEMPLATE_RUN} IS NOT TRUE`,
  WORK_OR_RECEIPT,
  drizzleSql`${focusSessions.createdAt} < now() - (${EARLY_MIN_AGE_MINUTES}::int * interval '1 minute')`,
  HAS_SIGNAL
);

export const CLOSE_TITLE_CANDIDATE = and(
  eq(focusSessions.status, "closed"),
  NAMED_BY_AUTOMATION,
  drizzleSql`${focusSessions.metadata}->>'titleRetitledAtClose' IS NULL`,
  drizzleSql`${TEMPLATE_RUN} IS NOT TRUE`,
  WORK_OR_RECEIPT,
  drizzleSql`${focusSessions.closedAt} > now() - (${CLOSE_LOOKBACK_DAYS}::int * interval '1 day')`,
  // Outcome-aware needs an outcome.
  drizzleSql`COALESCE(${focusSessions.verificationReport}->>'summary', '') <> ''`
);

/** A run or capture that predates derived names. Work sessions are left to phase 2. */
export const BACKFILL_CANDIDATE = and(
  drizzleSql`${focusSessions.title} IS NULL`,
  drizzleSql`${focusSessions.metadata}->>'titleSource' IS NULL`,
  drizzleSql`(${focusSessions.playbookId} IS NOT NULL OR ${focusSessions.metadata}->>'source' IS NOT NULL)`
);

// ── The write ───────────────────────────────────────────────────────────────

/**
 * Write a name only if the row still carries the title AND source the titler
 * read. Returns false when a rename (or any other titler write) got there
 * first — the rename wins, always.
 */
export async function writeTitleIfUnchanged(args: {
  sessionId: string;
  readTitle: string | null;
  readSource: string | null;
  /** New title, or null to only stamp `metadata` (an answer with no usable name). */
  title: string | null;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  const updated = await db
    .update(focusSessions)
    .set({
      ...(args.title ? { title: args.title } : {}),
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(args.metadata)}::jsonb`,
    })
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        drizzleSql`${focusSessions.title} IS NOT DISTINCT FROM ${args.readTitle}`,
        drizzleSql`${focusSessions.metadata}->>'titleSource' IS NOT DISTINCT FROM ${args.readSource}`
      )
    )
    .returning({ id: focusSessions.id });
  return updated.length > 0;
}

// ── Passes ──────────────────────────────────────────────────────────────────

type CandidateRow = {
  id: string;
  title: string | null;
  goal: string;
  channelId: string | null;
  expectedOutputs: unknown;
  verificationReport: unknown;
  metadata: unknown;
};

function readSource(row: { metadata: unknown }): string | null {
  const s = (row.metadata as { titleSource?: unknown } | null)?.titleSource;
  return typeof s === "string" ? s : null;
}

function outputLabels(expectedOutputs: unknown): string[] {
  return Array.isArray(expectedOutputs)
    ? expectedOutputs
        .map((o) => (o as { label?: unknown })?.label)
        .filter((l): l is string => typeof l === "string" && l.trim() !== "")
    : [];
}

async function earlyContext(row: CandidateRow): Promise<string> {
  const parts: string[] = [];
  if (row.channelId) {
    const first = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.channelId, row.channelId))
      .orderBy(messages.timestamp)
      .limit(5);
    parts.push(...first.map((m) => m.content));
  }
  const filed = await db
    .select({
      summary: drizzleSql<string | null>`${proposals.data}->>'summary'`,
    })
    .from(proposals)
    .where(eq(proposals.sessionId, row.id))
    .orderBy(proposals.createdAt)
    .limit(5);
  parts.push(...filed.map((p) => p.summary).filter((s): s is string => !!s));
  const labels = outputLabels(row.expectedOutputs);
  if (labels.length) parts.push(`Outputs: ${labels.join(", ")}`);
  return parts.join("\n").slice(0, CONTEXT_MAX);
}

function closeContext(row: CandidateRow): string {
  const summary =
    (row.verificationReport as { summary?: unknown } | null)?.summary ?? "";
  const labels = outputLabels(row.expectedOutputs);
  return [
    typeof summary === "string" ? summary : "",
    labels.length ? `Outputs: ${labels.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, CONTEXT_MAX);
}

/**
 * One generation phase. Returns the number of names written. Stops at the
 * first IS failure (the service is down for the rest of the batch too) and
 * stamps nothing for the sessions it could not ask about.
 */
async function generatePhase(
  phase: "early" | "close",
  requestTitle: TitleRequester
): Promise<number> {
  const rows: CandidateRow[] = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      channelId: focusSessions.channelId,
      expectedOutputs: focusSessions.expectedOutputs,
      verificationReport: focusSessions.verificationReport,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(phase === "early" ? EARLY_TITLE_CANDIDATE : CLOSE_TITLE_CANDIDATE)
    .orderBy(
      phase === "early"
        ? drizzleSql`${focusSessions.createdAt} DESC`
        : drizzleSql`${focusSessions.closedAt} DESC`
    )
    .limit(TITLER_BATCH);

  let named = 0;
  for (const row of rows) {
    const context =
      phase === "early" ? await earlyContext(row) : closeContext(row);
    let answer: SessionTitleResult;
    try {
      answer = await requestTitle({
        goal: row.goal,
        ...(context ? { context } : {}),
        phase,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: row.id, phase },
        "session-titler: IS unavailable — keeping derived names, retrying next tick"
      );
      break;
    }
    // The pod's own rules, whatever the IS already did.
    const title = sanitizeGeneratedTitle(answer.title);
    const now = new Date().toISOString();
    const stamp =
      phase === "early" ? "titleEarlyAttemptedAt" : "titleRetitledAtClose";
    const wrote = await writeTitleIfUnchanged({
      sessionId: row.id,
      readTitle: row.title,
      readSource: readSource(row),
      title,
      metadata: {
        [stamp]: now,
        ...(title
          ? {
              titleSource: "generated" satisfies SessionTitleSource,
              titleGeneratedAt: now,
              ...(answer.model ? { titleModel: answer.model } : {}),
            }
          : {}),
      },
    });
    if (wrote && title) named++;
  }
  return named;
}

/** Phase 1: derived names for runs and captures written before creators set one. */
async function backfillDerivedTitles(): Promise<number> {
  const rows = await db
    .select({
      id: focusSessions.id,
      goal: focusSessions.goal,
      metadata: focusSessions.metadata,
      playbookName: playbooks.name,
      subjectTitle: entities.title,
    })
    .from(focusSessions)
    .leftJoin(playbooks, eq(playbooks.id, focusSessions.playbookId))
    .leftJoin(entities, eq(entities.id, focusSessions.subjectEntityId))
    .where(BACKFILL_CANDIDATE)
    .limit(TITLER_BACKFILL_BATCH);

  let named = 0;
  for (const row of rows) {
    // A playbook run's goal was once its whole rendered prompt, so the name
    // comes from the playbook; every other run's goal is already its label.
    const title = row.playbookName
      ? buildDerivedSessionTitle({
          kind: "run",
          name: row.playbookName,
          subject: row.subjectTitle,
        })
      : buildDerivedSessionTitle({ kind: "capture", label: row.goal });
    const wrote = await writeTitleIfUnchanged({
      sessionId: row.id,
      readTitle: null,
      readSource: null,
      title,
      metadata: { titleSource: "derived" satisfies SessionTitleSource },
    });
    if (wrote) named++;
  }
  return named;
}

/** The IS door, resolved per tick; null when no service is configured. */
async function defaultRequester(): Promise<TitleRequester | null> {
  const { endpoint, apiKey } = await getDefaultActiveService();
  if (!endpoint) return null;
  return (payload) => requestSessionTitle(endpoint, apiKey ?? "", payload);
}

/** Called by the cron scheduler every 10 minutes. */
export async function handleSessionTitler(
  deps: { requestTitle?: TitleRequester | null } = {}
): Promise<{ backfilled: number; early: number; close: number }> {
  const backfilled = await backfillDerivedTitles();
  const requestTitle =
    deps.requestTitle !== undefined
      ? deps.requestTitle
      : await defaultRequester();
  if (!requestTitle) {
    logger.debug(
      "session-titler: no intelligence service — derived names only"
    );
    return { backfilled, early: 0, close: 0 };
  }
  const early = await generatePhase("early", requestTitle);
  const close = await generatePhase("close", requestTitle);
  if (backfilled || early || close) {
    logger.info({ backfilled, early, close }, "session-titler named sessions");
  }
  return { backfilled, early, close };
}
