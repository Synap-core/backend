/**
 * What every transition stamps at the MOVE (status-flow plan W4), for every
 * subject: who made it for attribution (`actorClass`, `appId`) and when
 * (`occurredAt`, `recordedAt`, `backdated`). Called inside the move's
 * transaction by the two builders (`applyStatusMove`, `buildWorkUnitTransition`),
 * so a goal's or a session's transition is timed at the move, never at its
 * delivery by the sweeper.
 *
 * The door validates a mover's `occurredAt` first (`resolveOccurredAt`,
 * `@synap-core/types/lifecycle`: at most 30 days back, never ahead); here it is
 * only recorded, so an approval replay keeps the time its proposal was filed
 * with.
 */
import type { TransitionBase } from "@synap-core/types/lifecycle";
import { getRequestGrant } from "../../utils/request-write-context.js";

export type TransitionStamp = Pick<
  TransitionBase,
  "actorClass" | "appId" | "occurredAt" | "recordedAt" | "backdated"
>;

export function transitionStamp(
  actorKind: TransitionBase["actorKind"],
  occurredAt?: Date | null,
  now: Date = new Date()
): TransitionStamp {
  // The app whose key made the request (the attribution `events.app_id`
  // carries, 0310). Server code moving on its own is the system's, whatever
  // request it runs in.
  const appId =
    actorKind === "system" ? null : (getRequestGrant()?.clientId ?? null);
  const at = occurredAt ?? now;
  return {
    actorClass: appId ? "app" : actorKind,
    appId,
    occurredAt: at.toISOString(),
    recordedAt: now.toISOString(),
    backdated: at.getTime() < now.getTime(),
  };
}
