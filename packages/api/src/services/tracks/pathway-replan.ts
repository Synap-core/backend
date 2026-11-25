/**
 * THE PATHWAY RE-PLAN (pathway plan 368179d7, P9, founder 21 Nov 2026) — the
 * loop BESIDE the goal loop (`goal-loop.ts`), sharing its seams, its budget
 * window and its one-pending count (`loopProposalCounts`, `loopBudgetHold`).
 * Its rule is the pure `decidePathwayReplan` (@synap-core/types/units).
 *
 * WHAT FIRES IT — only an UNEXPECTED end of a step of a pathway (a session
 * filed in a goal whose `workKind` is `pathway`): it ended without delivering
 * (`sessionClosedAs` = `not_done`: closed with a required criterion left
 * open, cancelled, failed), so every step waiting on it holds on a dropped
 * blocker (the dependency rule) until someone re-plans. A step SKIPPED as a
 * decision's arm not taken is expected and never fires it. Only ends of the
 * last {@link GOAL_LOOP_WINDOW_DAYS} days count: switching this on never
 * re-plans history.
 *
 * WHAT IT FILES — ONE plan revision, through THE capture plan door
 * (`submitCaptureGraph`, `plan.edits`), as the pod (`PATHWAY_REPLAN_AUTHOR`)
 * for the steps' owner to approve. Always PENDING: no agent key rides it, so
 * nothing auto-applies, and the loop itself applies nothing. For each step it
 * re-plans: a new step "Retry: …" with the step's goal and required criteria,
 * under the same parent, in the same goal; every open step that waited on it
 * stops waiting on it (`remove_link`) and waits on the retry instead
 * (`create_link`). Its content is derived, never a model call (the goal loop
 * makes none either). Decisions are never touched: a pending decision keeps
 * its id and its arm edges. A decision rejected, or accepted with no arm for
 * its choice, needs a person's judgment, not a derived revision: the arm
 * notice (`decision-arms.ts`) and the dependents' `blocker_dropped` say it.
 *
 * ONE PENDING per pathway, budgeted by the goal's weekly budget
 * (`readGoalLoop(track.loop).perWeek`, the goal loop's own setting). A step a
 * revision named is never named again, whatever became of the revision (a
 * person who rejected it decided). A retry that ends without delivering too
 * STOPS the loop for it (two tries). The audit line of each filing is the
 * proposal's own `.requested` event (`createEventBackedProposal`).
 *
 * WHEN — the goal loop's seams, never a scheduler of its own: a session filed
 * in the goal closes (`goal-loop-reactor.ts`), and the hourly reaper tick
 * (`sweepGoalLoops` → {@link sweepPathwayReplans}) for what a budget or a
 * pending revision held. KNOWN LIMIT (as the goal loop's): two triggers
 * racing on one pathway in the same instant can both pass the one-pending
 * check; the capture door's content key returns the first proposal to a
 * replay of the same revision.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  gt,
  inArray,
  drizzleSql,
  focusSessions,
  getParentSessionIds,
  links,
  projectTracks,
  projects,
  proposals,
} from "@synap/database";
import type { ProjectTrack } from "@synap/database/schema";
import {
  GOAL_LOOP_WINDOW_DAYS,
  decidePathwayReplan,
  readGoalLoop,
  trackStatusCategory,
  type PathwayEndedStep,
  type PathwayReplanHold,
} from "@synap-core/types/units";
import {
  SESSION_TITLE_MAX,
  TERMINAL_SESSION_STATUSES,
  resolveSessionTitle,
  sessionClosedAs,
} from "@synap-core/types/focus-sessions";
import { isDependencyEnded } from "@synap-core/types/connections";
import { readMaterializedOps } from "@synap-core/types/proposals";
import { readCriteria, type SessionCriterion } from "@synap/playbooks";
import { notTakenRecorded } from "../focus-sessions/session-closed-as.js";
import type { CapturePlanInput } from "../capture-agent/submit-capture-graph.js";
import { loopProposalCounts } from "./goal-loop.js";

const logger = createLogger({ module: "pathway-replan" });

/** The machine author of every revision this loop files (`proposals.created_by`). */
export const PATHWAY_REPLAN_AUTHOR = "system:pathway-replan" as const;

