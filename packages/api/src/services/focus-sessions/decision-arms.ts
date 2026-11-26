/**
 * DECISION ARMS (founder decision P5, 21 Nov 2026) — "every branch is a
 * decision". A step that is ONE arm of a decision waits on it with
 * `step --blocked_by--> decision` naming the option in
 * `links.metadata.option` (`@synap-core/types/connections`,
 * `DECISION_ARM_OPTION_KEY`). This applies what an ACCEPTED decision means
 * for its arms, by the pure plan `planDecisionArms`:
 *
 *   · the arm that names the chosen option is TAKEN: nothing to do here, the
 *     dependency rule already reads its edge as delivered, and the unblock
 *     reactor tells (and wakes) it;
 *   · every other arm is SKIPPED: closed `cancelled` through THE close door
 *     (`completeFocusSession`) as the system, with a `notTaken` record
 *     (`verification_report.notTaken`) and one audit line (the cancel
 *     reason). The dependency rule reads that record as `skipped`: the step
 *     holds none of its own dependents, so a step that joins two exclusive
 *     arms waits only on the arm taken;
 *   · NO arm names the choice (or nothing was chosen): nothing is skipped,
 *     every arm holds (`notTaken` blockers read `blocked`), and the owner is
 *     told once, `session.arm_unmatched` — never a silent green.
 *
 * A REJECTED decision is not handled here: every arm holds as a dropped
 * blocker until its owner re-plans (the dependency rule), never skipped.
 *
 * WHEN: the unblock reactor, the moment a decision is accepted
 * (`session-unblock-reactor.ts`), and the hourly lifecycle sweep as the net
 * (`sweepDecisionArms`). Both are idempotent: the close door returns an
 * ended step as it stands (compare-and-set on "not ended"), and the notice
 * is deduplicated on its group key.
 *
 * What it does NOT follow: an arm edge to a decision that REPLACED another
 * (`replaces`): the arm names the decision it was written on.
 */
import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  notInArray,
  drizzleSql,
  entities,
  focusSessions,
  isLifecycleCategory,
  links,
  notifications,
} from "@synap/database";
import {
  DECISION_ARM_OPTION_KEY,
  DEPENDENCY_LINK_TYPE,
  armOptionOf,
  classifyDependencyBlocker,
  isDependencyEnded,
  planDecisionArms,
} from "@synap-core/types/connections";
import {
  TERMINAL_SESSION_STATUSES,
  resolveSessionTitle,
} from "@synap-core/types/focus-sessions";
import { NotificationService } from "../../notifications/NotificationService.js";
import { completeFocusSession } from "./complete-session.js";
import type { NotTakenRecord } from "./session-closed-as.js";

const logger = createLogger({ module: "decision-arms" });

/**
 * The registry type for "no step waits on this choice" — under a lowercase
 * `notificationType:` key so the source-scan producer allowlist sees it.
 */
const notificationType = "session.arm_unmatched" as const;
export const ARM_UNMATCHED_NOTIFICATION_TYPE = notificationType;

/** `(decision, chosen option)` — one notice per owner for one choice. */
export function armUnmatchedGroupKey(
  decisionId: string,
  chosenOption: string | null
): string {
  return `${ARM_UNMATCHED_NOTIFICATION_TYPE}:${decisionId}:${chosenOption ?? ""}`;
}

/** Most decisions the sweep settles per tick. */
export const DECISION_ARMS_SWEEP_LIMIT = 200;

export interface DecisionArmsOutcome {
  /** Arm steps closed as skipped now. */
  skipped: string[];
  /** No arm named the choice: the owners were told (or already were). */
  unmatched: boolean;
}

const NOTHING: DecisionArmsOutcome = { skipped: [], unmatched: false };

/**
 * Apply an accepted decision to its arms (see the header). Reads the ROW,
 * never an event payload: a decision not accepted now changes nothing. A
 * failed read throws (the caller logs it); one step's failed skip is logged
 * and the others go on.
 */
