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

import { createHash } from "node:crypto";
import {
  db,
  eq,
  and,
  or,
  isNull,
  inArray,
  drizzleSql,
  automations,
  automationRuns,
  automationClaims,
  playbookAutomations,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import type { AutomationTriggerConfig } from "@synap/database";
import { matchMessageShape, type MessageEnvelope } from "@synap/database";
import { MESSAGE_ALIAS_PATTERNS } from "@synap-core/types";
// Re-export to preserve this module's public surface (tests + downstream imports)
// after MessageEnvelope + matchMessageShape moved to `@synap/database`.
export type { MessageEnvelope };
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import { deriveEventSubjectEntityId } from "../utils/run-subject.js";

const logger = createLogger({ module: "automation-trigger-matcher" });

const MAX_CHAIN_DEPTH = 3;

/** Claim namespace for exactly-once event→automation fire (D5). */
export const AUTOMATION_EVENT_CLAIM_NAMESPACE = "automation-event";

/**
 * Prefer a stable id from the event payload when present (messageId from
 * Discord/Unipile inbound, explicit eventId, subject-ish ids). Falls back to a
 * deterministic hash of eventType+subjectId+data so redeliveries without a
 * native id still collapse.
 */
export function resolveAutomationEventFingerprintId(input: {
  eventType: string;
  subjectId: string;
  data?: Record<string, unknown>;
}): string {
  const data = input.data ?? {};
  const candidates: unknown[] = [
    data.eventId,
    data.messageId,
    data.id,
    // Webhook redelivery often repeats the same body under the same subscription.
    data.subscriptionId && data.payload != null
      ? `${String(data.subscriptionId)}:${stableJsonHash(data.payload)}`
      : null,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return stableJsonHash({
    eventType: input.eventType,
    subjectId: input.subjectId,
    data,
  });
}

export function buildAutomationEventClaimKey(input: {
  automationId: string;
  eventType: string;
  subjectEntityId?: string | null;
  eventFingerprintId: string;
}): string {
  const subject = input.subjectEntityId?.trim() || "none";
  return `${input.automationId}:${input.eventType}:${subject}:${input.eventFingerprintId}`;
}

function stableJsonHash(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 32);
}

/** Deterministic JSON for fingerprint hashing (sorted object keys). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

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
  /**
   * CONFUSED-DEPUTY GUARD (the causal-chain producer). The userId of the actor
   * that PRODUCED the triggering event — the agent (or human) whose write/observation
   * fired this match. Threaded UNCHANGED into every fired automation's
   * `automation-execute` job so the executor can govern the THEN-actions against
   * the PRODUCER, not just the automation owner. Without it, an agent-authored
   * trigger firing a HUMAN-owned automation would auto-execute the THEN-action
   * ungoverned (the owner resolves `not-agent` → granted) — a human-owned
   * automation laundering an agent's write into an ungoverned effect. The gate
   * (`checkAutomationWriteOrPropose`) confirms agent-ness before escalating, so a
   * plain human producer here is a no-op (it resolves `not-agent` and the owner
   * path is unchanged). Absent for manual/cron runs (they never pass through the
   * matcher) → owner-only governance, exactly as today.
   */
  producerAgentUserId?: string | null;
}

/**
 * The two PHYSICAL message events the `message.received` synthetic alias covers.
 *   `external_message.received.completed` — inbound-recorder's emitSideEffects.
 *   `channel_message.created.completed`   — an in-pod channel message.
 * `channel-automation-binding.ts` (@synap/api) keeps a HAND-MIRRORED copy of
 * this list (`CHANNEL_EVENT_TYPES`) so the Signal channel-Stack surface counts
 * the same automations — keep the two in lockstep.
 */
export const MESSAGE_ALIAS_EVENT_TYPES = [
  "external_message.received.completed",
  "channel_message.created.completed",
] as const;

