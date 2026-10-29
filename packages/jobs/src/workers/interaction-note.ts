/**
 * "When did we last speak to them" — the jobs side (CRM recall C-W2, 0359).
 *
 *   - `interaction-note` (on demand): enqueued by the `interaction-note`
 *     reactor in @synap/events for an interaction edge's creation or an
 *     outreach touch's move to `sent` / `replied`. Reads that evidence and
 *     moves the people forward through the one door.
 *   - `interaction-sweep` (daily): a meeting linked BEFORE it happened was not
 *     an interaction then; once its date has passed it is. Re-reads the edges
 *     whose record date falls in the last week (a missed day or two is
 *     caught; the door is forward-only, so a re-read is a no-op).
 *
 * What counts and the write live in `@synap/database`
 * (`interaction-evidence.ts`, `note-interaction.ts`); this is the queue and
 * the clock. Failures THROW so pg-boss retries.
 */
import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import { db, noteInteractionsFrom, type EvidenceScope } from "@synap/database";

const logger = createLogger({ module: "interaction-note" });

export const INTERACTION_NOTE_QUEUE = "interaction-note";
export const INTERACTION_SWEEP_QUEUE = "interaction-sweep";
/** Daily at 03:40 UTC. */
export const INTERACTION_SWEEP_CRON = "40 3 * * *";
/** How far back the sweep re-reads record dates. */
export const INTERACTION_SWEEP_LOOKBACK_DAYS = 7;

export interface InteractionNoteJob {
  relationIds?: string[];
  touchIds?: string[];
}

export async function handleInteractionNote(
  job: PgBoss.Job<InteractionNoteJob | null>
): Promise<void> {
  const data = job.data ?? {};
  const scope: EvidenceScope | null = data.relationIds?.length
    ? { relationIds: data.relationIds }
    : data.touchIds?.length
      ? { touchIds: data.touchIds }
      : null;
  if (!scope) {
    logger.warn({ data }, "interaction-note job names no edge or touch");
    return;
  }
  const r = await noteInteractionsFrom(db, scope);
  if (r.moved.length > 0) {
    logger.info({ ...data, moved: r.moved.length }, "Noted interactions");
  }
}

export async function handleInteractionSweep(
  now: Date = new Date()
): Promise<void> {
  const from = new Date(
    now.getTime() - INTERACTION_SWEEP_LOOKBACK_DAYS * 86_400_000
  );
  const r = await noteInteractionsFrom(db, { recordDatesFrom: from }, now);
  logger.info(
    { evidence: r.evidence, moved: r.moved.length },
    "Interaction sweep done"
  );
}