export async function resolveDecisionArms(
  decisionId: string
): Promise<DecisionArmsOutcome> {
  const [decision] = await db
    .select({
      id: entities.id,
      title: entities.title,
      status: entities.status,
      statusCategory: entities.statusCategory,
      properties: entities.properties,
      deletedAt: entities.deletedAt,
    })
    .from(entities)
    .where(eq(entities.id, decisionId))
    .limit(1);
  if (!decision || decision.deletedAt) return NOTHING;
  const category = isLifecycleCategory(decision.statusCategory)
    ? decision.statusCategory
    : null;
  if (
    classifyDependencyBlocker("entity", decision.status, category) !==
    "delivered"
  ) {
    return NOTHING;
  }
  const chosenRaw = (decision.properties as Record<string, unknown> | null)
    ?.chosenOption;
  const chosen = typeof chosenRaw === "string" ? chosenRaw : null;

  const armRows = await db
    .select({
      stepId: links.fromId,
      metadata: links.metadata,
      status: focusSessions.status,
      userId: focusSessions.userId,
      workspaceId: focusSessions.workspaceId,
      title: focusSessions.title,
      goal: focusSessions.goal,
    })
    .from(links)
    .innerJoin(
      focusSessions,
      eq(drizzleSql`${focusSessions.id}::text`, links.fromId)
    )
    .where(
      and(
        eq(links.linkType, DEPENDENCY_LINK_TYPE),
        eq(links.fromType, "session"),
        eq(links.toType, "entity"),
        eq(links.toId, decision.id),
        drizzleSql`${links.metadata} ->> ${DECISION_ARM_OPTION_KEY} IS NOT NULL`
      )
    );
  const arms = armRows.flatMap((r) => {
    const option = armOptionOf(r.metadata);
    return option ? [{ ...r, option }] : [];
  });
  if (arms.length === 0) return NOTHING;

  const plan = planDecisionArms(chosen, arms);
  const decisionTitle = decision.title ?? "A decision";

  if (plan.unmatched) {
    // Tell each owner of a still-open arm once; ended arms need nobody.
    const open = arms.filter((a) => !isDependencyEnded("session", a.status));
    const byOwner = new Map<string, (typeof open)[number]>();
    for (const a of open) if (!byOwner.has(a.userId)) byOwner.set(a.userId, a);
    for (const step of byOwner.values()) {
      await notifyUnmatched({
        decisionId: decision.id,
        decisionTitle,
        chosen,
        step,
      });
    }
    return { skipped: [], unmatched: true };
  }

  const skipped: string[] = [];
  const stepsById = new Map(arms.map((a) => [a.stepId, a]));
  for (const stepId of plan.skip) {
    const step = stepsById.get(stepId);
    if (!step || isDependencyEnded("session", step.status)) continue;
    const record: NotTakenRecord = {
      decisionId: decision.id,
      option: step.option,
      chosenOption: chosen!,
      at: new Date().toISOString(),
    };
    try {
      const closed = await completeFocusSession({
        sessionId: step.stepId,
        userId: step.userId,
        terminalStatus: "cancelled",
        cancelReason: `Not taken: "${decisionTitle}" chose "${chosen}", this step was the "${step.option}" branch.`,
        summary: `Skipped: the decision chose "${chosen}".`,
        actor: { kind: "system", userId: step.userId },
        notTaken: record,
      });
      if (closed) skipped.push(step.stepId);
    } catch (err) {
      logger.error(
        { err, sessionId: step.stepId, decisionId: decision.id },
        "skipping a branch not taken failed — the sweep retries it"
      );
    }
  }
  return { skipped, unmatched: false };
}

async function notifyUnmatched(input: {
  decisionId: string;
  decisionTitle: string;
  chosen: string | null;
  step: {
    stepId: string;
    userId: string;
    workspaceId: string | null;
    title: string | null;
    goal: string | null;
  };
}): Promise<void> {
  const { step } = input;
  const groupKey = armUnmatchedGroupKey(input.decisionId, input.chosen);
  try {
    const [already] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, step.userId),
          eq(notifications.type, ARM_UNMATCHED_NOTIFICATION_TYPE),
          eq(notifications.groupKey, groupKey)
        )
      )
      .limit(1);
    if (already) return;
    await NotificationService.create({
      type: ARM_UNMATCHED_NOTIFICATION_TYPE,
      userId: step.userId,
      workspaceId: step.workspaceId,
      sourceType: "system",
      sourceId: step.stepId,
      groupKey,
      data: {
        sessionId: step.stepId,
        sessionTitle: resolveSessionTitle(step),
        decisionId: input.decisionId,
        decisionTitle: input.decisionTitle,
        chosenOption: input.chosen ?? "nothing",
      },
    });
  } catch (err) {
    logger.error(
      { err, decisionId: input.decisionId, sessionId: step.stepId },
      "telling the owner that no branch matches the choice failed"
    );
  }
}

/**
 * The hourly net: every accepted decision that an OPEN step still waits on
 * as an arm, through {@link resolveDecisionArms}, OLDEST decided first (its
 * row's `updatedAt`): a decision that stays unmatched never starves a newer
 * one out of the batch for good. Returns how many steps it skipped; a
 * decision that fails is logged and the sweep goes on.
 */
export async function sweepDecisionArms(): Promise<number> {
  const rows = await db
    .select({ decisionId: links.toId })
    .from(links)
    .innerJoin(
      focusSessions,
      eq(drizzleSql`${focusSessions.id}::text`, links.fromId)
    )
    .innerJoin(entities, eq(drizzleSql`${entities.id}::text`, links.toId))
    .where(
      and(
        eq(links.linkType, DEPENDENCY_LINK_TYPE),
        eq(links.fromType, "session"),
        eq(links.toType, "entity"),
        drizzleSql`${links.metadata} ->> ${DECISION_ARM_OPTION_KEY} IS NOT NULL`,
        // SESSION-KIND-LENS-EXEMPT: the pod's own sweep over every arm step.
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES]),
        eq(entities.statusCategory, "done")
      )
    )
    .groupBy(links.toId)
    .orderBy(drizzleSql`min(${entities.updatedAt}) asc`)
    .limit(DECISION_ARMS_SWEEP_LIMIT);
  let skipped = 0;
  for (const { decisionId } of rows) {
    try {
      skipped += (await resolveDecisionArms(decisionId)).skipped.length;
    } catch (err) {
      logger.error({ err, decisionId }, "decision arms failed — next tick");
    }
  }
  return skipped;
}
