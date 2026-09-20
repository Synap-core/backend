/**
 * IoC slot for `NotificationService.create()`, which lives in @synap/api.
 *
 * WHY A SLOT AND NOT AN IMPORT. `@synap/api` depends on `@synap/jobs`, never the
 * reverse (`packages/api/package.json` lists `@synap/jobs`; `packages/jobs/package.json`
 * does not list `@synap/api`), so a direct call from here is a circular
 * dependency. Both packages nonetheless run in the SAME process — apps/api is
 * what hosts every pg-boss worker — so apps/api fills this slot at boot. Exactly
 * the shape `registerCleanupPackRunner` uses (declared
 * `workers/pod-hygiene-cleanup-pack-cron.ts`, exported `packages/api/src/index.ts`,
 * filled `apps/api/src/index.ts`), and the shape
 * `__tripwires__/jobs-ioc-slots-are-filled-at-boot.test.ts` DERIVES both sides of
 * — so this slot joins that guard by existing and cannot ship unfilled.
 *
 * WHAT IT FIXES. Three jobs-side producers used to `db.insert(notifications)`
 * directly. The consequence was not "no push" — it was worse: `agent.task_failed`
 * and `ai.proactive.insight` each have a SECOND, compliant producer in
 * packages/api, so those two types were PARTIALLY governed. A user who muted
 * `agent.task_failed` silenced failures reported through the Hub REST door while
 * headless A2AI turn failures kept arriving. A switch that works sometimes reads
 * as flakiness, not as a bug, which makes it far harder to diagnose than a
 * switch that never works at all.
 *
 * The input MIRRORS @synap/api's `CreateNotificationInput` structurally (it
 * cannot be imported across the boundary). It is deliberately NARROWER: only the
 * fields a jobs-side producer actually needs. A field added to the api type that
 * is not here is simply unavailable from jobs — which is a visible compile error
 * at the call site, not a silent drop.
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "notification-creator" });

export interface JobsNotificationInput {
  type: string;
  userId: string;
  workspaceId?: string | null;
  sourceType:
    | "proposal"
    | "connector"
    | "agent"
    | "system"
    | "inbox_item"
    | "proactive_message"
    | "session";
  sourceId?: string;
  data: Record<string, unknown>;
  groupKey?: string;
}

/** Returns the created notification's id, or undefined when nothing was written. */
export type NotificationCreator = (
  input: JobsNotificationInput
) => Promise<string | undefined>;

let notificationCreator: NotificationCreator | null = null;

export function registerNotificationCreator(fn: NotificationCreator): void {
  notificationCreator = fn;
}

/**
 * Create a notification through the ONE write door.
 *
 * An UNFILLED slot returns undefined and logs an ERROR — it never falls back to
 * a direct insert. A fallback insert is precisely the bypass this slot exists to
 * remove, and a fallback that only fires when the slot is empty would be the
 * worst of both: ungoverned rows appearing under conditions nobody can predict
 * from reading either file. The boot tripwire makes an unfilled slot a CI
 * failure, so this branch should be unreachable in a shipped pod; the log is
 * what proves it if it ever is not.
 */
export async function createNotificationViaService(
  input: JobsNotificationInput
): Promise<string | undefined> {
  if (!notificationCreator) {
    logger.error(
      { type: input.type, userId: input.userId },
      "notification creator not registered — notification NOT written. " +
        "apps/api must call registerNotificationCreator() at boot."
    );
    return undefined;
  }
  try {
    return await notificationCreator(input);
  } catch (err) {
    // `NotificationService.create` already logs non-fatally and does not throw;
    // this is belt-and-braces so a notification can never break a worker.
    logger.warn(
      { err, type: input.type },
      "notification create failed (non-fatal)"
    );
    return undefined;
  }
}
