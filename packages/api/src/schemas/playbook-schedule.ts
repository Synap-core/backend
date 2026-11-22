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
import { playbookActivatorSchema } from "./playbook-process.js";

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
 * The `schedule` activator a retired schedule says, or why none can: a cron
 * the rule grammar cannot spell, a `subjectProfile.filter` that is not one
 * status plus at most one other property, an appointment per thing. null when
 * there is no schedule (no cron).
 *
 * A playbook with a subject kind ran once per thing of it (the filter
 * selecting which): `per_thing`. `armed: false` (its backing automation was
 * paused) or `enabled: false` installs it paused.
 */
export function scheduleActivatorOf(
  schedule: unknown,
  process: {
    profileSlug: string | null;
    /** Where the subject's status lives: the playbook's, else the declared lifecycle. */
    statusProperty: string | null;
    filter: unknown;
  },
  armed = true
): { activator: PlaybookActivator } | { error: string } | null {
  if (!schedule || typeof schedule !== "object") return null;
  const s = schedule as Record<string, unknown>;
  const cron = typeof s.cron === "string" ? s.cron.trim() : "";
  if (!cron) return null;
  const set = filterAsSet(process.filter, process.statusProperty);
  if ("error" in set) return set;
  const handTo =
    typeof s.handToAgentId === "string" ? s.handToAgentId.trim() : "";
  const parsed = playbookActivatorSchema.safeParse({
    on: "schedule",
    cron,
    mode: normalizePlaybookScheduleMode(s.mode),
    ...(process.profileSlug ? { size: "per_thing" } : {}),
    ...set,
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
 * A stored `subjectProfile.filter` (a JSON object of `properties.<slug>` →
 * value) as an activator's set: the status property's value is its
 * `status`, one other property its `only`. Anything else cannot be said.
 */
function filterAsSet(
  filter: unknown,
  statusProperty: string | null
):
  | { status?: string; only?: { property: string; in: string[] } }
  | { error: string } {
  if (filter === undefined || filter === null || filter === "") return {};
  let parsed: unknown = filter;
  if (typeof filter === "string") {
    try {
      parsed = JSON.parse(filter);
    } catch {
      return { error: "subjectProfile.filter is not JSON" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "subjectProfile.filter is not an object" };
  }
  const out: { status?: string; only?: { property: string; in: string[] } } =
    {};
  for (const [key, value] of Object.entries(parsed)) {
    const property = key.startsWith("properties.")
      ? key.slice("properties.".length)
      : null;
    if (!property || typeof value !== "string") {
      return {
        error: `subjectProfile.filter "${key}" is not a property value a schedule can select on`,
      };
    }
    if (property === statusProperty && out.status === undefined) {
      out.status = value;
    } else if (out.only === undefined) {
      out.only = { property, in: [value] };
    } else {
      return {
        error:
          "subjectProfile.filter selects on more than one property besides the status",
      };
    }
  }
  return out;
}
