/**
 * Automation Trigger Matcher Worker
 *
 * Matches incoming events against active automation triggers.
 * Creates automation_runs when a match is found and enqueues execution.
 *
 * Circular trigger prevention:
 * 1. Events carry automationContext with chainDepth and chainAutomationIds
 * 2. If chainDepth >= MAX_CHAIN_DEPTH, skip all matching
 * 3. If the automation ID is already in chainAutomationIds, skip (self-cycle)
 * 4. If no automationContext, chainDepth starts at 0 (user-originated event)
 */

import {
  db,
  eq,
  and,
  inArray,
  drizzleSql,
  automations,
  automationRuns,
  playbookAutomations,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import type { AutomationTriggerConfig } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import { deriveEventSubjectEntityId } from "../utils/run-subject.js";

const logger = createLogger({ module: "automation-trigger-matcher" });

const MAX_CHAIN_DEPTH = 3;

interface TriggerMatchPayload {
  eventType: string;
  subjectId: string;
  userId: string;
  /**
   * Workspace the event happened in. `null` for a pod-wide inbound (a shared /
   * external channel with `workspaceId = NULL`): the matcher then fans matching
   * out across the acting user's accessible workspace floor instead of a single
   * workspace. Wave-3 made this optional, so it is honestly nullable here.
   */
  workspaceId: string | null;
  data?: Record<string, unknown>;
  automationContext?: {
    automationRunId: string;
    automationId: string;
    chainDepth: number;
    rootRunId?: string;
    chainAutomationIds?: string[];
  };
  /**
   * Focus session that produced this event. When set, the matcher resolves the
   * session's playbook and ALSO selects automations linked to that playbook, so
   * playbook-scoped automations fire for entities produced by their session.
   */
  sessionId?: string | null;
}

/**
 * Match an event pattern against a trigger pattern.
 * Supports exact match and trailing wildcard:
 *   "entities.create.completed" matches "entities.create.completed"
 *   "entities.create.*" matches "entities.create.completed"
 *   "entities.*" matches "entities.create.completed"
 */
function matchPattern(eventType: string, pattern?: string): boolean {
  if (!pattern) return false;
  if (pattern === eventType) return true;

  const patternParts = pattern.split(".");
  const eventParts = eventType.split(".");

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === "*") return true; // Wildcard matches rest
    if (patternParts[i] !== eventParts[i]) return false;
  }

  return patternParts.length === eventParts.length;
}

/**
 * Check if event data matches trigger filters.
 * Filters are simple key-value equality checks on the event data.
 */
