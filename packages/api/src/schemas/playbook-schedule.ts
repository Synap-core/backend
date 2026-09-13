/**
 * PlaybookSchedule — the runtime WRITE-boundary schema.
 *
 * `schedule` was accepted as `z.unknown()` at the playbook doors, so
 * `PlaybookSchedule.mode` ("run" | "appointment") had no declared writer: the
 * field reached the flow builder only if a caller happened to know it existed,
 * and a misspelled mode was stored silently (then read back as "run").
 *
 * It lives HERE, next to `playbook-stage.ts`, for the same reason: @synap/playbooks
 * is the dependency-free contract package; the type and the read-side normalizer
 * (`normalizePlaybookScheduleMode`) stay there, the zod half lives with its
 * consumers in @synap/api.
 *
 * LOOSE object: the column is jsonb, so unknown keys are preserved, never
 * stripped — a strict object would silently drop fields on an update round-trip.
 * `null` stays accepted: it is how a schedule is cleared.
 */

import { z } from "zod";
import {
  PLAYBOOK_SCHEDULE_MODES,
  type PlaybookScheduleMode,
} from "@synap/playbooks";

/** Derived from the contract package's list rather than re-typed. */
export const playbookScheduleModeSchema = z.enum(
  PLAYBOOK_SCHEDULE_MODES as readonly [
    PlaybookScheduleMode,
    ...PlaybookScheduleMode[],
  ]
);

export const playbookScheduleSchema = z
  .looseObject({
    /** 5-field cron expression. Absent/blank reads as "no schedule". */
    cron: z.string().optional(),
    enabled: z.boolean().optional(),
    /** Absent ⇒ "run" (see `normalizePlaybookScheduleMode`). */
    mode: playbookScheduleModeSchema.optional(),
  })
  .nullable();

export type PlaybookScheduleInput = z.infer<typeof playbookScheduleSchema>;

/**
 * The DOOR form: validates exactly like `playbookScheduleSchema` and outputs
 * the typed schedule, but its INPUT type is `unknown`. The internal producers
 * (template appliers, the proposal executor, the Hub REST mirror) forward a
 * schedule read off untyped jsonb; they stay on that loose passthrough and the
 * router's parse remains the one place a schedule is interpreted — no casts
 * scattered across call sites.
 */
export const playbookScheduleInputSchema = z
  .unknown()
  .pipe(playbookScheduleSchema);
