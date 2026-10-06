/**
 * Per-automation AI dispatch footprint — the `run` arm of `diagnose`.
 *
 * Answers the question the 2026-10 incident could not: "which rule is starting
 * AI work, how much, and is that work failing?" A parent run used to read
 * `completed` while every playbook run it started failed, so its own counters
 * hid the failures; these numbers come from the CHILDREN.
 *
 *   aiDispatches24h — `automation_runs.ai_dispatch_count` summed over 24h, next
 *                     to the rule's daily cap (`maxAiDispatchesPerDay`);
 *   childRuns7d / childFailed7d — playbook runs whose session names one of the
 *                     rule's runs (`metadata.automationRunId`, indexed by 0303).
 *
 * Only automations with a run in the last 7 days are listed. Visibility is the
 * automations table's own floor (`userVisibleWhere`).
 */
import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  automations,
  automationRuns,
  playbookRuns,
  focusSessions,
} from "@synap/database";
import {
  AI_DISPATCH_GUARDRAILS,
  readMaxAiDispatchesPerDay,
} from "@synap-core/types/automations";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

export interface AutomationDispatchFootprint {
  automationId: string;
  name: string;
  status: string;
  aiDispatches24h: number;
  /** The rule's daily cap (its `triggerConfig` override, else the default). */
  aiDispatchCapPerDay: number;
  childRuns7d: number;
  childFailed7d: number;
}

export async function automationDispatchFootprints(input: {
  userId: string;
  workspaceId?: string;
}): Promise<AutomationDispatchFootprint[]> {
  const visible = await db
    .select({
      id: automations.id,
      name: automations.name,
      status: automations.status,
      triggerConfig: automations.triggerConfig,
    })
    .from(automations)
    .where(
      and(
        userVisibleWhere(automations.workspaceId, input.userId),
        input.workspaceId
          ? eq(automations.workspaceId, input.workspaceId)
          : undefined
      )
    );
  if (visible.length === 0) return [];
  const ids = visible.map((a) => a.id);

  const dispatchRows = await db
    .select({
      automationId: automationRuns.automationId,
      ai24h: drizzleSql<number>`COALESCE(SUM(${automationRuns.aiDispatchCount}) FILTER (WHERE ${automationRuns.startedAt} > now() - interval '24 hours'), 0)::int`,
    })
    .from(automationRuns)
    .where(
      and(
        inArray(automationRuns.automationId, ids),
        drizzleSql`${automationRuns.startedAt} > now() - interval '7 days'`
      )
    )
    .groupBy(automationRuns.automationId);

  const childRows = await db
    .select({
      automationId: automationRuns.automationId,
      total: drizzleSql<number>`COUNT(${playbookRuns.id})::int`,
      failed: drizzleSql<number>`COUNT(${playbookRuns.id}) FILTER (WHERE ${playbookRuns.status} = 'failed')::int`,
    })
    .from(automationRuns)
    .innerJoin(
      focusSessions,
      drizzleSql`${focusSessions.metadata}->>'automationRunId' = ${automationRuns.id}::text`
    )
    .innerJoin(playbookRuns, eq(playbookRuns.sessionId, focusSessions.id))
    .where(
      and(
        inArray(automationRuns.automationId, ids),
        drizzleSql`${automationRuns.startedAt} > now() - interval '7 days'`
      )
    )
    .groupBy(automationRuns.automationId);

  const dispatch = new Map(dispatchRows.map((r) => [r.automationId, r]));
  const child = new Map(childRows.map((r) => [r.automationId, r]));

  return visible
    .filter((a) => dispatch.has(a.id))
    .map((a) => {
      const cap = readMaxAiDispatchesPerDay(a.triggerConfig);
      return {
        automationId: a.id,
        name: a.name,
        status: a.status,
        aiDispatches24h: Number(dispatch.get(a.id)?.ai24h ?? 0),
        // A malformed stored cap is ignored by the executor, which then
        // enforces the default — report what is actually enforced.
        aiDispatchCapPerDay: cap.ok
          ? cap.value
          : AI_DISPATCH_GUARDRAILS.maxAiDispatchesPerDayDefault,
        childRuns7d: Number(child.get(a.id)?.total ?? 0),
        childFailed7d: Number(child.get(a.id)?.failed ?? 0),
      };
    })
    .sort(
      (x, y) =>
        y.childFailed7d - x.childFailed7d ||
        y.aiDispatches24h - x.aiDispatches24h
    );
}
