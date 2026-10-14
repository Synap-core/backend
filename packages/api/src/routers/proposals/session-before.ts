/**
 * `before` — for a PENDING session update that rewrites the session's
 * acceptance criteria or expected outputs, the session's CURRENT criteria and
 * expected outputs, so the card can draw the checklist and the outputs strip
 * before → after on the session itself.
 *
 * WHY. The payload carries only the new arrays. Without the current ones a
 * reviewer sees a list and cannot tell what was added, dropped or reworded.
 *
 * ONLY PENDING. On a decided row the session already holds the `after`, so a
 * read of the live row is not a "before"; such rows get no `before` (absent =
 * unknown, never a fabricated snapshot).
 *
 * VISIBILITY. One batched read floored by the ONE session read rule
 * (`sessionReadableWhere`, decision D1) — a session the viewer may not read
 * gets no `before`.
 */

import { db, and, inArray, focusSessions } from "@synap/database";
import { isLikelyUUID } from "@synap-core/types/proposals";
import { sessionReadableWhere } from "../../access/session-visibility.js";

export interface ProposalSessionBefore {
  criteria: unknown[];
  expectedOutputs: unknown[];
}

export interface SessionBeforeCandidate {
  status: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown> | undefined;
}

/** A pending session update that touches criteria or expected outputs. */
function sessionIdFor(c: SessionBeforeCandidate): string | null {
  if (c.status !== "pending" || c.targetType !== "focus_session") return null;
  if (!c.payload) return null;
  if (!("criteria" in c.payload) && !("expectedOutputs" in c.payload)) {
    return null;
  }
  const id =
    typeof c.payload.id === "string" && isLikelyUUID(c.payload.id)
      ? c.payload.id
      : c.targetId;
  return isLikelyUUID(id) ? id : null;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export async function resolveSessionBefore(
  candidates: SessionBeforeCandidate[],
  viewer: { userId: string; roster: boolean }
): Promise<Array<ProposalSessionBefore | undefined>> {
  const ids = candidates.map(sessionIdFor);
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return candidates.map(() => undefined);
  const rows = await db
    .select({
      id: focusSessions.id,
      criteria: focusSessions.criteria,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, unique),
        sessionReadableWhere({ userId: viewer.userId, roster: viewer.roster })
      )
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const row = id ? byId.get(id) : undefined;
    return row
      ? {
          criteria: asList(row.criteria),
          expectedOutputs: asList(row.expectedOutputs),
        }
      : undefined;
  });
}
