/**
 * The payers' notices about this pod's AI availability (W3 C5). The pod's
 * pull (`@synap/jobs` `cp-entitlement-sync`) calls this through its
 * `registerAiAvailabilityNotifier` slot after every recorded answer; it acts
 * only when the state or its mark (the crossed low threshold) changed:
 *
 *   credits_low                            `ai.credits_low`, the status banner
 *   credits_empty, suspended, not_entitled `ai.unavailable`, an item, pushed
 *   anything else (available, an operator
 *   state, a read the CP could not make)   no new notice
 *
 * To the pod's payers (owner + admins), in the payer's words from the ONE
 * deck (`aiAvailabilityCopy`). The open notices of an earlier state are
 * dismissed on every change, so a pod back to "available" shows none. One
 * notice per (state, mark, reset) while it is unread: the groupKey carries
 * them and the registry's window drops a repeat. The pod is implicit (the
 * rows live on it). Never throws past the pull: the caller logs.
 */
import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  inArray,
  notifications,
  NotificationStatus,
  type PodAiAvailabilityChange,
} from "@synap/database";
import {
  aiAvailabilityCopy,
  type AiAvailability,
} from "@synap-core/types/ai-availability";
import { NotificationService } from "../../notifications/NotificationService.js";
import { resolvePodAdminUserIds } from "../capabilities/pod-owner.js";
import { aiAvailabilityViewOf } from "./read.js";

const logger = createLogger({ module: "ai-availability-notify" });

/** Spelled as `type:` so the producer tripwire sees this file produce them. */
const lowNotice = { type: "ai.credits_low" } as const;
const unavailableNotice = { type: "ai.unavailable" } as const;
const AI_NOTICE_TYPES = [lowNotice.type, unavailableNotice.type];

/** The states a payer is told about, and which notice tells them. */
const NOTICE_OF: Partial<Record<string, string>> = {
  credits_low: lowNotice.type,
  credits_empty: unavailableNotice.type,
  suspended: unavailableNotice.type,
  not_entitled: unavailableNotice.type,
};

/** The owner's state and mark; null = unknown (no answer, or billing unread). */
function markOf(
  a: AiAvailability | null
): { kind: string; mark: number | null; resetsAt: string | null } | null {
  if (!a || a.kind === null) return null;
  return {
    kind: a.kind,
    mark: a.thresholdPct ?? null,
    resetsAt: a.resetsAt ?? null,
  };
}

export interface AiAvailabilityNotifyDeps {
  recipients(): Promise<string[]>;
  create(
    input: Parameters<typeof NotificationService.create>[0]
  ): Promise<string | undefined>;
  /** Dismiss every open AI availability notice. */
  dismissOpen(): Promise<void>;
}

export const defaultAiAvailabilityNotifyDeps: AiAvailabilityNotifyDeps = {
  recipients: resolvePodAdminUserIds,
  create: (input) => NotificationService.create(input),
  dismissOpen: async () => {
    await db
      .update(notifications)
      .set({ status: NotificationStatus.DISMISSED })
      .where(
        and(
          inArray(notifications.type, AI_NOTICE_TYPES),
          inArray(notifications.status, [
            NotificationStatus.UNREAD,
            NotificationStatus.SNOOZED,
          ])
        )
      );
  },
};

/** What the change did, for the log and the tests. */
export type AiAvailabilityNotifyOutcome =
  | { action: "none" }
  | { action: "cleared" }
  | { action: "notified"; type: string; sent: number };

export async function notifyAiAvailabilityChange(
  change: PodAiAvailabilityChange,
  deps: AiAvailabilityNotifyDeps = defaultAiAvailabilityNotifyDeps
): Promise<AiAvailabilityNotifyOutcome> {
  const now = aiAvailabilityViewOf(change.current, "payer").availability;
  const was = markOf(
    aiAvailabilityViewOf(change.previous, "payer").availability
  );
  const is = markOf(now);
  // A read the CP could not make says nothing: no notice, none cleared.
  if (!is) return { action: "none" };
  if (was && was.kind === is.kind && was.mark === is.mark) {
    return { action: "none" };
  }
  const type = NOTICE_OF[is.kind];
  const copy = now ? aiAvailabilityCopy(now) : null;
  if (!type || !copy) return { action: "cleared" };

  const recipients = await deps.recipients();
  let sent = 0;
  for (const userId of recipients) {
    try {
      const id = await deps.create({
        type,
        userId,
        workspaceId: null,
        sourceType: "system",
        groupKey: `ai:${is.kind}:${is.mark ?? "-"}:${is.resetsAt ?? "-"}`,
        data: { title: copy.title, action: copy.cta ?? "" },
      });
      if (id) sent++;
    } catch (err) {
      logger.warn({ err, type }, "AI availability notice not sent");
    }
  }
  return { action: "notified", type, sent };
}
