/**
 * Which notification is the person's morning brief (audit abbc7a19 PA-D-03): the newest
 * `ai.proactive.morning_briefing` (producer `services/morning-brief`,
 * backend#492). Pure; `morning-brief.tsx` reads and draws it.
 */

/** The registry type the producer raises. */
export const MORNING_BRIEF_TYPE = "ai.proactive.morning_briefing";

/** The `notifCenter.list` fields the brief reads, structurally. */
export interface BriefNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: Date | string;
}

/** The newest brief among `rows` (the pod reads newest first); null when none. */
export function latestBrief<T extends BriefNotification>(
  rows: readonly T[]
): T | null {
  return rows.find((n) => n.type === MORNING_BRIEF_TYPE) ?? null;
}