/** The work kind that makes a goal a pathway (P6). */
const PATHWAY_WORK_KIND = "pathway" as const;

/** The plan ref of the retry of a step — how a later read finds its lineage. */
const RETRY_REF_PREFIX = "retry-";
export function retryRefOf(stepId: string): string {
  return `${RETRY_REF_PREFIX}${stepId}`;
}

export type PathwayReplanResult =
  | { status: "proposed"; proposalId: string; replanFor: string[] }
  | { status: "held"; hold: PathwayReplanHold; stoppedOn?: string[] }
  | { status: "not_found" };

/** The name of a retry step — what the review shows. */
export function retryStepTitle(stepTitle: string): string {
  const title = `Retry: ${stepTitle.trim()}`;
  return title.length > SESSION_TITLE_MAX
    ? `${title.slice(0, SESSION_TITLE_MAX - 1)}…`
    : title;
}

/**
 * The step's REQUIRED criteria, as its retry carries them: the same keys and
 * checks; no stage (the retry runs no playbook stage) and no output (the
 * retry declares none).
 */
export function retryCriteria(
  criteria: readonly SessionCriterion[]
): SessionCriterion[] {
  return criteria
    .filter((c) => c.required !== false)
    .map(({ stageKey: _stage, outputKey: _output, ...c }) => c);
}

/** One ended step as the revision re-plans it. */
export interface ReplanStep {
  id: string;
  title: string;
  goal: string;
  criteria: SessionCriterion[];
  parentSessionId: string | null;
  /** Open steps of the same owner that wait on it (`blocked_by`). */
  dependents: string[];
}

/**
 * THE revision, pure: per ended step a retry in the goal, and each open
 * dependent moved from the step onto its retry. Nothing else.
 */
export function pathwayRevisionPlan(input: {
  goalId: string;
  steps: readonly ReplanStep[];
}): CapturePlanInput {
  const sessions: NonNullable<CapturePlanInput["sessions"]> = [];
  const links: NonNullable<CapturePlanInput["links"]> = [];
  const edits: NonNullable<CapturePlanInput["edits"]> = [];
  for (const step of input.steps) {
    const ref = retryRefOf(step.id);
    const criteria = retryCriteria(step.criteria);
    sessions.push({
      ref,
      title: retryStepTitle(step.title),
      goal: step.goal,
      trackId: input.goalId,
      ...(step.parentSessionId
        ? { parentSessionId: step.parentSessionId }
        : {}),
      ...(criteria.length > 0
        ? { criteria: criteria as unknown as Array<Record<string, unknown>> }
        : {}),
    });
    for (const dependent of step.dependents) {
      edits.push({
        op: "remove_link",
        type: "blocked_by",
        fromSessionId: dependent,
        toSessionId: step.id,
      });
      links.push({ type: "blocked_by", fromSessionId: dependent, toRef: ref });
    }
  }
  return {
    sessions,
    ...(links.length > 0 ? { links } : {}),
    ...(edits.length > 0 ? { edits } : {}),
  };
}

/** What the person reads on the review: what ended, and what the revision does. */
export function pathwayRevisionSummary(
  goalName: string,
  steps: readonly Pick<ReplanStep, "title" | "dependents">[]
): string {
  const names = steps.map((s) => `"${s.title}"`).join(", ");
  const waiting = steps.reduce((n, s) => n + s.dependents.length, 0);
  const one = steps.length === 1;
  return [
    `Re-plan the pathway "${goalName.trim()}": ${names} ended without delivering.`,
    `Retry ${one ? "it" : "each"} as a new step`,
    waiting > 0
      ? `and move the ${waiting} step${waiting === 1 ? "" : "s"} waiting on ${one ? "it" : "them"} onto the retry.`
      : "(no step waits on it).",
  ].join(" ");
}