/**
 * The synthetic aliases an automation can use to fire for BOTH physical message
 * events without binding to one transport. `message.received` is the documented
 * form; `message.*` / `message.received.*` are accepted for grammar symmetry
 * with the trailing-wildcard patterns elsewhere. This is a MATCH-ALIAS only —
 * the physical events still exist and `external_message.*` / `channel_message.*`
 * automations are untouched.
 */
function matchesMessageAlias(eventType: string, pattern: string): boolean {
  if (!(MESSAGE_ALIAS_PATTERNS as readonly string[]).includes(pattern)) {
    return false;
  }
  return (MESSAGE_ALIAS_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Match an event pattern against a trigger pattern.
 * Supports exact match and trailing wildcard:
 *   "entities.create.completed" matches "entities.create.completed"
 *   "entities.create.*" matches "entities.create.completed"
 *   "entities.*" matches "entities.create.completed"
 * Plus the synthetic `message.received` alias (see `matchesMessageAlias`), which
 * fires for BOTH physical message events — additive, physical patterns unchanged.
 */
export function matchPattern(eventType: string, pattern?: string): boolean {
  if (!pattern) return false;
  if (pattern === eventType) return true;

  // Synthetic message alias — an ADDITIVE opt-in, checked before the literal
  // dotted-wildcard walk (which could never match "message.*" against
  // "external_message..." anyway, so there is no collision).
  if (matchesMessageAlias(eventType, pattern)) return true;

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
 * Normalized, provider-agnostic view of a message event, derived ONCE at match
 * time from EITHER `external_message.received.completed` OR
 * `channel_message.created.completed`. Shape predicates and downstream
 * `{{trigger.message.*}}` context both read this ONE shape, so a
 * `message.received` automation never has to know which transport fired it.
 *
 * Fields are honest to the source payload: `channel_message.created` carries
 * only `{ channelId, messageRole }` today, so its envelope has no content /
 * participant / attachments — a shape predicate over those simply won't match a
 * channel_message (never fabricated).
 */
/** Whether an event type is one of the physical message events. */
function isMessageEvent(eventType: string): boolean {
  return (
    eventType.startsWith("external_message.") ||
    eventType.startsWith("channel_message.")
  );
}

/**
 * Map EITHER physical message payload into ONE `MessageEnvelope`. Returns
 * undefined for a non-message event. Reads only fields the emitter actually
 * puts on the event `data` (inbound-recorder's emitSideEffects for external;
 * channels.ts for channel_message) — anything absent stays undefined.
 */
function deriveMessageEnvelope(
  eventType: string,
  data: Record<string, unknown> | undefined
): MessageEnvelope | undefined {
  if (!isMessageEvent(eventType)) return undefined;
  const d = data ?? {};

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const rawAttachments = Array.isArray(d.attachments) ? d.attachments : [];
  const attachments = rawAttachments
    .filter(
      (a): a is Record<string, unknown> => a != null && typeof a === "object"
    )
    .map((a) => ({ type: str(a.type), url: str(a.url) }));

  return {
    channelId: str(d.channelId),
    // Not on today's payloads, but read defensively so a richer emitter (or a
    // bridge-stamped event) is honored without another matcher change.
    channelType: str(d.channelType),
    bridgeId: str(d.bridgeId),
    provider: str(d.provider),
    participant: str(d.participantName) ?? str(d.participant),
    content: str(d.content),
    attachments,
    entityId: str(d.entityId),
  };
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
  config: AutomationTriggerConfig,
  envelope?: MessageEnvelope
): boolean {
  // ── message shape predicate (composes WITH channelId below) ─────────────
  // Applies to BOTH physical message events (so it also covers a
  // `message.received`-alias automation, which fires for either). A non-message
  // event never carries a shape today; gating on `isMessageEvent` keeps this
  // strictly additive. `channelId` binding + `shape` are ANDed — both must pass.
  if (config.shape && isMessageEvent(eventType)) {
    if (!matchMessageShape(config.shape, envelope)) return false;
  }

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

  // ── external_message trigger ────────────────────────────────────────────
  // SYMMETRIC with channel_message above. `external_message.received` carries
  // `data.channelId` (inbound-recorder's emitSideEffects), but without this
  // branch a `triggerConfig.channelId` was IGNORED for external messages — so an
  // extraction automation could not be bound to ONE inbound channel and fired
  // for every channel in the lens. Absent `channelId` still matches everything,
  // so every existing workspace-wide external_message automation is unchanged.
  if (eventType.startsWith("external_message.")) {
    if (config.channelId && eventData?.channelId !== config.channelId) {
      return false;
    }
    // Deliberately channelId-ONLY. A `provider` filter would be symmetric too,
    // but `triggerConfig.provider` is the connector_sync field and some existing
    // external_message automations carry it as leftover config — honoring it
    // here would silently STOP them from firing. Binding by channel is the gap
    // this fixes; provider filtering stays available via `triggerConfig.filters`.
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
 * Re-derive the automation chain context stamped on a focus session at
 * A2AI-trigger time (executePlaybookRun stores it in
 * `focus_sessions.metadata.automationChainContext`). Returns undefined when the
 * session carries no chain context (a user-originated session) — the caller then
 * treats the event as depth 0, unchanged. Best-effort: a lookup failure degrades
 * to depth 0 rather than blocking matching.
 */
async function deriveSessionChainContext(
  sessionId: string
): Promise<TriggerMatchPayload["automationContext"] | undefined> {
  try {
    const session = await db.query.focusSessions.findFirst({
      where: (f, { eq }) => eq(f.id, sessionId),
      columns: { metadata: true },
    });
    const stamped = (session?.metadata as Record<string, unknown> | undefined)
      ?.automationChainContext as
      | {
          automationRunId?: string;
          automationId?: string;
          chainDepth?: number;
          rootRunId?: string;
          chainAutomationIds?: string[];
        }
      | undefined;
    if (!stamped?.automationId || !stamped?.automationRunId) return undefined;
    return {
      automationRunId: stamped.automationRunId,
      automationId: stamped.automationId,
      chainDepth: stamped.chainDepth ?? 0,
      rootRunId: stamped.rootRunId ?? stamped.automationRunId,
      chainAutomationIds: stamped.chainAutomationIds ?? [],
    };
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "Failed to derive session chain context — proceeding as depth 0"
    );
    return undefined;
  }
}

/**
 * Main handler: match an event against all active automations in the workspace.
 */
export async function handleAutomationTriggerMatch(job: {
  data: TriggerMatchPayload;
}): Promise<void> {
  const {
    eventType,
    subjectId,
    userId,
    workspaceId,
    data,
    automationContext,
    producerAgentUserId,
  } = job.data;

  // ── F2 depth floor across the agent boundary ───────────────────────────
  // An agent's Hub writes carry the focus session (sessionId) but NO
  // automationContext, so a cron→agent→write→automation chain would reset to
  // depth 0 and could loop unbounded — the MAX_CHAIN_DEPTH guard is blind across
  // the agent boundary. When the event has a session and no explicit context,
  // re-derive the chain context stamped on that session at A2AI-trigger time
  // (executePlaybookRun) so the depth + cycle guards see the TRUE chain.
  let effectiveContext = automationContext;
  if (!effectiveContext && job.data.sessionId) {
    const derived = await deriveSessionChainContext(job.data.sessionId);
    if (derived) effectiveContext = derived;
  }

  // ── Chain depth check ──────────────────────────────────────────────────
  const currentDepth = effectiveContext?.chainDepth ?? 0;
  if (currentDepth >= MAX_CHAIN_DEPTH) {
    logger.warn(
      {
        eventType,
        workspaceId,
        chainDepth: currentDepth,
        rootRunId: effectiveContext?.rootRunId,
      },
      "Automation chain depth limit reached — skipping trigger matching"
    );
    return;
  }

  const chainIds = new Set(effectiveContext?.chainAutomationIds ?? []);

  // ── Find matching automations ──────────────────────────────────────────
  // Pod-wide inbound: a null event workspace (a shared / external channel with
  // `workspaceId = NULL`) means "match across the acting user's accessible
  // workspace floor" — `eq(workspaceId, NULL)` matches nothing. A non-null event
  // workspace keeps the single-workspace scope. An empty floor yields
  // `inArray(..., [])` = false, i.e. no workspace-scoped matches.
  //
  // POD-WIDE AUTOMATIONS (`automations.workspace_id IS NULL`) are selected in
  // BOTH branches. Neither `eq(col, <id>)` nor `IN (<floor>)` can ever match a
  // NULL column, so without the explicit `isNull` branch a pod-wide automation
  // could never fire for any event — the same trap `userVisibleWhere`
  // (api/src/utils/user-visible-where.ts) avoids with its leading
  // `isNull(workspaceIdColumn)` branch, and the same rule playbooks apply in
  // `matchForEntity` ("a pod-wide (NULL-workspace) template-seeded playbook MUST
  // match for any workspace's entity"). A pod-wide automation is owner-implicit
  // config (routers/automations.ts create: "Pod-wide (no workspaceId) is
  // owner-implicit"), so its scope is the pod.
  //
  // Not a cross-workspace leak: `fireAutomation` runs each match in the EVENT's
  // workspace (`workspaceId ?? automationWorkspaceId`), and the executor scopes
  // every read to `workspaceId` ∪ pod-wide globals. A pod-wide automation firing
  // on workspace W's event therefore sees exactly what an automation defined in
  // W sees — it gains no access to any other workspace.
  //
  // The remaining case — a pod-wide EVENT matching a pod-wide AUTOMATION, where
  // BOTH sides are NULL and `workspaceId ?? automationWorkspaceId` is itself
  // NULL — has no workspace to run in at all. `fireAutomation` skips it with a
  // warning rather than dispatching a NULL workspace into an executor that
  // cannot scope one; see the guard there.
  // OWNER BOUND on the pod-wide branch. "Owner-implicit" holds at CREATE time
  // (routers/automations.ts) but is NOT enforced at MATCH time, and the
  // workspace-scoped branch is bounded by membership while a bare
  // `isNull(workspace_id)` is bounded by nothing. On a multi-member pod that
  // would let user A's pod-wide automation fire on user B's events — A's flow
  // executing inside B's run. Reads stay scoped to the event's workspace either
  // way (no data leak), but cross-user EXECUTION is not something a NULL
  // workspace should imply. Pairing the NULL check with `createdBy = userId`
  // keeps the single-owner case (every pod-wide automation on this pod today)
  // behaving exactly as intended, and makes the multi-member case explicit
  // rather than accidental. Widening this to "all pod members" is a deliberate
  // product decision, not a default.
  const podWideMatch = and(
    isNull(automations.workspaceId),
    eq(automations.createdBy, userId)
  );

  const workspaceMatch =
    workspaceId != null
      ? or(eq(automations.workspaceId, workspaceId), podWideMatch)
      : or(
          inArray(
            automations.workspaceId,
            await getAccessibleWorkspaceFloor(userId)
          ),
          podWideMatch
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

  // ── Webhook-triggered automations ──────────────────────────────────────
  // An inbound webhook arrives here as `external_webhook.received.completed`,
  // emitted by the AUTHENTICATED ingress (routers/webhooks-inbound.ts
  // `/api/webhooks/inbound/:subscriptionId`), which has already HMAC-verified
  // the caller against the subscription's per-subscription secret. The event
  // carries `data = { subscriptionId, payload }`. It fires automations with
  // triggerType="webhook" whose triggerConfig.webhookSubscriptionId equals the
  // delivering subscription. There is no event-pattern/filter grammar for
  // webhooks — the binding IS the subscription id — so these are selected
  // separately, but fired through the SAME run-creation door as event/cron/
  // manual runs (see `fireAutomation` below). Scoped by `workspaceMatch`
  // (identical to the event set) so a subscription can only fire automations in
  // its own workspace lens.
  const webhookSubscriptionId =
    eventType === "external_webhook.received.completed"
      ? (data?.subscriptionId as string | undefined)
      : undefined;
  let webhookAutomations: typeof activeAutomations = [];
  if (webhookSubscriptionId) {
    webhookAutomations = await db
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
          eq(automations.triggerType, "webhook"),
          drizzleSql`${automations.triggerConfig}->>'webhookSubscriptionId' = ${webhookSubscriptionId}`
        )
      );
  }

  if (allAutomations.length === 0 && webhookAutomations.length === 0) return;

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

  // Normalized message view, derived ONCE from either physical message payload.
  // Read by shape predicates AND exposed to the fired automation as
  // `{{trigger.message.*}}`. `undefined` for a non-message event.
  const messageEnvelope = deriveMessageEnvelope(eventType, data);

  const boss = getBoss();

  const rootRunId =
    effectiveContext?.rootRunId ?? effectiveContext?.automationRunId;

  // ── THE run-creation door ──────────────────────────────────────────────
  // Insert the automation_run row, enqueue automation-execute, bump stats.
  // Shared by BOTH the event-matched loop and the webhook-matched loop below,
  // so a webhook-triggered run is byte-identical to an event/cron/manual run:
  // same executor, same governance, run-as-owner via `triggeredBy` (the
  // subscription owner's userId for an inbound webhook, since it carries no
  // effectiveContext). Do NOT hand-roll a second insertion path.
  async function fireAutomation(
    automationId: string,
    automationWorkspaceId: string | null,
    triggerPayload: Record<string, unknown>,
    runSubjectEntityId: string | undefined
  ): Promise<void> {
    // Pod-wide events (null event workspace) run each matched automation IN ITS
    // OWN workspace; for the non-null path this equals `workspaceId`, unchanged.
    const runWorkspaceId = workspaceId ?? automationWorkspaceId;

    // BOTH nulls = a pod-wide EVENT matching a pod-wide AUTOMATION. Neither side
    // names a workspace, so there is no honest one to derive: the executor's
    // payload is typed `workspaceId: string` and every downstream read scopes on
    // `eq(<table>.workspaceId, workspaceId)`, so dispatching NULL would open a
    // run that sits in `running` while executing against an empty scope —
    // silently inert, which is worse than not firing. Skip loudly instead.
    // (This case was unreachable while the workspace predicate used only
    // `eq`/`inArray`; the `isNull` branch above makes it reachable. The same
    // shape already exists on HEAD in automation-cron-scheduler.ts, which sends
    // a nullable `automation.workspaceId`. The real fix is executor-side —
    // `ExecutionPayload.workspaceId: string | null` with explicit pod-wide
    // handling — and is owned by automation-executor.ts.)
    if (runWorkspaceId == null) {
      logger.warn(
        { automationId, eventType, userId },
        "Skipping pod-wide automation for pod-wide event — no workspace to run in; the executor cannot scope a NULL workspace"
      );
      return;
    }

    // D5 event fingerprint: claim before side effects (enqueue). owner_run_id
    // FK requires a run row first — insert run, then claim; loser marks the
    // run skipped and does NOT enqueue. Unique index on automation_claims is
    // the concurrency boundary (namespace=automation-event).
    const eventFingerprintId = resolveAutomationEventFingerprintId({
      eventType,
      subjectId,
      data,
    });
    const claimKey = buildAutomationEventClaimKey({
      automationId,
      eventType,
      subjectEntityId: runSubjectEntityId,
      eventFingerprintId,
    });

    const [run] = await db
      .insert(automationRuns)
      .values({
        automationId,
        workspaceId: runWorkspaceId,
        subjectEntityId: runSubjectEntityId,
        triggeredBy: effectiveContext ? "system" : userId,
        triggerPayload,
        status: "running",
      })
      .returning({ id: automationRuns.id });

    const [claimed] = await db
      .insert(automationClaims)
      .values({
        workspaceId: runWorkspaceId,
        namespace: AUTOMATION_EVENT_CLAIM_NAMESPACE,
        claimKey,
        ownerRunId: run.id,
      })
      .onConflictDoNothing()
      .returning({ id: automationClaims.id });

    if (!claimed) {
      await db
        .update(automationRuns)
        .set({
          status: "skipped",
          errorMessage: "event_claim_already_held",
          completedAt: new Date(),
        })
        .where(eq(automationRuns.id, run.id));
      logger.info(
        {
          automationId,
          eventType,
          claimKey,
          runId: run.id,
        },
        "Skipping automation fire — event fingerprint claim already held"
      );
      return;
    }

    // ── Enqueue execution ──────────────────────────────────────────────
    await boss.send("automation-execute", {
      runId: run.id,
      automationId,
      workspaceId: runWorkspaceId,
      // Pass chain context so the executor can tag output events
      automationContext: {
        automationRunId: run.id,
        automationId,
        chainDepth: currentDepth + 1,
        rootRunId: rootRunId ?? run.id,
        chainAutomationIds: [...chainIds, automationId],
      },
      // Carry the causal-chain producer so the executor governs THEN-actions
      // against the agent that fired this trigger (closing the confused-deputy
      // hole). `null` for a run with no agent producer (manual/webhook/human).
      producerAgentUserId: producerAgentUserId ?? null,
    });

    // Update automation stats
    await db
      .update(automations)
      .set({
        lastRunAt: new Date(),
        runCount: drizzleSql`${automations.runCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, automationId));
  }

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
    if (!matchTriggerSpecificFilters(eventType, data, config, messageEnvelope))
      continue;

    // ── Create automation run ──────────────────────────────────────────
    logger.info(
      { automationId: automation.id, eventType, chainDepth: currentDepth + 1 },
      "Event matched automation trigger — creating run"
    );

    await fireAutomation(
      automation.id,
      automation.workspaceId,
      {
        eventType,
        subjectId,
        data: data ?? {},
        userId,
        timestamp: new Date().toISOString(),
        // Provider-agnostic normalized message for `{{trigger.message.*}}`.
        // Only present for a message event; additive alongside `data`, which
        // stays byte-identical so existing `{{trigger.data.*}}` mappings work.
        ...(messageEnvelope ? { message: messageEnvelope } : {}),
      },
      subjectEntityId
    );
  }

  // ── Fire webhook-matched automations ───────────────────────────────────
  // These matched by subscription id in the DB query above, so there is no
  // per-automation pattern/filter gate — only the cycle guard (a no-op for a
  // genuine inbound webhook, which carries an empty chain). The inbound body is
  // exposed to the flow as `trigger.payload.body` — DATA, never a URL the engine
  // fetches. No entity subject exists for an external webhook, so the run
  // degrades to its per-type feed (the intended `per_entity` fallback).
  for (const automation of webhookAutomations) {
    if (chainIds.has(automation.id)) continue;

    logger.info(
      {
        automationId: automation.id,
        webhookSubscriptionId,
        chainDepth: currentDepth + 1,
      },
      "Inbound webhook matched automation trigger — creating run"
    );

    await fireAutomation(
      automation.id,
      automation.workspaceId,
      {
        type: "webhook",
        webhookSubscriptionId,
        body: (data?.payload as unknown) ?? {},
        timestamp: new Date().toISOString(),
      },
      undefined
    );
  }
}
