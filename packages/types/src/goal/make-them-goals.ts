/**
 * "MAKE THEM GOALS" — the pod's one Needs-you card for the retired goal kinds
 * (founder decision D-3, 2026-10-26). The pod carries the card
 * (`convertible-goals` signal, `signal.convertible`): the Life OS `goal`,
 * Enterprise `objective` and Project Management `okr` entities the person can
 * read that were never made a goal. Its verb opens a short review — one row
 * per entity, every one preselected, a door to each — and ONE primary,
 * "Make them goals", which converts each chosen row through the one convert
 * door (`tracks.convertFromEntity`), as the person. Nothing converts without
 * that act.
 *
 *   the rows        — {@link makeThemGoalsRows}: the card's entities, named;
 *   the project     — {@link makeThemGoalsTargets}: the single "Make it a
 *                     goal" rule, asked ONCE for the batch: a row goes to the
 *                     first project it is filed in that may hold a goal,
 *                     else to the batch's project (opening on
 *                     `defaultGoalProjectId`, the person may change it);
 *   the run         — {@link runMakeThemGoals}: each row its own call, in
 *                     order; a refusal or a throw fails THAT row only;
 *   the answer      — {@link makeThemGoalsSummary}: what happened to every
 *                     row, never "done" when one failed.
 *
 * PURE: no React, no client — the host hands the convert call in, so the desk
 * (typed tRPC) and the phone (vanilla client) run the same batch.
 */
import type { NeedsYouConvertibleGoals } from "../needs-you/index.js";
import {
  countedNoun,
  nounInSentence,
  resolveActionLabel,
  resolveObjectNoun,
} from "../vocabulary/index.js";
import {
  defaultGoalProjectId,
  projectMayHoldGoal,
  type GoalProjectLike,
} from "./new-goal.js";
import type { GoalWriteResult } from "./write.js";

const GOAL = nounInSentence(resolveObjectNoun("track"));
const PROJECT = nounInSentence(resolveObjectNoun("project"));

/** The review's words — copy, one set for desk and phone. */
export const MAKE_THEM_GOALS_COPY = {
  /** The review's title and its one primary. */
  verb: resolveActionLabel("track.make_goals", "imperative"),
  hint: `Each one becomes a ${GOAL}, linked back to it. They stay as they are.`,
  /** Asked once, only when a chosen row is filed in no project that may hold a goal. */
  projectQuestion: `In which ${PROJECT}, for the ones in none?`,
  noProject: `Choose the ${PROJECT} they belong to.`,
  nothingChosen: `Choose at least one.`,
  /** A row that could not be made a goal — said on that row, beside its door. */
  rowFailed: `Couldn't make it a ${GOAL}. Open it to try again.`,
  rowProposed: "Waiting for review",
  made: (n: number) => `Made ${countedNoun(n, GOAL)}`,
  failed: (n: number) => `${n} couldn't be made`,
  waiting: (n: number) => `${n} ${n === 1 ? "is" : "are"} waiting for review`,
} as const;

/** One row of the review. */
export interface MakeThemGoalsRow {
  entityId: string;
  /** The entity's title, else its kind's noun ("Objective"). */
  title: string;
  /** Its kind, as a person says it ("Goal", "Objective", "OKR"). */
  kindLabel: string;
  spaceName: string | null;
  /** The projects it is filed in that the person can see (the pod's read). */
  projectIds: readonly string[];
}

/** The card's entities as review rows, in the pod's order (newest first). */
export function makeThemGoalsRows(
  card: NeedsYouConvertibleGoals | null | undefined
): MakeThemGoalsRow[] {
  return (card?.entities ?? []).map((e) => ({
    entityId: e.entityId,
    title: e.title?.trim() || resolveObjectNoun(e.kind),
    kindLabel: resolveObjectNoun(e.kind),
    spaceName: e.spaceName,
    projectIds: e.projectIds,
  }));
}

/** Every row is chosen when the review opens (the person unticks what stays). */
export function makeThemGoalsPreselection(
  rows: readonly MakeThemGoalsRow[]
): Set<string> {
  return new Set(rows.map((r) => r.entityId));
}

/** The row's own project: the first it is filed in that may hold a goal, among the person's projects. */
export function ownGoalProjectId(
  row: MakeThemGoalsRow,
  projects: readonly GoalProjectLike[]
): string | null {
  const open = projects.filter(projectMayHoldGoal);
  return row.projectIds.find((id) => open.some((p) => p.id === id)) ?? null;
}

/** The batch's project, before the person picks one: the single convert's default. */
export function defaultBatchProjectId(
  projects: readonly GoalProjectLike[]
): string | null {
  return defaultGoalProjectId(projects);
}