function matchFilters(
  data: Record<string, unknown> | undefined,
  filters: Record<string, unknown> | undefined
): boolean {
  if (!filters || Object.keys(filters).length === 0) return true;
  if (!data) return false;

  for (const [key, expectedValue] of Object.entries(filters)) {
    // Support dot-notation for nested access: "entity.metadata.priority"
    const actualValue = getNestedValue(data, key);
    if (actualValue !== expectedValue) return false;
  }
  return true;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Check trigger-type-specific filter fields stored directly on triggerConfig.
 *
 * The frontend TriggerSettings stores per-trigger filters as top-level fields on
 * triggerConfig (e.g. triggerConfig.channelId, triggerConfig.provider). These are
 * separate from the generic `triggerConfig.filters` key-value map.
 *
 * Returns true if the event passes all configured specific filters (or if none apply).
 */
function matchTriggerSpecificFilters(
  eventType: string,
  eventData: Record<string, unknown> | undefined,
  config: AutomationTriggerConfig
): boolean {
  // ── channel_message trigger ─────────────────────────────────────────────
  if (eventType.startsWith("channel_message.")) {
    // Filter by specific channel
    if (config.channelId && eventData?.channelId !== config.channelId) {
      return false;
    }
    // Filter by message role ("user" | "assistant" | "any")
    if (
      config.messageRole &&
      config.messageRole !== "any" &&
      eventData?.messageRole !== config.messageRole
    ) {
      return false;
    }
  }

  // ── connector_sync trigger ──────────────────────────────────────────────
  if (eventType.startsWith("connector_sync.")) {
    // Filter by connector provider (e.g. "google-calendar", "github")
    if (config.provider && eventData?.provider !== config.provider) {
      return false;
    }
    // Filter by sync outcome ("success" | "error" | "any")
    if (
      config.syncStatus &&
      config.syncStatus !== "any" &&
      eventData?.syncStatus !== config.syncStatus
    ) {
      return false;
    }
  }

  // ── relation_change trigger ─────────────────────────────────────────────
  if (
    eventType.startsWith("relation.create.") ||
    eventType.startsWith("relation.delete.")
  ) {
    // Filter by relation type slug
    if (
      config.relationType &&
      eventData?.relationType !== config.relationType
    ) {
      return false;
    }
    // Filter by change direction ("create" | "delete" | "any")
    if (config.changeType && config.changeType !== "any") {
      const action = eventType.includes(".create.") ? "create" : "delete";
      if (action !== config.changeType) {
        return false;
      }
    }
  }

  // ── entity_facet trigger (Kind + Facets, Wave 1B/1C) ────────────────────
  // Mirrors the relation_change branch above. TWO verb vocabularies reach
  // this branch: the facet API doors emit semantic actions
  // ("entity_facet.attach" / ".update" / ".detach" — routers/entities.ts
  // emitFacetSideEffects) while FacetRepository's BaseRepository events use
  // generic verbs ("entity_facet.create.completed" etc.). Both map below.
  if (eventType.startsWith("entity_facet.")) {
    // Filter by the attached role-profile.
    if (
      config.facetProfileSlug &&
      eventData?.profileSlug !== config.facetProfileSlug
    ) {
      return false;
    }
    if (
      config.facetProfileId &&
      eventData?.profileId !== config.facetProfileId
    ) {
      return false;
    }
    // Filter by change direction ("attach" | "detach" | "status_changed" | "any")
    if (config.facetChangeType && config.facetChangeType !== "any") {
      const changeType =
        eventType.startsWith("entity_facet.create.") ||
        eventType.startsWith("entity_facet.attach")
          ? "attach"
          : eventType.startsWith("entity_facet.delete.") ||
              eventType.startsWith("entity_facet.detach")
            ? "detach"
            : eventType.startsWith("entity_facet.update")
              ? "status_changed"
              : undefined;
      if (changeType !== config.facetChangeType) {
        return false;
      }
    }
    // Filter by the facet's status.
    if (config.facetStatus && eventData?.status !== config.facetStatus) {
      return false;
    }
  }

  // ── proposal_event trigger ──────────────────────────────────────────────
  if (eventType.startsWith("proposal.")) {
    // Filter by specific proposal event type ("created" | "approved" | "rejected" | "any")
    if (config.proposalEventType && config.proposalEventType !== "any") {
      if (eventData?.proposalStatus !== config.proposalEventType) {
        return false;
      }
    }
  }

  // ── capture trigger ─────────────────────────────────────────────────────
  if (eventType.startsWith("capture.")) {
    // Filter by profile slug (e.g. only fire when a "person" was captured)
    if (config.profileSlug && config.profileSlug !== "any") {
      const slugs = eventData?.profileSlugs as string[] | undefined;
      if (!slugs?.includes(config.profileSlug as string)) {
        return false;
      }
    }
  }

  // ── proactive trigger ───────────────────────────────────────────────────
  if (eventType.startsWith("proactive.")) {
    // Filter by proactive message type ("morning_briefing" | "weekly_digest" | "insight" | "any")
    if (config.proactiveType && config.proactiveType !== "any") {
      if (eventData?.proactiveType !== config.proactiveType) {
        return false;
      }
    }
  }

  // ── focus_session stage trigger ──────────────────────────────────────────
  if (eventType.startsWith("focus_session.stage_changed.")) {
    // Filter by the stage the session advanced INTO (PlaybookStage.key).
    if (config.toStage && eventData?.toStage !== config.toStage) {
      return false;
    }
  }

  // ── feed trigger ─────────────────────────────────────────────────────────
  if (eventType.startsWith("feed.")) {
    // Filter by archetype (e.g. "leads", "trends") — "any" or absent = all archetypes
    if (config.feedArchetype && config.feedArchetype !== "any") {
      if (eventData?.feedArchetype !== config.feedArchetype) {
        return false;
      }
    }
    // Filter by minimum relevance score (0-1)
    if (typeof config.feedMinRelevanceScore === "number") {
      const score = eventData?.relevanceScore as number | undefined;
      if (score === undefined || score < config.feedMinRelevanceScore) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Workspace-ID floor for a pod-wide (null-workspace) inbound: the acting user's
 * accessible workspaces — explicit memberships PLUS pod-visible / pod-joinable
 * source workspaces. Mirrors `getUserAccessibleWorkspaceIds`
 * (@synap/api → hub-protocol/rest/_shared), which is NOT importable from
 * @synap/jobs without a circular @synap/api ← @synap/jobs dependency, so the
 * canonical predicate is replicated here against the same tables.
 */
async function getAccessibleWorkspaceFloor(userId: string): Promise<string[]> {
  const memberRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const ids = new Set(memberRows.map((r) => r.workspaceId));

  const podReadable = await db
    .select({ workspaceId: workspaces.id })
    .from(workspaces)
    .where(
      drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`
    );
  for (const row of podReadable) ids.add(row.workspaceId);

  return Array.from(ids);
}

/**
 * Main handler: match an event against all active automations in the workspace.
 */
export async function handleAutomationTriggerMatch(job: {
  data: TriggerMatchPayload;
}): Promise<void> {
  const { eventType, subjectId, userId, workspaceId, data, automationContext } =
    job.data;

  // ── Chain depth check ──────────────────────────────────────────────────
  const currentDepth = automationContext?.chainDepth ?? 0;
  if (currentDepth >= MAX_CHAIN_DEPTH) {
    logger.warn(
      {
        eventType,
        workspaceId,
        chainDepth: currentDepth,
        rootRunId: automationContext?.rootRunId,
      },
      "Automation chain depth limit reached — skipping trigger matching"
    );
    return;
  }

  const chainIds = new Set(automationContext?.chainAutomationIds ?? []);

  // ── Find matching automations ──────────────────────────────────────────
  // Pod-wide inbound: a null event workspace (a shared / external channel with
  // `workspaceId = NULL`) means "match across the acting user's accessible
  // workspace floor" — `eq(workspaceId, NULL)` matches nothing. A non-null event
  // workspace keeps the exact single-workspace scope (unchanged). An empty floor
  // yields `inArray(..., [])` = false, i.e. no matches.
  const workspaceMatch =
    workspaceId != null
      ? eq(automations.workspaceId, workspaceId)
      : inArray(
          automations.workspaceId,
          await getAccessibleWorkspaceFloor(userId)
        );

  const activeAutomations = await db
    .select({
      id: automations.id,
      triggerConfig: automations.triggerConfig,
      workspaceId: automations.workspaceId,
    })
    .from(automations)
    .where(
      and(
        workspaceMatch,
        eq(automations.status, "active"),
        eq(automations.triggerType, "event")
      )
    );

  // ── Playbook-scoped automations (sessionId → playbook → composed automations) ──
  // When the event carries a sessionId, resolve its playbook and ALSO select
  // automations composed into that playbook. These fire IN ADDITION TO the
  // active workspace-scoped automations above — they supplement, not replace.
  //
  // Source of truth: `playbook_automations` (first-class, editable composition —
  // see packages/api/src/routers/playbooks.ts `automations` sub-router). The
  // legacy `links` (`automation --member_of--> playbook`) read is kept as a
  // TRANSITION FALLBACK — the 0179 migration backfilled every member_of edge
  // into playbook_automations, so this is additive/behavior-preserving; the
  // fallback only guards a member_of link written after backfill but before all
  // writers dual-write into the join table. Results from both sources are
  // deduped by automationId so a playbook-scoped automation never fires twice.
  let playbookScopedAutomations: typeof activeAutomations = [];
  if (job.data.sessionId) {
    try {
      const sessionId = job.data.sessionId;
      const session = await db.query.focusSessions.findFirst({
        where: (fields, { eq }) => eq(fields.id, sessionId),
        columns: { playbookId: true },
      });
      const playbookId = session?.playbookId;
      if (playbookId) {
        const joinRows = await db
          .select({ automationId: playbookAutomations.automationId })
          .from(playbookAutomations)
          .where(eq(playbookAutomations.playbookId, playbookId));

        const linkRows = await db.query.links.findMany({
          where: (fields, { and, eq }) =>
            and(
              eq(fields.fromType, "automation"),
              eq(fields.linkType, "member_of"),
              eq(fields.toType, "playbook"),
              eq(fields.toId, playbookId)
            ),
          columns: { fromId: true },
        });

        const playbookAutoIds = Array.from(
          new Set([
            ...joinRows.map((r) => r.automationId),
            ...linkRows.map((l) => l.fromId),
          ])
        );

        if (playbookAutoIds.length > 0) {
          playbookScopedAutomations = await db
            .select({
              id: automations.id,
              triggerConfig: automations.triggerConfig,
              workspaceId: automations.workspaceId,
            })
            .from(automations)
            .where(
              and(
                inArray(automations.id, playbookAutoIds),
                eq(automations.status, "active"),
                eq(automations.triggerType, "event")
              )
            );
        }
      }
    } catch (err) {
      // Best-effort: playbook-scoped automations are a supplement. If the
      // resolution fails, workspace-wide automations still fire.
      logger.warn(
        { err, sessionId: job.data.sessionId },
        "Failed to resolve playbook-scoped automations — proceeding with workspace-wide only"
      );
    }
  }

  // Dedupe the two automation sets by id — a workspace-wide automation that is
  // ALSO playbook-scoped, or an automation present in both the join table and
  // the legacy link fallback, must fire exactly once.
  const seenAutomationIds = new Set<string>();
  const allAutomations: typeof activeAutomations = [];
  for (const automation of [
    ...activeAutomations,
    ...playbookScopedAutomations,
  ]) {
    if (seenAutomationIds.has(automation.id)) continue;
    seenAutomationIds.add(automation.id);
    allAutomations.push(automation);
  }
  if (allAutomations.length === 0) return;

  // The entity this EVENT is about — the durable per-run lens `resolveRunChannel`
  // reads for `resultRouting: "per_entity"`. A property of the event, not of the
  // automation, so it is derived once and stamped on every run this event opens.
  // `undefined` for an event with no entity subject (a per_entity automation then
  // degrades to its per-type feed, which is the intended fallback).
  const subjectEntityId = deriveEventSubjectEntityId({
    eventType,
    subjectId,
    data,
  });

  const boss = getBoss();

  for (const automation of allAutomations) {
    // ── Cycle detection ────────────────────────────────────────────────
    if (chainIds.has(automation.id)) {
      logger.info(
        { automationId: automation.id, eventType },
        "Skipping automation — already in chain (cycle prevention)"
      );
      continue;
    }

    const config = automation.triggerConfig as AutomationTriggerConfig;

    // ── Pattern match ──────────────────────────────────────────────────
    if (!matchPattern(eventType, config.eventPattern)) continue;

    // ── Filter match ───────────────────────────────────────────────────
    if (!matchFilters(data, config.filters)) continue;

    // ── Trigger-type-specific filter match ─────────────────────────────
    if (!matchTriggerSpecificFilters(eventType, data, config)) continue;

    // ── Create automation run ──────────────────────────────────────────
    logger.info(
      { automationId: automation.id, eventType, chainDepth: currentDepth + 1 },
      "Event matched automation trigger — creating run"
    );

    // Pod-wide events (null event workspace) run each matched automation IN ITS
    // OWN workspace; the eq() filter above guarantees this equals `workspaceId`
    // for the non-null path, so that path is unchanged.
    const runWorkspaceId = workspaceId ?? automation.workspaceId;

    const rootRunId =
      automationContext?.rootRunId ?? automationContext?.automationRunId;

    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId: automation.id,
        workspaceId: runWorkspaceId,
        subjectEntityId,
        triggeredBy: automationContext ? "system" : userId,
        triggerPayload: {
          eventType,
          subjectId,
          data: data ?? {},
          userId,
          timestamp: new Date().toISOString(),
        },
        status: "running",
      })
      .returning({ id: automationRuns.id });

    // ── Enqueue execution ──────────────────────────────────────────────
    await boss.send("automation-execute", {
      runId: run.id,
      automationId: automation.id,
      workspaceId: runWorkspaceId,
      // Pass chain context so the executor can tag output events
      automationContext: {
        automationRunId: run.id,
        automationId: automation.id,
        chainDepth: currentDepth + 1,
        rootRunId: rootRunId ?? run.id,
        chainAutomationIds: [...chainIds, automation.id],
      },
    });

    // Update automation stats
    await db
      .update(automations)
      .set({
        lastRunAt: new Date(),
        runCount: automations.runCount,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automation.id));
  }
}
