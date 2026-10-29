/**
 * The track STATUS declaration, in a leaf with no runtime imports: a pure
 * module that classifies a goal's status (`connections/dependency.ts`) reads
 * it without importing `./track.ts`, whose runtime import of `./session.ts`
 * would close a cycle back into that module. `./track.ts` re-exports all of
 * it, so every importer is unchanged.
 */
import type { LifecycleCategory } from "../lifecycle/option.js";

/**
 * A track's status — the stored option keys of its SYSTEM LIFECYCLE (work
 * model D1, 2026-10-23). The DB column (`project_tracks.status`) holds exactly
 * these: the pod re-exports this list as `PROJECT_TRACK_STATUSES`
 * (`@synap/database`).
 *
 * Machine values are contracts (the CLI, IS, Control Plane, Relay and the
 * browser send them): `completed` and `archived` keep their keys; people read
 * them as "Closed" and "Dropped" (`resolveTrackStatusLabel`).
 */
export const TRACK_STATUSES = [
  "proposed",
  "agreed",
  "ready",
  "active",
  "paused",
  "completed",
  "archived",
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

/**
 * THE track lifecycle, declared ONCE like a kind's lifecycle: each status's
 * fixed CATEGORY, and which one only a person may enter. Keyed by every
 * status, so a status added to {@link TRACK_STATUSES} and not classified here
 * stops the build.
 *
 *   open    proposed → agreed (criteria and bounds agreed with the doers) →
 *           ready (prerequisites clear) — R3, before work starts. `agreed`
 *           is HUMAN-ONLY: agreeing is a person's act; an agent's move into
 *           it is always a proposal (code-core F11);
 *   active  active (a new track's default);
 *   paused  paused (chosen; a check gate may also hold it);
 *   done    completed — "Closed": HUMAN-ONLY, an agent's close always
 *           becomes a proposal, whatever rule the pod has;
 *   lost    archived — "Dropped": an agent's drop proposes by default, as
 *           a move into lost does for any kind.
 * How it ended is a separate VERDICT ({@link TRACK_VERDICTS}), never more
 * statuses.
 */
export const TRACK_STATUS_DECLARATION = {
  proposed: { category: "open" },
  agreed: { category: "open", humanOnly: true },
  ready: { category: "open" },
  active: { category: "active" },
  paused: { category: "paused" },
  completed: { category: "done", humanOnly: true },
  archived: { category: "lost" },
} as const satisfies Record<
  TrackStatus,
  { category: LifecycleCategory; humanOnly?: true }
>;

/** The statuses whose category is `C` — derived from the declaration. */
export type TrackStatusIn<C extends LifecycleCategory> = {
  [K in TrackStatus]: (typeof TRACK_STATUS_DECLARATION)[K]["category"] extends C
    ? K
    : never;
}[TrackStatus];

/** The category of a track status; `null` for a value no option declares. */
export function trackStatusCategory(
  status: string | null | undefined
): LifecycleCategory | null {
  if (status == null) return null;
  return Object.hasOwn(TRACK_STATUS_DECLARATION, status)
    ? TRACK_STATUS_DECLARATION[status as TrackStatus].category
    : null;
}