/** The steps the loop's revisions named, and the retries they created. */
async function loopHistory(goalId: string): Promise<{
  named: Set<string>;
  retryOf: Map<string, string>;
}> {
  const rows = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.createdBy, PATHWAY_REPLAN_AUTHOR),
        drizzleSql`${proposals.data}->>'replanOf' = ${goalId}`
      )
    );
  const named = new Set<string>();
  const retryOf = new Map<string, string>();
  for (const row of rows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const replanFor = Array.isArray(data.replanFor) ? data.replanFor : [];
    for (const id of replanFor) if (typeof id === "string") named.add(id);
    for (const op of readMaterializedOps(data.materialized)) {
      if (op.op === "create_session" && op.ref.startsWith(RETRY_REF_PREFIX)) {
        retryOf.set(op.id, op.ref.slice(RETRY_REF_PREFIX.length));
      }
    }
  }
  return { named, retryOf };
}

/**
 * The loop, for one goal: decide, then file ONE revision or hold. Acts as
 * the pod (no caller). Never throws for a hold; a failed read or a refused
 * filing throws.
 */
export async function runPathwayReplan(
  goalId: string
): Promise<PathwayReplanResult> {
  const [row] = await db
    .select({ track: projectTracks, workspaceId: projects.workspaceId })
    .from(projectTracks)
    .innerJoin(projects, eq(projects.id, projectTracks.projectId))
    .where(eq(projectTracks.id, goalId))
    .limit(1);
  if (!row) return { status: "not_found" };
  const track = row.track as ProjectTrack;
  // The cheap holds first: no step read for a goal that is no pathway.
  if (track.workKind !== PATHWAY_WORK_KIND) {
    return { status: "held", hold: "not_pathway" };
  }
  const category = trackStatusCategory(track.status);
  if (category !== "active") return { status: "held", hold: "not_active" };

  // Ends of the window: THE derivation says how each ended.
  const endedRows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      userId: focusSessions.userId,
      criteria: focusSessions.criteria,
      verificationReport: focusSessions.verificationReport,
      closedAt: focusSessions.closedAt,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.trackId, track.id),
        inArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES]),
        drizzleSql`coalesce(${focusSessions.closedAt}, ${focusSessions.updatedAt}) > now() - (${GOAL_LOOP_WINDOW_DAYS}::int * interval '1 day')`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: the pod's own loop over one goal's steps.
    .orderBy(focusSessions.closedAt, focusSessions.id);
  const unexpected = endedRows.filter((s) => {
    if (notTakenRecorded(s)) return false;
    const report = (s.verificationReport ?? null) as Record<
      string,
      unknown
    > | null;
    const closedNotDone =
      !!report &&
      typeof report.closedNotDone === "object" &&
      report.closedNotDone !== null;
    return sessionClosedAs(s.status, closedNotDone) === "not_done";
  });

  const ids = unexpected.map((s) => s.id);
  const [history, replaced] = await Promise.all([
    loopHistory(track.id),
    ids.length > 0
      ? db
          .select({ id: links.toId })
          .from(links)
          .where(
            and(
              // Literal on purpose: `links-type-ssot` reads typed readers.
              eq(links.linkType, "replaces"),
              eq(links.toType, "session"),
              inArray(links.toId, ids)
            )
          )
      : Promise.resolve([]),
  ]);
  const replacedIds = new Set(replaced.map((r) => r.id));
  const ended: PathwayEndedStep[] = unexpected.map((s) => ({
    sessionId: s.id,
    // A person who linked the attempt instead already re-planned it.
    covered: history.named.has(s.id) || replacedIds.has(s.id),
    retryOf: history.retryOf.get(s.id) ?? null,
  }));

  const counts = await loopProposalCounts({
    author: PATHWAY_REPLAN_AUTHOR,
    goalId: track.id,
    loopOf: drizzleSql`${proposals.data}->>'replanOf'`,
  });
  const decision = decidePathwayReplan({
    isPathway: true,
    category,
    ended,
    pendingProposals: counts.pending,
    proposedThisWeek: counts.recent,
    perWeek: readGoalLoop(track.loop).perWeek,
  });
  if (!decision.propose) {
    if (decision.hold === "stopped") {
      logger.info(
        { goalId: track.id, stoppedOn: decision.stoppedOn },
        "pathway re-plan stopped: a retry it proposed ended without delivering too"
      );
    }
    return {
      status: "held",
      hold: decision.hold,
      ...(decision.stoppedOn ? { stoppedOn: decision.stoppedOn } : {}),
    };
  }

  // ONE plan has ONE owner (the plan door floors every step edit on it): the
  // first step's; another owner's steps wait for the next revision.
  const byId = new Map(unexpected.map((s) => [s.id, s]));
  const chosen = decision.replan.map((id) => byId.get(id)!);
  const owner = chosen[0]!.userId;
  const own = chosen.filter((s) => s.userId === owner);
  const ownIds = own.map((s) => s.id);

  const [edgeRows, parents] = await Promise.all([
    db
      .select({ fromId: links.fromId, toId: links.toId })
      .from(links)
      .where(
        and(
          eq(links.linkType, "blocked_by"),
          eq(links.fromType, "session"),
          eq(links.toType, "session"),
          inArray(links.toId, ownIds)
        )
      ),
    getParentSessionIds(ownIds),
  ]);
  const dependentIds = [...new Set(edgeRows.map((e) => e.fromId))];
  const dependentRows =
    dependentIds.length > 0
      ? await db
          .select({
            id: focusSessions.id,
            status: focusSessions.status,
            userId: focusSessions.userId,
          })
          .from(focusSessions)
          .where(inArray(focusSessions.id, dependentIds))
      : [];
  const waiting = new Set(
    dependentRows
      .filter(
        (d) => d.userId === owner && !isDependencyEnded("session", d.status)
      )
      .map((d) => d.id)
  );
  const steps: ReplanStep[] = own.map((s) => ({
    id: s.id,
    title: resolveSessionTitle(s),
    goal: s.goal,
    criteria: readCriteria(s.criteria),
    parentSessionId: parents.get(s.id) ?? null,
    dependents: edgeRows
      .filter((e) => e.toId === s.id && waiting.has(e.fromId))
      .map((e) => e.fromId),
  }));

  const { submitCaptureGraph } =
    await import("../capture-agent/submit-capture-graph.js");
  const filed = await submitCaptureGraph({
    userId: owner,
    workspaceId: row.workspaceId ?? null,
    projectId: track.projectId,
    entities: [],
    plan: pathwayRevisionPlan({ goalId: track.id, steps }),
    summary: pathwayRevisionSummary(track.name, steps),
    filedByPod: {
      author: PATHWAY_REPLAN_AUTHOR,
      data: { replanOf: track.id, replanFor: ownIds },
    },
  });
  if (!filed.proposalId || filed.applied) {
    // The loop must leave a revision for a person; anything else breaks its
    // one promise. Loud, never silent.
    throw new Error(
      `The pathway re-plan must file a revision for review, but the capture door answered ${filed.applied ? "applied" : "no proposal"}.`
    );
  }
  // The audit line of the filing (beside the proposal's own event).
  logger.info(
    { goalId: track.id, proposalId: filed.proposalId, replanFor: ownIds },
    "pathway re-plan filed a revision"
  );
  return {
    status: "proposed",
    proposalId: filed.proposalId,
    replanFor: ownIds,
  };
}

