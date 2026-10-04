/**
 * DRAFT ASKS — what an undecided agent draft asks the person.
 *
 * An agent-started session is a triage DRAFT until the person accepts it
 * (`triage.ts`), and needs-you hides a draft's owed slots one by one
 * (`excludeDrafts`). Hidden entirely, an external agent's FIRST question was
 * invisible (dogfood, 2026-09-27). The founder's answer: the draft row carries
 * its asks. This read returns the owed slots of pending drafts — the SAME owed
 * predicate (`listOwedSlots`), under the inverse triage lens (`onlyDrafts` =
 * `triagePendingWhere`, never re-spelled) — plus WHO started each draft, so the
 * pure union (`needs-you-union.ts`) folds them into one row per draft.
 *
 * The starter is the first agent on the session's roster
 * (`attachSessionParticipants`, the one roster derivation). A draft with no
 * agent on its roster yields no name, and the row says "An agent".
 */

import { db, and, eq, inArray, focusSessions } from "@synap/database";
import type { ResolvedScope } from "../../utils/scope-filter.js";
import { listOwedSlots, type OwedSlot } from "./owed-outputs.js";
import { attachSessionParticipants } from "./participants.js";

export interface DraftAskSlots {
  /** Owed slots on pending drafts, oldest first. Capped at `limit`. */
  slots: OwedSlot[];
  /** sessionId → display name of the agent that started it (when known). */
  starterNames: Map<string, string>;
}

export async function listDraftAskSlots(params: {
  userId: string;
  scope: ResolvedScope;
  limit: number;
  /** Container lenses below the project — see `ListOwedSlotsParams`. */
  sessionId?: string;
  trackId?: string;
}): Promise<DraftAskSlots> {
  const slots = await listOwedSlots({ ...params, onlyDrafts: true });
  const sessionIds = [...new Set(slots.map((s) => s.sessionId))];
  const starterNames = new Map<string, string>();
  if (sessionIds.length === 0) return { slots, starterNames };

  const rows = await db
    .select({ id: focusSessions.id, agentIds: focusSessions.agentIds })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, sessionIds),
        eq(focusSessions.userId, params.userId)
      )
    );
  const staffed = await attachSessionParticipants(rows, params.userId);
  for (const s of staffed) {
    const first = s.participants[0];
    if (first) starterNames.set(s.id, first.name);
  }
  return { slots, starterNames };
}
