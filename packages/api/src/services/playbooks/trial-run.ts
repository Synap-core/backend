/**
 * A TRIAL run (design b199a3a4, slice 1b: the rule lab). The person tries a
 * DRAFT version of a rule without making it current: the run renders the
 * draft in place of the current version (`loadPlaybookGuidance`'s
 * `override`), writes nothing (its session is stamped `metadata.trial` and
 * every write door refuses a write in it: `@synap/capability-gate`
 * `trialSessionWriteRefusal`) and its drafted text comes back as the agent's
 * last reply in the run's room (`readTrialDraft`).
 *
 * ONE door: `playbooks.run` with `trial`, reached through Hub REST
 * `POST /playbooks/:id/run`. A person's act: an agent's trial is refused.
 */

import { z } from "zod";
import { getDb, messages, and, eq, desc, isNull } from "@synap/database";
import { MessageRole } from "@synap/database/schema";
import { trialStampOf, type TrialSessionStamp } from "@synap/capability-gate";

/** At most this many current → draft substitutions in one trial. */
export const MAX_TRIAL_OVERRIDES = 20;

/** The `trial` option of the run door. */
export const trialRunInputSchema = z.object({
  /**
   * `{ <current entity id>: <draft entity id> }`: each draft renders in place
   * of the current version it names (same kind, readable by the person).
   */
  guidanceOverride: z
    .record(z.string().uuid(), z.string().uuid())
    .refine((o) => Object.keys(o).length > 0, {
      message: "Name at least one current version and its draft.",
    })
    .refine((o) => Object.keys(o).length <= MAX_TRIAL_OVERRIDES, {
      message: `At most ${MAX_TRIAL_OVERRIDES} drafts in one trial.`,
    }),
});

export type TrialRunInput = z.infer<typeof trialRunInputSchema>;

/** The session metadata a trial run is stamped with. PURE. */
export function trialSessionMetadata(trial: TrialRunInput): {
  trial: TrialSessionStamp;
} {
  return { trial: { guidanceOverride: { ...trial.guidanceOverride } } };
}

/** The line the trial's kickoff carries, so the agent answers with the draft. */
export const TRIAL_KICKOFF_NOTE =
  "## Trial run\nThis is a trial of a draft rule: nothing you write, send or save is kept, and every write is refused. Do not send or save anything. Write the message you would send as your final reply, and nothing else.";

/**
 * What a trial run drafted: the LAST assistant reply in its room, or null
 * while the agent has not answered. Read by the run read (`GET /runs/:id`).
 */
export interface TrialDraft {
  /** The drafts rendered in place of current versions. */
  guidanceOverride: Record<string, string>;
  /** The agent's last reply in the run's room; null until it answers. */
  draftedText: string | null;
  draftedAt: string | null;
}

/**
 * The trial part of a run's detail, or null when the run's session is not a
 * trial. THROWS on a failed read (the run read surfaces it).
 */
export async function readTrialDraft(session: {
  metadata: unknown;
  channelId: string | null;
}): Promise<TrialDraft | null> {
  const stamp = trialStampOf(session.metadata);
  if (!stamp) return null;
  if (!session.channelId) {
    return {
      guidanceOverride: stamp.guidanceOverride,
      draftedText: null,
      draftedAt: null,
    };
  }
  const db = await getDb();
  const [last] = await db
    .select({ content: messages.content, timestamp: messages.timestamp })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, session.channelId),
        eq(messages.role, MessageRole.ASSISTANT),
        isNull(messages.deletedAt)
      )
    )
    .orderBy(desc(messages.timestamp))
    .limit(1);
  return {
    guidanceOverride: stamp.guidanceOverride,
    draftedText: last?.content?.trim() ? last.content : null,
    draftedAt: last?.timestamp ? last.timestamp.toISOString() : null,
  };
}
