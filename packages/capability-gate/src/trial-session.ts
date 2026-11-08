/**
 * A TRIAL run's session (design b199a3a4, slice 1b: the rule lab). A trial
 * renders a DRAFT version of a rule in place of the current one to show what
 * the playbook would write with it. Nothing it does may land: its session is
 * stamped `metadata.trial` by the runner (`run-playbook.ts`), and every write
 * door refuses a write that carries that session — the governed-write gate
 * (`checkPermissionOrPropose`), the capability gate below and the send door
 * (`sendExternalMessage`). Reads still run.
 *
 * FAIL CLOSED: a session row that cannot be read refuses the write ("could not
 * tell"), never lets it through as "not a trial".
 */

import { getDb, eq } from "@synap/database";
import { focusSessions } from "@synap/database/schema";

/** The typed refusal a caller can branch on. */
export const TRIAL_RUN_WRITE_REFUSED = "TRIAL_RUN_WRITE_REFUSED";

export const TRIAL_RUN_WRITE_REFUSED_REASON =
  "This is a trial run: nothing it writes, sends or saves is kept. Write the result as your reply instead.";

/** What the runner stamps on a trial run's session (`focus_sessions.metadata.trial`). */
export interface TrialSessionStamp {
  /** `{ <current entity id>: <draft entity id> }`, rendered in place. */
  guidanceOverride: Record<string, string>;
}

/** The trial stamp of session metadata, or null when it is not a trial. PURE. */
export function trialStampOf(metadata: unknown): TrialSessionStamp | null {
  const trial = (metadata as Record<string, unknown> | null | undefined)
    ?.trial as { guidanceOverride?: unknown } | undefined;
  if (!trial || typeof trial !== "object") return null;
  const raw = trial.guidanceOverride;
  const guidanceOverride: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") guidanceOverride[k] = v;
    }
  }
  return { guidanceOverride };
}

/**
 * The refusal for a write made in `sessionId`, or null when the session is
 * not a trial (or there is no session). A failed read refuses.
 */
export async function trialSessionWriteRefusal(
  sessionId: string | null | undefined
): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const db = await getDb();
    const [row] = await db
      .select({ metadata: focusSessions.metadata })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .limit(1);
    return trialStampOf(row?.metadata) ? TRIAL_RUN_WRITE_REFUSED_REASON : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Could not tell whether session ${sessionId} is a trial run (${message}), so nothing was written. Try again.`;
  }
}