/**
 * The hourly net (the goal loop's tick, `sweepGoalLoops`): every ACTIVE
 * pathway goal, paged by id. One goal's failure never stops the others.
 */
export async function sweepPathwayReplans(
  opts: { pageSize?: number } = {}
): Promise<{ checked: number; proposed: number; failed: number }> {
  let checked = 0;
  let proposed = 0;
  let failed = 0;
  const pageSize = opts.pageSize ?? 200;
  let after: string | null = null;
  for (;;) {
    const page: Array<{ id: string }> = await db
      .select({ id: projectTracks.id })
      .from(projectTracks)
      .where(
        and(
          eq(projectTracks.status, "active"),
          eq(projectTracks.workKind, PATHWAY_WORK_KIND),
          after ? gt(projectTracks.id, after) : undefined
        )
      )
      .orderBy(projectTracks.id)
      .limit(pageSize);
    for (const g of page) {
      try {
        const r = await runPathwayReplan(g.id);
        if (r.status === "proposed") proposed++;
      } catch (err) {
        failed++;
        logger.error(
          { err, goalId: g.id },
          "pathway re-plan sweep: one goal failed"
        );
      }
    }
    checked += page.length;
    if (page.length < pageSize) break;
    after = page[page.length - 1]!.id;
  }
  return { checked, proposed, failed };
}
