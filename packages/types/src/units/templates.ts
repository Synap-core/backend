/**
 * Templates on offer — which templates a "Start from…" list shows, in which
 * group, and what seeding a work template copies. Pure; shared by relay's
 * new-work page and the browser's Home "Start from…" picker (and the
 * contextual doors, AddTrackPicker / FollowPlaybookPicker), so the two
 * surfaces cannot fork the rule. Before this leaf, relay kept
 * `trackMethodsOf` / `sessionStartersOf` / `usedByLine` and the browser kept
 * `trackMethodOptions` / `usedByLabel` — two copies that had already drifted
 * (only one dropped archived rows).
 *
 * A template's KIND is derived, never declared (`skills/synap/concepts.md` →
 * Template): a playbook with `scope: "project"` is a TRACK template — a method
 * a project runs over weeks, started through `tracks.start` (the pod refuses a
 * session-scoped one) — and anything else (`"session"`, or NULL, which the
 * schema reads as session) is a WORK template: one sitting of work.
 */

import {
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "../vocabulary/index.js";

/** The fields of a `playbooks.list` row these rules read. */
export interface TemplateRowLike {
  scope?: string | null;
  status?: string | null;
}

/** A retired template is not a thing to start. */
function isStartable(row: TemplateRowLike): boolean {
  return row.status !== "archived";
}

/** True for a track template (`scope: "project"`). */
export function isTrackTemplate(row: TemplateRowLike): boolean {
  return row.scope === "project";
}

/** The TRACK templates on offer: project-scoped, not archived. */
export function trackTemplatesOf<T extends TemplateRowLike>(
  rows: readonly T[]
): T[] {
  return rows.filter((row) => isStartable(row) && isTrackTemplate(row));
}

/**
 * The WORK templates on offer. When the same list ALSO offers the track
 * templates (`tracksOffered`), a project-scoped one is listed there only —
 * two doors with two different outcomes on one name is the defect. Where no
 * track group exists, every startable template stays.
 */
export function workTemplatesOf<T extends TemplateRowLike>(
  rows: readonly T[],
  opts: { tracksOffered: boolean }
): T[] {
  return rows.filter(
    (row) => isStartable(row) && !(opts.tracksOffered && isTrackTemplate(row))
  );
}

/**
 * "Used by N projects" — only when the pod SENT a positive count. An absent
 * count is not a zero (an older pod), so it says nothing rather than
 * "Used by 0".
 */
export function templateUsedByLine(
  count: number | null | undefined
): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return null;
  }
  const noun =
    count === 1
      ? resolveObjectNoun("project")
      : resolveObjectNounPlural("project");
  return `Used by ${count} ${noun.toLowerCase()}`;
}

/**
 * The minimum a stage needs to pass the pod's write boundary
 * (`schemas/playbook-stage.ts`): a non-blank `key` (what
 * `focus_sessions.currentStage` stores), a non-blank `name`, and a `category`.
 * Everything else rides along WHOLE — the schema is a `looseObject`.
 */
export interface SeedableStage {
  key: string;
  name: string;
  category: string;
  [field: string]: unknown;
}

/**
 * A template row → the steps worth copying onto a session as the session's
 * OWN snapshot (`focus_sessions.stages`). This is how a work template STARTS
 * work (the start-work door): it seeds, it never binds — `playbookId` stays
 * unwritten, so the session stays `work` and stays on the Work list.
 *
 * Malformed stages are dropped one by one (a missing `name`/`category` would
 * make the pod refuse the WHOLE write), and a duplicate key keeps its first
 * spelling (two stages with one key make the active step ambiguous).
 */
export function readSeedableStages(playbook: unknown): SeedableStage[] {
  const raw = (playbook as { stages?: unknown } | null | undefined)?.stages;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SeedableStage[] = [];
  for (const stage of raw) {
    const s = stage as {
      key?: unknown;
      name?: unknown;
      category?: unknown;
    } | null;
    const key = s?.key;
    if (typeof key !== "string" || !key.trim() || seen.has(key)) continue;
    if (typeof s?.name !== "string" || !s.name.trim()) continue;
    if (typeof s?.category !== "string") continue;
    seen.add(key);
    out.push(stage as SeedableStage);
  }
  return out;
}
