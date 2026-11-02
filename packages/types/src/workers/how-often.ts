/**
 * `@synap-core/types/workers/how-often` — the New goal flows' "How often?"
 * question, turned into what `workers.enable` takes (goals that run).
 *
 * The person picks one of four answers:
 *
 *   daily       every day at a time (UTC, the zone the pod schedules in);
 *   weekly      every week on a day at a time;
 *   event       when something happens: one of the events the chosen
 *               playbook DECLARES ({@link howOftenEvents}), never a free one;
 *   until_done  the goal is worked until it is done: NO worker.
 *
 * {@link howOftenEnable} says what to do with that answer and the chosen
 * playbook's declared activators: enable the declared worker (its
 * `activatorKey`), enable nothing, or tell the person the playbook does not
 * run that way. Only a DECLARED activator can be enabled, with one
 * exception: a playbook that works on no subject declares none, and the
 * person's own clock (daily / weekly) is enabled for it (`chosen: true`;
 * `workers.enable` takes the same answer as `schedule` and compiles it
 * through the same governed rule door). The cron is built by the rule grammar's own
 * builder (`cronExpressionOf`), never spelled here, and the key by the one
 * {@link workerActivatorKey}.
 */
import { cronExpressionOf } from "../automations/cron-recurrence.js";
import { workerActivatorKey, type WorkerActivator } from "./index.js";

export const HOW_OFTEN_KINDS = [
  "daily",
  "weekly",
  "event",
  "until_done",
] as const;
export type HowOftenKind = (typeof HOW_OFTEN_KINDS)[number];

export type HowOften =
  /** `time` is "HH:MM", 24 h, UTC. */
  | { kind: "daily"; time: string }
  /** `day` 0 = Sunday … 6 = Saturday; `time` "HH:MM", 24 h, UTC. */
  | { kind: "weekly"; day: number; time: string }
  /** `activatorKey` of one of {@link howOftenEvents}. */
  | { kind: "event"; activatorKey: string }
  | { kind: "until_done" };

/** The activator triggers that are "something happens". */
const EVENT_TRIGGERS: ReadonlySet<WorkerActivator["on"]> = new Set([
  "created",
  "enters_status",
  "count",
]);

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The schedule activator a clock answer means; null for `event` (the
 * playbook's own declaration is the activator) and `until_done` (no worker),
 * and for a time or day that is not one.
 */
export function howOftenActivator(
  choice: HowOften
): (WorkerActivator & { on: "schedule"; cron: string }) | null {
  if (choice.kind !== "daily" && choice.kind !== "weekly") return null;
  if (!TIME_RE.test(choice.time)) return null;
  if (
    choice.kind === "weekly" &&
    !(Number.isInteger(choice.day) && choice.day >= 0 && choice.day <= 6)
  ) {
    return null;
  }
  const cron = cronExpressionOf(
    choice.kind === "daily"
      ? { triggerType: "cron", cronFrequency: "daily", cronTime: choice.time }
      : {
          triggerType: "cron",
          cronFrequency: "weekly",
          cronTime: choice.time,
          cronDays: [choice.day],
        }
  );
  return { on: "schedule", cron };
}

/**
 * The "when something happens" answers a playbook offers: its declared
 * created / enters_status / count activators, each with the key
 * `workers.enable` takes. Words come from `workerWhen`
 * (`@synap-core/types/workers/words`).
 */
export function howOftenEvents(
  declared: readonly WorkerActivator[]
): { activatorKey: string; activator: WorkerActivator }[] {
  return declared
    .filter((a) => EVENT_TRIGGERS.has(a.on))
    .map((a) => ({ activatorKey: workerActivatorKey(a), activator: a }));
}

/** What a "How often?" answer asks of `workers.enable`. */
export type HowOftenEnable =
  /** Until it's done: enable nothing. */
  | { status: "no_worker" }
  /**
   * Call `workers.enable({ playbookId, trackId, activatorKey })`, or, for a
   * `chosen` clock (a playbook with no subject: nothing is declared),
   * `workers.enable({ playbookId, trackId, schedule: <the answer> })`.
   */
  | {
      status: "enable";
      activatorKey: string;
      activator: WorkerActivator;
      chosen?: true;
    }
  /**
   * The playbook declares no such worker: the person picks another answer
   * or another playbook (a clock it does not declare would need the
   * playbook edited first, which is a governed change, not this flow's).
   */
  | { status: "not_declared"; activatorKey: string | null }
  /** A time or day that is not one. */
  | { status: "invalid" };

/**
 * The ONE reading of a "How often?" answer against the chosen playbook's
 * declared activators. A clock answer matches a declared schedule on its
 * compiled key (both through {@link workerActivatorKey}), so "every Monday at
 * 09:00" finds `schedule:0 9 * * 1` however it was declared.
 */
export function howOftenEnable(
  choice: HowOften,
  declared: readonly WorkerActivator[],
  /** The playbook works on no subject (`runsWithoutSubject` on a match row). */
  opts: { runsWithoutSubject?: boolean } = {}
): HowOftenEnable {
  if (choice.kind === "until_done") return { status: "no_worker" };
  if (choice.kind === "event") {
    const hit = howOftenEvents(declared).find(
      (e) => e.activatorKey === choice.activatorKey
    );
    return hit
      ? {
          status: "enable",
          activatorKey: hit.activatorKey,
          activator: hit.activator,
        }
      : { status: "not_declared", activatorKey: choice.activatorKey };
  }
  const clock = howOftenActivator(choice);
  if (!clock) return { status: "invalid" };
  const key = workerActivatorKey(clock);
  const hit = declared.find(
    (a) => a.on === "schedule" && workerActivatorKey(a) === key
  );
  if (hit) return { status: "enable", activatorKey: key, activator: hit };
  // A playbook with no subject declares no worker: the person's clock is its
  // worker. One with a subject runs only as it declares.
  return opts.runsWithoutSubject && false
    ? { status: "enable", activatorKey: key, activator: clock, chosen: true }
    : { status: "not_declared", activatorKey: key };
}
