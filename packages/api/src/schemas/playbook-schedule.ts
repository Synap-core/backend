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
const playbookScheduleModeSchema = z.enum(
  PLAYBOOK_SCHEDULE_MODES as readonly [
    PlaybookScheduleMode,
    ...PlaybookScheduleMode[],
  ]
);

const playbookScheduleSchema = z
  .looseObject({
    /** 5-field cron expression. Absent/blank reads as "no schedule". */
    cron: z.string().optional(),
    enabled: z.boolean().optional(),
    /** Absent ⇒ "run" (see `normalizePlaybookScheduleMode`). */
    mode: playbookScheduleModeSchema.optional(),
  })
  .nullable();

/**
 * The DOOR form: validates exactly like `playbookScheduleSchema` and outputs
 * the typed schedule, but its INPUT type is `unknown`. The internal producers
 * (template appliers, the proposal executor, the Hub REST mirror) forward a
 * schedule read off untyped jsonb and all reach the router caller, so this
 * parse is the one WRITE validation — no casts scattered across call sites.
 * It is not the only interpreter: READS of the stored jsonb (`readSchedule` in
 * `services/playbooks/cron-automation.ts`, and the browser's mirror) normalize
 * `mode` via `normalizePlaybookScheduleMode`.
 */
export const playbookScheduleInputSchema = z
  .unknown()
  .pipe(playbookScheduleSchema);
