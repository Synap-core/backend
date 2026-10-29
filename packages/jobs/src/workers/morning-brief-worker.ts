/**
 * The morning brief — one passive item a day per person, at the time their
 * proactive settings name (`api/src/services/morning-brief/`).
 *
 * A handler SLOT filled by the api layer at boot (the one-way `api → jobs`
 * dependency): the pass reads THE needs-you rule through the signals router
 * and writes through `NotificationService`, both in api — the same IoC as
 * `library-keep-alive-worker.ts`. jobs owns only the queue and its cron.
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "morning-brief-worker" });

export const MORNING_BRIEF_QUEUE = "morning-brief";
/**
 * Every 15 minutes: each person's time is their own (hour, minute, timezone),
 * so the tick looks for whoever is due rather than firing at one hour.
 */
export const MORNING_BRIEF_CRON = "*/15 * * * *";

export interface MorningBriefJobResult {
  people: number;
  due: number;
  sent: number;
  failed: number;
}

type MorningBriefHandler = () => Promise<MorningBriefJobResult>;

let morningBriefHandler: MorningBriefHandler | null = null;

export function registerMorningBriefHandler(fn: MorningBriefHandler): void {
  morningBriefHandler = fn;
}

export async function handleMorningBrief(): Promise<MorningBriefJobResult> {
  if (!morningBriefHandler) {
    // Boot order: the cron can fire before the api filled the slot. Nothing
    // is lost — the next tick, inside the same due hour, sends it.
    logger.warn("morning-brief handler not registered yet — skipped");
    return { people: 0, due: 0, sent: 0, failed: 0 };
  }
  return morningBriefHandler();
}
