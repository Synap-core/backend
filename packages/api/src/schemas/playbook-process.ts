/**
 * The PROCESS half of a playbook definition — the subject lifecycle contract.
 *
 *   subjectProfile: { profileSlug, filter?, statusProperty? }
 *   activators?:        [{ on: "created" | "enters_status", status?, mode }]
 *   humanOnlyStatuses?: string[]
 *
 * ── WHERE IT IS STORED, AND WHY ONE FOLD ────────────────────────────────────
 * `activators` and `humanOnlyStatuses` are TOP-LEVEL on the wire (the process
 * contract), but the `playbooks` row has no column for them and this wave adds
 * no migration. Both describe the SUBJECT's lifecycle (an activator fires on the
 * subject kind's events; a human-only status is a value of the subject's status
 * property), so they are STORED inside the existing `subject_profile` jsonb,
 * beside `statusProperty`. {@link foldProcessIntoSubjectProfile} is the ONE
 * place the wire shape becomes the stored shape — the package projection, the
 * router create and the router update all call it, so `subjectProfile` (a
 * MANAGED field) carries them through install, reconcile and every run's
 * `definitionSnapshot` with no second path. Readers go through
 * {@link readPlaybookProcess}, never `subjectProfile.activators` by hand.
 */

import { z } from "zod";
import type { PlaybookActivator } from "@synap/playbooks";

const statusValueSchema = z.string().trim().min(1).max(200);

/** One declared activator — see `PlaybookActivator` (@synap/playbooks). */
export const playbookActivatorSchema = z
  .strictObject({
    on: z.enum(["created", "enters_status"]),
    status: statusValueSchema.optional(),
    // `propose` is the default for public templates: a process starts only
    // when a person says so, unless the author explicitly chose `run`.
    mode: z.enum(["run", "propose"]).default("propose"),
  })
  .refine((a) => a.on !== "enters_status" || !!a.status, {
    message: 'An activator with on: "enters_status" needs the status it enters',
    path: ["status"],
  })
  .refine((a) => a.on !== "created" || a.status === undefined, {
    message: 'An activator with on: "created" takes no status',
    path: ["status"],
  });

export const playbookActivatorsSchema = z
  .array(playbookActivatorSchema)
  .max(12)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((a, i) => {
      const key = activatorKey(a);
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [i],
          message: `activators repeats "${key}" — each trigger is declared once`,
        });
      }
      seen.add(key);
    });
  });

export const humanOnlyStatusesSchema = z.array(statusValueSchema).max(50);

/**
 * `subjectProfile` — loose (unknown keys survive a round-trip), with the keys
 * this contract owns typed. `profileSlug` stays optional: a subject-less
 * playbook may still store `{}` and the existing doors already accept it.
 */
export const playbookSubjectProfileSchema = z.looseObject({
  profileSlug: z.string().min(1).optional(),
  /** The subject kind's property slug holding its lifecycle (e.g. "post-status"). */
  statusProperty: z.string().trim().min(1).max(120).optional(),
  activators: playbookActivatorsSchema.optional(),
  humanOnlyStatuses: humanOnlyStatusesSchema.optional(),
});

/** The stable identity of an activator within one playbook. */
export function activatorKey(a: {
  on: string;
  status?: string | null;
}): string {
  return a.on === "enters_status" ? `enters_status:${a.status ?? ""}` : a.on;
}

/**
 * THE fold: wire top-level `activators` / `humanOnlyStatuses` → stored inside
 * `subjectProfile`. Returns the `subjectProfile` to persist, or `undefined`
 * when the definition says nothing about any of the three (so a PATCH that is
 * silent stays silent). A top-level value WINS over a nested one — it is the
 * explicit contract spelling.
 *
 * Refuses (throws) activators without a subject kind: an activator fires on
 * the subject kind's events, and one with no kind could only compile into a
 * rule that fires on every entity.
 */
export function foldProcessIntoSubjectProfile(def: {
  subjectProfile?: Record<string, unknown> | null;
  activators?: unknown;
  humanOnlyStatuses?: unknown;
}): Record<string, unknown> | null | undefined {
  const hasTop =
    def.activators !== undefined || def.humanOnlyStatuses !== undefined;
  if (!hasTop) return def.subjectProfile;
  const base =
    def.subjectProfile && typeof def.subjectProfile === "object"
      ? { ...def.subjectProfile }
      : {};
  if (def.activators !== undefined) base.activators = def.activators;
  if (def.humanOnlyStatuses !== undefined)
    base.humanOnlyStatuses = def.humanOnlyStatuses;
  const acts = base.activators;
  if (
    Array.isArray(acts) &&
    acts.length > 0 &&
    typeof base.profileSlug !== "string"
  ) {
    throw new ProcessDeclarationError(
      "activators need subjectProfile.profileSlug — an activator fires on the subject kind's events"
    );
  }
  return base;
}

export class ProcessDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessDeclarationError";
  }
}

/** The process contract as read off a stored row (tolerant: stored jsonb is data). */
export interface PlaybookProcess {
  profileSlug: string | null;
  statusProperty: string | null;
  activators: PlaybookActivator[];
  humanOnlyStatuses: string[];
  /**
   * True when a STORED `activators` value failed to parse. Distinct from "no
   * activators": the compiler must not read a corrupt declaration as an empty
   * one and retire every rule it compiled.
   */
  activatorsInvalid: boolean;
}

/** Read the process contract out of a stored `subject_profile` jsonb. */
export function readPlaybookProcess(subjectProfile: unknown): PlaybookProcess {
  const sp =
    subjectProfile && typeof subjectProfile === "object"
      ? (subjectProfile as Record<string, unknown>)
      : {};
  const profileSlug =
    typeof sp.profileSlug === "string" && sp.profileSlug ? sp.profileSlug : null;
  const statusProperty =
    typeof sp.statusProperty === "string" && sp.statusProperty.trim()
      ? sp.statusProperty.trim()
      : null;
  const acts = playbookActivatorsSchema.safeParse(sp.activators ?? []);
  const human = humanOnlyStatusesSchema.safeParse(sp.humanOnlyStatuses ?? []);
  return {
    profileSlug,
    statusProperty,
    activators: acts.success ? (acts.data as PlaybookActivator[]) : [],
    humanOnlyStatuses: human.success ? human.data : [],
    activatorsInvalid: !acts.success,
  };
}
