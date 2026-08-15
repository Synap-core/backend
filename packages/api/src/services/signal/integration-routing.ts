/**
 * Integration routing rules — "which automations are bound to THIS integration
 * instance's channels" (the Integration dashboard's Analyzers facet).
 *
 * An "Integration" = a standing-mode capability composition, identified by
 * `capabilityId`. Its channels are resolved via the SAME canonical door every
 * other capability-lens read uses: `resolveCapabilityChannelIds` (this
 * package's `signal/index.ts`) — produced-edge channels ∪ legacy
 * externalSource-slug channels, floored by `channelVisibilityWhere`.
 *
 * "Bound" (matcher-faithful, NOT hand-rolled) is the union of two doors that
 * already exist:
 *   1. `classifyChannelAutomationBinding` (channel-automation-binding.ts) —
 *      the SAME per-channel mirror of the fire-time trigger matcher that
 *      `channel-stack.ts`'s `channelStack.automations` facet uses. An
 *      automation binds when its trigger can fire for ANY of the
 *      integration's channels (by explicit `channelId`, a bound-entity
 *      filter, or an unscoped workspace-wide event-pattern match).
 *   2. `automation --member_of--> capability` links (the SAME edge
 *      `channel-stack.ts` reads for its `capability` binding kind) — an
 *      automation embedded IN this capability container binds regardless of
 *      its own trigger pattern, mirroring the capability-composition reader.
 *
 * NO new store, NO new matching logic — this file only unions two existing,
 * already-tested read primitives over one capability's channel scope.
 */

import {
  db,
  and,
  eq,
  inArray,
  desc,
  automations,
  automationRuns,
  channels,
  type AutomationTriggerConfig,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { getLinksFor } from "../links/links-service.js";
import { resolveCapabilityChannelIds } from "./index.js";
import {
  classifyChannelAutomationBinding,
  type ChannelFacts,
} from "./channel-automation-binding.js";

/** How many candidate automations the binding scan will consider. Mirrors
 *  channel-stack.ts's own AUTOMATION_SCAN_CAP. */
const AUTOMATION_SCAN_CAP = 500;
/** How many recent runs are scanned to derive each automation's lastRunAt. */
const RUN_SCAN_CAP = 500;

export interface IntegrationRoutingRule {
  id: string;
  name: string;
  eventPattern: string | null;
  status: string;
  channelId: string | null;
  lastRunAt: string | null;
}

/**
 * Resolve the automations bound to one integration (capability)'s channels —
 * see file header for the two-door union.
 */
export async function getIntegrationRoutingRules(
  userId: string,
  capabilityId: string
): Promise<IntegrationRoutingRule[]> {
  const channelIds = await resolveCapabilityChannelIds(userId, capabilityId);

  // ── Candidate automations: matcher-faithful scope (event-triggered, visible
  //    to the caller) — the same population channel-stack.ts scans. ──────────
  const candidateRows = await db
    .select({
      id: automations.id,
      name: automations.name,
      status: automations.status,
      triggerConfig: automations.triggerConfig,
    })
    .from(automations)
    .where(
      and(
        userVisibleWhere(automations.workspaceId, userId),
        eq(automations.triggerType, "event")
      )
    )
    .limit(AUTOMATION_SCAN_CAP);

  const boundIds = new Set<string>();

  if (channelIds.length > 0) {
    const channelRows = await db
      .select({
        id: channels.id,
        contextObjectId: channels.contextObjectId,
        externalSource: channels.externalSource,
      })
      .from(channels)
      .where(inArray(channels.id, channelIds));

    const channelFacts: ChannelFacts[] = channelRows.map((c) => ({
      channelId: c.id,
      boundEntityId: c.contextObjectId,
      provider: c.externalSource,
    }));

    for (const a of candidateRows) {
      const config = a.triggerConfig as AutomationTriggerConfig;
      const bound = channelFacts.some(
        (facts) => classifyChannelAutomationBinding(config, facts) !== null
      );
      if (bound) boundIds.add(a.id);
    }
  }

  // ── Capability-embedded automations: `automation --member_of--> capability`
  //    — bound regardless of trigger pattern (mirrors channel-stack.ts). ─────
  const memberEdges = await getLinksFor(userId, "capability", capabilityId);
  for (const e of memberEdges) {
    if (
      e.linkType === "member_of" &&
      e.fromType === "automation" &&
      e.toType === "capability"
    ) {
      boundIds.add(e.fromId);
    }
  }

  if (boundIds.size === 0) return [];

  // Fetch rows for any bound automation the initial scan missed (a different
  // triggerType, or beyond AUTOMATION_SCAN_CAP), floored the same way.
  const seenIds = new Set(candidateRows.map((r) => r.id));
  const missingIds = [...boundIds].filter((id) => !seenIds.has(id));
  const extraRows = missingIds.length
    ? await db
        .select({
          id: automations.id,
          name: automations.name,
          status: automations.status,
          triggerConfig: automations.triggerConfig,
        })
        .from(automations)
        .where(
          and(
            inArray(automations.id, missingIds),
            userVisibleWhere(automations.workspaceId, userId)
          )
        )
    : [];

  const allRows = [
    ...candidateRows.filter((r) => boundIds.has(r.id)),
    ...extraRows,
  ];

  // ── lastRunAt per automation. JS-side first-seen reduction over the newest
  //    RUN_SCAN_CAP runs (mirrors the run-scan style `rollUpHealth` uses,
  //    avoiding a GROUP BY over a table with no per-automation cap). ─────────
  const automationIds = allRows.map((r) => r.id);
  const lastRunByAutomation = new Map<string, Date>();
  if (automationIds.length > 0) {
    const runRows = await db
      .select({
        automationId: automationRuns.automationId,
        startedAt: automationRuns.startedAt,
      })
      .from(automationRuns)
      .where(inArray(automationRuns.automationId, automationIds))
      .orderBy(desc(automationRuns.startedAt))
      .limit(RUN_SCAN_CAP);
    for (const r of runRows) {
      if (!lastRunByAutomation.has(r.automationId)) {
        lastRunByAutomation.set(r.automationId, r.startedAt);
      }
    }
  }

  return allRows.map((a) => {
    const config = a.triggerConfig as AutomationTriggerConfig | null;
    const lastRunAt = lastRunByAutomation.get(a.id);
    return {
      id: a.id,
      name: a.name,
      eventPattern: config?.eventPattern ?? null,
      status: a.status,
      channelId: config?.channelId ?? null,
      lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    };
  });
}