/** What the batch will convert, and why it cannot yet. */
export interface MakeThemGoalsTargets {
  /** Each chosen row and the project its goal lands in. Empty while refused. */
  items: Array<{ entityId: string; projectId: string }>;
  /** A chosen row has no project of its own — the batch's project is asked. */
  asksProject: boolean;
  /** Why "Make them goals" cannot run yet; null when it can. Said beside it. */
  refusal: string | null;
}

export function makeThemGoalsTargets(args: {
  rows: readonly MakeThemGoalsRow[];
  chosen: ReadonlySet<string>;
  projects: readonly GoalProjectLike[];
  /** The batch's project (picked, else {@link defaultBatchProjectId}). */
  batchProjectId: string | null;
}): MakeThemGoalsTargets {
  const chosen = args.rows.filter((r) => args.chosen.has(r.entityId));
  const placed = chosen.map((r) => ({
    entityId: r.entityId,
    own: ownGoalProjectId(r, args.projects),
  }));
  const asksProject = placed.some((p) => p.own === null);
  if (chosen.length === 0)
    return {
      items: [],
      asksProject,
      refusal: MAKE_THEM_GOALS_COPY.nothingChosen,
    };
  if (asksProject && !args.batchProjectId)
    return { items: [], asksProject, refusal: MAKE_THEM_GOALS_COPY.noProject };
  return {
    items: placed.map((p) => ({
      entityId: p.entityId,
      projectId: p.own ?? (args.batchProjectId as string),
    })),
    asksProject,
    refusal: null,
  };
}

/** What happened to ONE row. */
export type MakeThemGoalsRowResult =
  | { entityId: string; outcome: "made"; goalId: string | null }
  | { entityId: string; outcome: "proposed"; proposalId: string | null }
  | { entityId: string; outcome: "failed" };

/** The convert door, as the host calls it — throws or answers `{ outcome: 'failed' }` on a refusal. */
export type ConvertOne = (
  entityId: string,
  projectId: string
) => Promise<GoalWriteResult | { outcome: "failed" | "skipped" }>;

/**
 * Convert each item through the host's door, ONE call at a time and in order
 * (two goals on one project must not race the pod's name check). A throw, a
 * refusal or a skipped call fails that row only; the rest still run.
 */
export async function runMakeThemGoals(
  items: ReadonlyArray<{ entityId: string; projectId: string }>,
  convert: ConvertOne
): Promise<MakeThemGoalsRowResult[]> {
  const results: MakeThemGoalsRowResult[] = [];
  for (const { entityId, projectId } of items) {
    try {
      const answer = await convert(entityId, projectId);
      if (answer.outcome === "proposed") {
        results.push({
          entityId,
          outcome: "proposed",
          proposalId: "proposalId" in answer ? answer.proposalId : null,
        });
      } else if (
        answer.outcome === "updated" ||
        answer.outcome === "unchanged"
      ) {
        results.push({
          entityId,
          outcome: "made",
          goalId: "goalId" in answer ? answer.goalId : null,
        });
      } else {
        results.push({ entityId, outcome: "failed" });
      }
    } catch {
      results.push({ entityId, outcome: "failed" });
    }
  }
  return results;
}

/** The batch's answer: a head line, its tone, and the rows still to look at. */
export interface MakeThemGoalsSummary {
  /** "Made 3 goals" · "Made 2 goals. 1 couldn't be made". */
  title: string;
  /** "2 are waiting for review." — null when none is. */
  detail: string | null;
  tone: "success" | "warning" | "error";
  /** The rows that failed — the review stays open on them, each with its door. */
  failed: string[];
}

export function makeThemGoalsSummary(
  results: readonly MakeThemGoalsRowResult[]
): MakeThemGoalsSummary {
  const made = results.filter((r) => r.outcome === "made").length;
  const proposed = results.filter((r) => r.outcome === "proposed").length;
  const failed = results
    .filter((r) => r.outcome === "failed")
    .map((r) => r.entityId);
  const C = MAKE_THEM_GOALS_COPY;
  const parts = [
    made > 0 ? C.made(made) : null,
    failed.length > 0 ? C.failed(failed.length) : null,
  ].filter((p): p is string => p !== null);
  // Every row held for review: nothing is made yet, and nothing failed — the
  // head says so; otherwise the held ones are the detail.
  const title = parts.length > 0 ? parts.join(". ") : C.waiting(proposed);
  const detail =
    parts.length > 0 && proposed > 0 ? `${C.waiting(proposed)}.` : null;
  return {
    title,
    detail,
    tone:
      failed.length === 0
        ? "success"
        : made + proposed > 0
          ? "warning"
          : "error",
    failed,
  };
}
