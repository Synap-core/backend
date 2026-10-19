/**
 * PLACES — which projects a person can stand in, and what the two non-project
 * places are called (projects as places, 2026-10-14). One rule for the desktop
 * rail, the relay switcher and every filing picker, so a project can never be
 * a place on one surface and absent on another (places review S1).
 *
 * A place is an ACTIVE project. A completed or archived one is still readable
 * (its page, its chips on the things filed into it) but no longer a place.
 *
 * Pure and dependency-free beyond the vocabulary.
 */
import {
  nounInSentence,
  resolveDestinationLabel,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";

/** "All projects" — the place that is no project: every project at once. */
export const ALL_PROJECTS = `All ${nounInSentence(resolveObjectNounPlural("project"))}`;

/**
 * "Unfiled" — the place of the things filed into no project (founder 2A,
 * 2026-10-19; was "Not in a project"). The name of the constant stays, so the
 * rail, Home, Data's narrow, Work's narrow and relay's switcher keep reading
 * the ONE word without a rename sweep.
 */
export const NOT_IN_A_PROJECT = resolveDestinationLabel("unfiled");

/** The fields of a project row the place rules read. */
export interface PlaceProjectRow {
  id: string;
  status?: string | null;
  createdAt?: string | Date | null;
}

/** A project is a place while it is active. */
export function isPlaceProject(project: { status?: string | null }): boolean {
  return project.status === "active";
}

function createdMs(row: PlaceProjectRow): number {
  if (!row.createdAt) return Number.POSITIVE_INFINITY;
  const ms = new Date(row.createdAt).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * The places, in their ONE order: oldest first (a new project appends, so
 * every place a person has learned keeps its position), the id breaking ties
 * so the order is total. `projects.list` returns newest first — never render
 * it as-is.
 */
export function placeProjects<T extends PlaceProjectRow>(
  rows: readonly T[]
): T[] {
  return rows
    .filter(isPlaceProject)
    .sort((a, b) => createdMs(a) - createdMs(b) || a.id.localeCompare(b.id));
}

/**
 * Whether a lens naming `projectId` is STALE — the projects read PROVES it is
 * no place any more (completed, archived, or gone), so the host clears the
 * lens: a lens left pointing at it would narrow every surface to a scope
 * nobody can stand in.
 *
 * Only a settled read proves anything (`settled: false` while it is loading
 * or after it failed), and a project missing from a list that may be CUT (it
 * came back at its limit) may simply be past the limit (`mayBeCut: true`).
 */
export function isStalePlaceLens(
  projectId: string,
  rows: readonly PlaceProjectRow[],
  read: { settled: boolean; mayBeCut: boolean }
): boolean {
  if (!read.settled) return false;
  const row = rows.find((p) => p.id === projectId);
  return row ? !isPlaceProject(row) : !read.mayBeCut;
}
