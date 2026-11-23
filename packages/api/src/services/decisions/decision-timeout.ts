/**
 * THE TIMEOUT ARM of a decision (founder decision P5; lead default C,
 * 23 Nov 2026): a `proposed` decision may carry `answerBy` (when it is due)
 * and `defaultOption` (the option key, `value ?? label`, taken if nobody
 * answers). Past `answerBy`, the hourly lifecycle sweep
 * ({@link sweepDecisionTimeouts}):
 *
 *   · APPLIES the default only when the PERSON set it: the decision is
 *     accepted with that option through THE decision door
 *     (`updateDecisionEntity`, as the owner, like an answer), with a
 *     rationale line, a `systemData.decidedByTimeout` record, and one notice
 *     (`decision.decided_by_timeout`). Accepting it is what settles its arms
 *     (`decision-arms.ts`, through the unblock reactor);
 *   · otherwise only REMINDS: an agent's default, no default, or a default
 *     the decision does not list never decides for the person. One notice
 *     per due date (`decision.overdue`), "N steps wait".
 *
 * WHO SET THE DEFAULT is the pod's fact, never the caller's: the decision-ask
 * reactor stamps `systemData.defaultOptionBy` ({@link stampDefaultOptionAuthor})
 * from the write's own `events` row (`agent_user_id` / `is_agent`). No entity
 * door writes `systemData`. A missing or unreadable stamp, or one for another
 * value, reads as NOT the person's: it reminds, never decides (fail closed).
 */
