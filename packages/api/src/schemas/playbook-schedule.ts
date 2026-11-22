/**
 * The RETIRED `schedule` input of a playbook (`{ cron, enabled, mode?,
 * handToAgentId? }`). A schedule is a `schedule` activator now: the input is
 * still accepted so older producers keep their schedule, and the activator
 * convergence folds it into one (`scheduleActivatorOf`) on the next pass —
 * it never drives an automation of its own.
 *
 * LOOSE object: unknown keys survive. `null` stays accepted (clears it).
 */

import { z } from "zod";
import {
  PLAYBOOK_SCHEDULE_MODES,
  normalizePlaybookScheduleMode,
  type PlaybookActivator,
  type PlaybookScheduleMode,
} from "@synap/playbooks";
import {
  activatorKey,
  playbookActivatorSchema,
  readPlaybookProcess,
} from "./playbook-process.js";

const playbookScheduleSchema = z
  .looseObject({
    cron: z.string().optional(),
    enabled: z.boolean().optional(),
    mode: z
      .enum(
        PLAYBOOK_SCHEDULE_MODES as readonly [
          PlaybookScheduleMode,
          ...PlaybookScheduleMode[],
        ]
      )
      .optional(),
    handToAgentId: z.string().trim().min(1).optional(),
  })
  .nullable();

/** The door form: input type `unknown`, so internal producers forward jsonb uncast. */
export const playbookScheduleInputSchema = z
  .unknown()
  .pipe(playbookScheduleSchema);

/**
 * The `schedule` activator a retired schedule says, or why none can (a cron
 * the rule grammar cannot spell, a hand-off beside an appointment, an
 * appointment per thing). null when there is no schedule (no cron).
 *
 * A playbook with a subject kind ran once per thing of it: `per_thing` (its
 * `subjectProfile.filter` still selects which). `armed: false` (its backing
 * automation was paused) or `enabled: false` installs it paused.
 */
export function scheduleActivatorOf(
  schedule: unknown,
  subjectKind: string | null,
  armed = true
): { activator: PlaybookActivator } | { error: string } | null {
  if (!schedule || typeof schedule !== "object") return null;
  const s = schedule as Record<string, unknown>;
  const cron = typeof s.cron === "string" ? s.cron.trim() : "";
  if (!cron) return null;
  const handTo =
    typeof s.handToAgentId === "string" ? s.handToAgentId.trim() : "";
  const parsed = playbookActivatorSchema.safeParse({
    on: "schedule",
    cron,
    mode: normalizePlaybookScheduleMode(s.mode),
    ...(subjectKind ? { size: "per_thing" } : {}),
    ...(handTo ? { handToAgentId: handTo } : {}),
    ...(s.enabled === true && armed ? {} : { startsPaused: true }),
  });
  if (!parsed.success) {
    return {
      error: `schedule: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }
  return { activator: parsed.data as PlaybookActivator };
}

/**
 * Why the door refuses a retired `schedule` input, or null: one the activator
 * pass could not fold would sit stored and never fire, and one beside a
 * different declared schedule activator would be a second clock.
 */
export function retiredScheduleRefusal(
  schedule: unknown,
  subjectProfile: unknown
): string | null {
  const process = readPlaybookProcess(subjectProfile);
  const folded = scheduleActivatorOf(schedule, process.profileSlug);
  if (!folded) return null;
  if ("error" in folded) return folded.error;
  const key = activatorKey(folded.activator);
  return process.activators.some(
    (a) => a.on === "schedule" && activatorKey(a) !== key
  )
    ? "this playbook declares its schedule as an activator: change its schedule activator instead of schedule"
    : null;
}