import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  isNull,
  notInArray,
  drizzleSql,
  entities,
  events,
  focusSessions,
  links,
  profileSlugScopeCondition,
} from "@synap/database";
import { decisionRecordView } from "@synap-core/types/ask";
import { DEPENDENCY_LINK_TYPE } from "@synap-core/types/connections";
import { TERMINAL_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { NotificationService } from "../../notifications/NotificationService.js";
import { updateDecisionEntity } from "./decision-entity-door.js";
// Read at call time only: the reactor imports this module back.
import { DECISION_PROFILE_SLUG } from "./decision-ask-reactor.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

const logger = createLogger({ module: "decision-timeout" });

/** `systemData` key: who set the current `defaultOption`. */
export const DEFAULT_OPTION_BY_KEY = "defaultOptionBy" as const;
/** `systemData` key: the decision was accepted by its timeout. */
export const DECIDED_BY_TIMEOUT_KEY = "decidedByTimeout" as const;
/** `systemData` key: the due date the overdue notice was sent for. */
const OVERDUE_NOTIFIED_KEY = "overdueNotifiedFor" as const;

// `type:` keys so the registry's source-scan producer check sees them.
const DECIDED = { type: "decision.decided_by_timeout" } as const;
const OVERDUE = { type: "decision.overdue" } as const;
export const DECIDED_BY_TIMEOUT_NOTIFICATION_TYPE = DECIDED.type;
export const DECISION_OVERDUE_NOTIFICATION_TYPE = OVERDUE.type;

/** Most decisions the sweep settles per tick. */
export const DECISION_TIMEOUT_SWEEP_LIMIT = 200;

export interface DefaultOptionAuthor {
  /** The `defaultOption` value this stamp attests. */
  option: string;
  kind: "person" | "agent" | "unknown";
  userId: string | null;
  at: string;
}

export type DecisionTimeoutPlan =
  | { action: "wait" }
  | { action: "apply"; option: string }
  | {
      action: "remind";
      reason: "no_default" | "agent_default" | "unknown_option";
    };

/**
 * What the timeout does to ONE decision now. Pure. Only a `proposed`
 * decision past a valid `answerBy` acts; it applies only a default the
 * person set (the stamp attests THIS value) that the decision lists.
 */
export function planDecisionTimeout(input: {
  status: string | null;
  answerBy: unknown;
  defaultOption: unknown;
  defaultOptionBy: unknown;
  optionKeys: readonly string[];
  now: Date;
}): DecisionTimeoutPlan {
  if (input.status !== "proposed") return { action: "wait" };
  const due =
    typeof input.answerBy === "string" ? Date.parse(input.answerBy) : NaN;
  if (Number.isNaN(due) || due > input.now.getTime()) return { action: "wait" };
  const option =
    typeof input.defaultOption === "string" && input.defaultOption.trim()
      ? input.defaultOption
      : null;
  if (!option) return { action: "remind", reason: "no_default" };
  if (!input.optionKeys.includes(option)) {
    return { action: "remind", reason: "unknown_option" };
  }
  const by = input.defaultOptionBy as Partial<DefaultOptionAuthor> | null;
  return by && by.kind === "person" && by.option === option
    ? { action: "apply", option }
    : { action: "remind", reason: "agent_default" };
}

/** The author kind an `events` row names: an agent identity = an agent. */
export function authorKindOfEvent(
  row: { agentUserId: string | null; isAgent: boolean | null } | undefined
): DefaultOptionAuthor["kind"] {
  if (!row) return "unknown";
  return row.agentUserId || row.isAgent ? "agent" : "person";
}

/**
 * Stamp who set a decision's `defaultOption`, from the write's own `events`
 * row (`eventId`, the emit's audit record). Called by the decision-ask
 * reactor on a create, or an update that changed `defaultOption`. A cleared
 * default drops the stamp. Either way the "already reminded" mark goes: a
 * new default is looked at again on the next tick. Never throws.
 */
export async function stampDefaultOptionAuthor(
  decisionId: string,
  eventId: string | null | undefined
): Promise<void> {
  try {
    const [row] = await db
      .select({ type: entities.type, properties: entities.properties })
      .from(entities)
      .where(eq(entities.id, decisionId))
      .limit(1);
    if (!row || row.type !== DECISION_PROFILE_SLUG) return;
    const value = (row.properties as Record<string, unknown> | null)
      ?.defaultOption;
    if (typeof value !== "string" || !value.trim()) {
      await db
        .update(entities)
        .set({
          systemData: drizzleSql`${entities.systemData} - ${DEFAULT_OPTION_BY_KEY}::text - ${OVERDUE_NOTIFIED_KEY}::text`,
        })
        .where(eq(entities.id, decisionId));
      return;
    }
    const [event] = eventId
      ? await db
          .select({
            agentUserId: events.agentUserId,
            isAgent: events.isAgent,
            userId: events.userId,
          })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1)
      : [];
    const stamp: DefaultOptionAuthor = {
      option: value,
      kind: authorKindOfEvent(event),
      userId: event?.agentUserId ?? event?.userId ?? null,
      at: new Date().toISOString(),
    };
    await db
      .update(entities)
      .set({
        systemData: drizzleSql`(coalesce(${entities.systemData}, '{}'::jsonb) - ${OVERDUE_NOTIFIED_KEY}::text) || jsonb_build_object(${DEFAULT_OPTION_BY_KEY}::text, ${JSON.stringify(stamp)}::jsonb)`,
      })
      .where(eq(entities.id, decisionId));
  } catch (err) {
    logger.error(
      { err, decisionId },
      "stamping who set a decision's default failed — its timeout only reminds"
    );
  }
}

/**
 * The hourly net: every `proposed` decision whose `answerBy` passed, read
 * owner by owner through the kind door, each owner's oldest due first; one
 * already reminded for this due date is left out (so the batch never fills
 * with the same ones). Returns how many it decided.
 */
export async function sweepDecisionTimeouts(
  now: Date = new Date()
): Promise<number> {
  // ISO dates compare as text; the exact instant is checked by the plan.
  const horizon = new Date(now.getTime() + 24 * 3600_000).toISOString();
  const due = and(
    isNull(entities.deletedAt),
    drizzleSql`coalesce(${entities.status}, ${entities.properties} ->> 'decisionStatus') = 'proposed'`,
    drizzleSql`${entities.properties} ->> 'answerBy' < ${horizon}`,
    drizzleSql`(${entities.systemData} ->> ${OVERDUE_NOTIFIED_KEY}) is distinct from (${entities.properties} ->> 'answerBy')`
  );
  // The owners with something due, then each owner's decisions through THE
  // kind door (`profileSlugScopeCondition`, under that owner's facet scope).
  const owners = await db
    .selectDistinct({ userId: entities.userId })
    .from(entities)
    .where(due);
  const rows: DecisionRow[] = [];
  for (const { userId } of owners) {
    if (rows.length >= DECISION_TIMEOUT_SWEEP_LIMIT) break;
    const isDecision = await profileSlugScopeCondition(
      db,
      DECISION_PROFILE_SLUG,
      await resolveFacetVisibilityScope(userId, undefined)
    );
    rows.push(
      ...(await db
        .select({
          id: entities.id,
          userId: entities.userId,
          workspaceId: entities.workspaceId,
          title: entities.title,
          status: entities.status,
          properties: entities.properties,
          systemData: entities.systemData,
        })
        .from(entities)
        .where(and(eq(entities.userId, userId), isDecision, due))
        .orderBy(drizzleSql`${entities.properties} ->> 'answerBy' asc`)
        .limit(DECISION_TIMEOUT_SWEEP_LIMIT - rows.length))
    );
  }

  let decided = 0;
  for (const row of rows) {
    try {
      if (await settleDecisionTimeout(row, now)) decided++;
    } catch (err) {
      logger.error(
        { err, decisionId: row.id },
        "decision timeout failed — next tick"
      );
    }
  }
  return decided;
}

type DecisionRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  status: string | null;
  properties: unknown;
  systemData: unknown;
};

async function settleDecisionTimeout(
  row: DecisionRow,
  now: Date
): Promise<boolean> {
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const system = (row.systemData ?? {}) as Record<string, unknown>;
  const view = decisionRecordView(props);
  const plan = planDecisionTimeout({
    status:
      row.status ??
      (typeof props.decisionStatus === "string" ? props.decisionStatus : null),
    answerBy: props.answerBy,
    defaultOption: props.defaultOption,
    defaultOptionBy: system[DEFAULT_OPTION_BY_KEY],
    optionKeys: view.options.map((o) => o.key),
    now,
  });
  if (plan.action === "wait") return false;
  const title = row.title ?? "A decision";
  const waiting = await countWaitingSteps(row.id);

  if (plan.action === "apply") {
    const label =
      view.options.find((o) => o.key === plan.option)?.label ?? plan.option;
    const before =
      typeof props.rationale === "string" ? props.rationale.trim() : "";
    await updateDecisionEntity(
      { userId: row.userId, workspaceId: row.workspaceId },
      row.id,
      {
        decisionStatus: "accepted",
        chosenOption: plan.option,
        decidedAt: now.toISOString(),
        rationale: [
          before,
          `Decided by timeout: no answer by ${String(props.answerBy)}, so the default you set ("${label}") applied.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      }
    );
    await mergeSystemData(row.id, {
      [DECIDED_BY_TIMEOUT_KEY]: {
        option: plan.option,
        answerBy: props.answerBy,
        at: now.toISOString(),
      },
    });
    await notify(DECIDED.type, row, {
      decisionId: row.id,
      decisionTitle: title,
      chosenOption: label,
      waitingSteps: waiting,
    });
    return true;
  }

  await notify(OVERDUE.type, row, {
    decisionId: row.id,
    decisionTitle: title,
    waitingSteps: waiting,
    answerBy: String(props.answerBy),
  });
  await mergeSystemData(row.id, { [OVERDUE_NOTIFIED_KEY]: props.answerBy });
  return false;
}

/** Open steps that wait on the decision (any `blocked_by`, arm or not). */
async function countWaitingSteps(decisionId: string): Promise<number> {
  const [r] = await db
    .select({ n: drizzleSql<number>`count(distinct ${links.fromId})::int` })
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
        eq(links.toId, decisionId),
        // SESSION-KIND-LENS-EXEMPT: the pod's own count of steps waiting.
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    );
  return r?.n ?? 0;
}

async function mergeSystemData(
  id: string,
  patch: Record<string, unknown>
): Promise<void> {
  await db
    .update(entities)
    .set({
      systemData: drizzleSql`coalesce(${entities.systemData}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(entities.id, id));
}

async function notify(
  type: typeof DECIDED.type | typeof OVERDUE.type,
  row: DecisionRow,
  data: Record<string, unknown>
): Promise<void> {
  await NotificationService.create({
    type,
    userId: row.userId,
    workspaceId: row.workspaceId,
    sourceType: "system",
    sourceId: row.id,
    groupKey: `${type}:${row.id}:${String((row.properties as Record<string, unknown> | null)?.answerBy ?? "")}`,
    data,
  });
}
