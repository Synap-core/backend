/**
 * Subscriptions Router — read-only projection powering the "Reactions" / Pulse UI.
 *
 * This router owns NO write table. It is a pure read facade that unions the
 * reactive primitives on the shared event spine into one discriminated,
 * timestamp-sorted feed of `ReactionEvent`s, then fans each event out into its
 * downstream `Reaction[]` (automation runs, webhook deliveries, notifications,
 * and correlated downstream events).
 *
 * Scoping note: the `events` table has no `workspaceId` column (workspace
 * context lives in `data.workspaceId`), so `userVisibleWhere` — which needs a
 * column — cannot be applied to it directly. We user-scope via `userId` (the
 * canonical events convention, see `events.read` + the events hub REST handler)
 * and apply the 3-state `workspaceId` filter against `data->>'workspaceId'`
 * (already supported by `EventRepository.searchEvents`).
 *
 * Fan-out correlation: events are linked by `correlationId`. webhook_deliveries
 * link to their source via `eventId` (FK to events). automation_runs and
 * notifications have NO correlationId column, so for them we fall back to a
 * time-window + subjectId correlation around the source event (documented in
 * `eventFanout`).
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { requireUserId } from "../utils/user-scoped.js";
import { startOfUtcDay } from "../utils/permission-check.js";
import {
  db,
  eventRepository,
  type EventRecord,
  automationRuns,
  notifications,
  webhookDeliveries,
  users,
  proposals,
  ProposalStatus,
  entities,
  workspaces,
  channels,
  profiles,
  views,
  projects,
  skills,
  ProfileScope,
  userVisibleWhere,
  memberWorkspaceIds,
  ownedWorkspaceIds,
  eq,
  and,
  or,
  gte,
  lte,
  inArray,
} from "@synap/database";
import { entityReadVisibleWhere } from "./entities/helpers.js";
import { channelVisibilityWhere } from "../utils/channel-visibility.js";
import type {
  Reaction,
  ReactionEvent,
  ReactionKind,
  ReactionLens,
} from "../types/reactions.js";
import {
  INTERNAL_REACTION_KINDS,
  EXTERNAL_REACTION_KINDS,
} from "../types/reactions.js";

// ── Input schemas ────────────────────────────────────────────────────────────

const reactionKindSchema = z.enum([
  "automation",
  "ai_feed",
  "ai_react",
  "notify",
  "webhook",
  "message_out",
]);

const lensSchema = z.enum(["all", "internal", "external"]);

// ── Derivation helpers ────────────────────────────────────────────────────────

/**
 * Inbound trigger families — these flow INTO the system (a trigger fired).
 * Match on the event-type prefix.
 */
const INBOUND_TYPE_PREFIXES = ["cron.", "feed.item.", "webhook.received"];

function isInboundEvent(eventType: string): boolean {
  return INBOUND_TYPE_PREFIXES.some((p) => eventType.startsWith(p));
}

/** A failure event is any `*.failed` type. */
function isFailedEvent(eventType: string): boolean {
  return eventType.endsWith(".failed");
}

/**
 * Derive whether the actor of an event is an AI agent.
 * AI events come from automation/intelligence sources, or carry an
 * `agentUserId` / `agentType` hint in their data.
 */
function deriveActorAI(event: EventRecord): boolean {
  const source = (event.source ?? "").toLowerCase();
  if (
    source === "automation" ||
    source === "intelligence" ||
    source === "ai" ||
    source === "agent"
  ) {
    return true;
  }
  const data = event.data ?? {};
  if (data.agentUserId || data.agentType) return true;
  const dataSource =
    typeof data.source === "string" ? data.source.toLowerCase() : "";
  return (
    dataSource === "ai" ||
    dataSource === "agent" ||
    dataSource === "intelligence"
  );
}

/**
 * Derive a human-readable actor label for an event.
 * Resolved display names (from the users table) are layered in by the caller;
 * this produces the structural fallback (cron expression, feed source, source).
 */
function deriveActor(
  event: EventRecord,
  actorNameById: Map<string, string>
): string {
  const data = event.data ?? {};

  // Cron-triggered: "cron:0 7 * * *"
  if (event.eventType.startsWith("cron.")) {
    const expr =
      (typeof data.expression === "string" && data.expression) ||
      (typeof data.cron === "string" && data.cron);
    if (expr) return `cron:${expr}`;
  }

  // Feed-triggered: "feed:rss"
  if (event.eventType.startsWith("feed.")) {
    const feedSource =
      (typeof data.feedSource === "string" && data.feedSource) ||
      (typeof data.sourceType === "string" && data.sourceType) ||
      (typeof data.source === "string" && data.source);
    if (feedSource) return `feed:${feedSource}`;
  }

  // Named actor (agent or human) resolved from users table.
  const actorUserId =
    (typeof data.agentUserId === "string" && data.agentUserId) ||
    (typeof data.actorId === "string" && data.actorId) ||
    event.userId;
  const resolved = actorUserId ? actorNameById.get(actorUserId) : undefined;
  if (resolved) return resolved;

  // Structural fallback.
  return event.source || "system";
}

/**
 * Build a short human summary of the event subject, e.g.
 * "Helix Robotics · closeDate → Jun 3".
 */
function deriveSubject(event: EventRecord): string {
  const data = event.data ?? {};
  const title =
    (typeof data.title === "string" && data.title) ||
    (typeof data.name === "string" && data.name) ||
    (typeof data.subjectName === "string" && data.subjectName) ||
    undefined;

  // Property change summary: "closeDate → Jun 3"
  const props =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : undefined;
  if (props) {
    const entries = Object.entries(props).slice(0, 2);
    if (entries.length > 0) {
      const changeSummary = entries
        .map(([k, v]) => `${k} → ${formatValue(v)}`)
        .join(", ");
      return title ? `${title} · ${changeSummary}` : changeSummary;
    }
  }

  return title || `${event.subjectType} ${event.subjectId.slice(0, 8)}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Map a webhook delivery status string to the Reaction status union. */
function mapDeliveryStatus(
  status: string
): "success" | "pending" | "failed" | undefined {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "pending") return "pending";
  return undefined;
}

/** Map an automation run status to the Reaction status union. */
function mapRunStatus(
  status: string
): "success" | "pending" | "failed" | undefined {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "running") return "pending";
  return undefined;
}

/** Filter a reaction list by lens direction. */
function filterReactionsByLens(
  reactions: Reaction[],
  lens: ReactionLens
): Reaction[] {
  if (lens === "all") return reactions;
  const allowed =
    lens === "internal" ? INTERNAL_REACTION_KINDS : EXTERNAL_REACTION_KINDS;
  return reactions.filter((r) => allowed.includes(r.kind));
}

/**
 * Resolve display names for a batch of user IDs (agents + humans).
 */
async function resolveActorNames(
  userIds: string[]
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(inArray(users.id, unique));

  const map = new Map<string, string>();
  for (const row of rows) {
    let label: string | undefined = row.name ?? undefined;
    if (!label && row.userType === "agent") {
      label =
        row.agentMetadata?.agentType ??
        row.agentMetadata?.description ??
        undefined;
    }
    if (!label) label = row.email ?? undefined;
    if (label) map.set(row.id, label);
  }
  return map;
}

/** Matches a canonical v4-shaped UUID (the id form of every uuid PK column). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map key for a resolved subject: `${subjectType}:${subjectId}`. */
function subjectKey(subjectType: string, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

/**
 * Resolve the REAL display name of each event's subject object, mirroring
 * `resolveActorNames`: group the loaded events by `subjectType`, then run ONE
 * batched, user-scoped `inArray` query per KNOWN type. Returns a
 * `Map<"subjectType:subjectId", name>`.
 *
 * FAIL-OPEN by construction: an id that matches no visible row is simply absent
 * from the map, so the caller keeps `deriveSubject`'s opaque fallback — a name
 * is NEVER fabricated. Every query is user-scoped via the canonical visibility
 * predicate (entity read-floor / workspace membership / owner columns), never a
 * request-supplied filter, so no cross-tenant name can leak. Worst case ≤ ~7
 * batched queries (one per known type present in the ≤500-event window).
 */
async function resolveSubjectNames(
  events: EventRecord[],
  userId: string
): Promise<Map<string, string>> {
  // Bucket subjectIds by the table that owns them. Both "workspace" and the
  // legacy plural "workspaces" resolve to the workspaces table.
  const entityIds = new Set<string>();
  const workspaceIds = new Set<string>();
  const notificationIds = new Set<string>();
  const profileIds = new Set<string>();
  const viewIds = new Set<string>();
  const projectIds = new Set<string>();
  const skillIds = new Set<string>();
  const channelIds = new Set<string>();

  for (const e of events) {
    const id = e.subjectId;
    if (!id) continue;
    switch (e.subjectType) {
      case "entity":
        entityIds.add(id);
        break;
      case "workspace":
      case "workspaces":
        workspaceIds.add(id);
        break;
      case "notification":
        notificationIds.add(id);
        break;
      case "channel":
        channelIds.add(id);
        break;
      case "profile":
        profileIds.add(id);
        break;
      case "view":
        viewIds.add(id);
        break;
      case "project":
        projectIds.add(id);
        break;
      case "skill":
        skillIds.add(id);
        break;
      default:
        // Unknown / unmapped subjectType → no query, opaque fallback kept.
        break;
    }
  }

  // Only ids that are UUID-shaped may hit a `uuid` PK column — a non-uuid id
  // (e.g. a subjectId that fell back to a slug) would raise a Postgres cast
  // error rather than fail open.
  const uuidsOf = (s: Set<string>): string[] =>
    Array.from(s).filter((x) => UUID_RE.test(x));

  const entityIdList = uuidsOf(entityIds);
  const workspaceIdList = uuidsOf(workspaceIds);
  const notificationIdList = uuidsOf(notificationIds);
  const viewIdList = uuidsOf(viewIds);
  const projectIdList = uuidsOf(projectIds);
  const skillIdList = uuidsOf(skillIds);
  const channelIdList = uuidsOf(channelIds);
  // Profiles may key by SLUG (text) OR uuid — query both branches.
  const profileSlugList = Array.from(profileIds);
  const profileUuidList = uuidsOf(profileIds);

  type NamedRow = { id: string; name: string | null };
  const empty = Promise.resolve([] as NamedRow[]);

  const [
    entityRows,
    workspaceRows,
    notificationRows,
    viewRows,
    projectRows,
    skillRows,
    channelRows,
    profileRows,
  ] = await Promise.all([
    // entity → entities.title, scoped by the entity READ visibility floor.
    entityIdList.length
      ? db
          .select({ id: entities.id, name: entities.title })
          .from(entities)
          .where(
            and(
              inArray(entities.id, entityIdList),
              entityReadVisibleWhere(userId)
            )
          )
      : empty,
    // workspace(s) → workspaces.name, scoped to the user's visible workspaces.
    workspaceIdList.length
      ? db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(
            and(
              inArray(workspaces.id, workspaceIdList),
              userVisibleWhere(workspaces.id, userId)
            )
          )
      : empty,
    // notification → notifications.title, scoped by recipient userId.
    notificationIdList.length
      ? db
          .select({ id: notifications.id, name: notifications.title })
          .from(notifications)
          .where(
            and(
              inArray(notifications.id, notificationIdList),
              eq(notifications.userId, userId)
            )
          )
      : empty,
    // view → views.name, scoped by creator userId.
    viewIdList.length
      ? db
          .select({ id: views.id, name: views.name })
          .from(views)
          .where(and(inArray(views.id, viewIdList), eq(views.userId, userId)))
      : empty,
    // project → projects.name, scoped by owner userId.
    projectIdList.length
      ? db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            and(
              inArray(projects.id, projectIdList),
              eq(projects.userId, userId)
            )
          )
      : empty,
    // skill → skills.name, scoped by owner userId.
    skillIdList.length
      ? db
          .select({ id: skills.id, name: skills.name })
          .from(skills)
          .where(
            and(inArray(skills.id, skillIdList), eq(skills.userId, userId))
          )
      : empty,
    // channel → channels.title, scoped by the canonical channel READ
    // visibility predicate (owner / member / shared-in-workspace / pod-wide
    // shared) — mirrors the access-layer `channels` VisibilityRule so a
    // resolved name never outruns what the caller could otherwise read.
    channelIdList.length
      ? db
          .select({ id: channels.id, name: channels.title })
          .from(channels)
          .where(
            and(
              inArray(channels.id, channelIdList),
              channelVisibilityWhere(userId)
            )
          )
      : empty,
    // profile → profiles.displayName. Match by uuid id OR slug. Scope: SYSTEM /
    // SHARED vocabulary is pod-wide by design; USER/WORKSPACE profiles floor on
    // the caller's own userId or their member/owned workspaces so a foreign
    // private profile name never leaks.
    profileSlugList.length
      ? db
          .select({
            id: profiles.id,
            slug: profiles.slug,
            name: profiles.displayName,
          })
          .from(profiles)
          .where(
            and(
              or(
                ...(profileUuidList.length
                  ? [inArray(profiles.id, profileUuidList)]
                  : []),
                inArray(profiles.slug, profileSlugList)
              ),
              or(
                inArray(profiles.scope, [
                  ProfileScope.SYSTEM,
                  ProfileScope.SHARED,
                ]),
                eq(profiles.userId, userId),
                inArray(profiles.workspaceId, memberWorkspaceIds(userId)),
                inArray(profiles.workspaceId, ownedWorkspaceIds(userId))
              )
            )
          )
      : Promise.resolve(
          [] as { id: string; slug: string; name: string | null }[]
        ),
  ]);

  const out = new Map<string, string>();
  const putById = (
    rows: NamedRow[],
    subjectTypes: string[],
    ids: Set<string>
  ): void => {
    const byId = new Map<string, string>();
    for (const r of rows) if (r.name) byId.set(r.id, r.name);
    if (byId.size === 0) return;
    for (const id of ids) {
      const name = byId.get(id);
      if (!name) continue;
      for (const t of subjectTypes) out.set(subjectKey(t, id), name);
    }
  };

  putById(entityRows, ["entity"], entityIds);
  putById(workspaceRows, ["workspace", "workspaces"], workspaceIds);
  putById(notificationRows, ["notification"], notificationIds);
  putById(viewRows, ["view"], viewIds);
  putById(projectRows, ["project"], projectIds);
  putById(skillRows, ["skill"], skillIds);
  putById(channelRows, ["channel"], channelIds);

  // Profiles: resolve each subjectId by uuid id first, then by slug.
  const profileById = new Map<string, string>();
  const profileBySlug = new Map<string, string>();
  for (const r of profileRows) {
    if (!r.name) continue;
    profileById.set(r.id, r.name);
    profileBySlug.set(r.slug, r.name);
  }
  for (const id of profileIds) {
    const name = profileById.get(id) ?? profileBySlug.get(id);
    if (name) out.set(subjectKey("profile", id), name);
  }

  return out;
}

/**
 * Map a single event record into a ReactionEvent shell (no reactions yet).
 */
function toReactionEventShell(
  event: EventRecord,
  actorNameById: Map<string, string>,
  subjectNameByKey?: Map<string, string>
): ReactionEvent {
  const subjectName =
    subjectNameByKey && event.subjectType && event.subjectId
      ? subjectNameByKey.get(subjectKey(event.subjectType, event.subjectId))
      : undefined;
  return {
    id: event.id,
    type: event.eventType,
    timestamp: event.timestamp.toISOString(),
    subject: deriveSubject(event),
    subjectId: event.subjectId,
    subjectType: event.subjectType,
    // Set ONLY when resolved — absent keeps the opaque `subject` fallback so the
    // client can distinguish "named chip" from "mono-id chip" without sniffing.
    ...(subjectName ? { subjectName } : {}),
    actor: deriveActor(event, actorNameById),
    actorAI: deriveActorAI(event),
    correlationId: event.correlationId,
    failed: isFailedEvent(event.eventType) || undefined,
    inbound: isInboundEvent(event.eventType) || undefined,
    reactions: [],
  };
}

// ── Fan-out builder ────────────────────────────────────────────────────────────

/**
 * Build the `reactions[]` fan-out for a single source event.
 *
 * Correlation strategy:
 *   1. Downstream events sharing the source event's `correlationId` →
 *      mapped to `notify` / `ai_react` / `message_out` etc. by their type.
 *   2. webhook_deliveries whose `eventId` is the source event OR any
 *      correlated event → `webhook`.
 *   3. automation_runs + notifications: NO correlationId column. Fallback to a
 *      time-window (+/- 5 min) around the source event, matched by
 *      subjectId/workspace when available.
 */
async function buildFanout(source: EventRecord): Promise<Reaction[]> {
  const reactions: Reaction[] = [];

  // 1. Correlated events (same correlationId), user-scoped.
  // SECURITY: correlation_id is NOT unique per user — scope to source.userId so
  // another tenant's events (and their subjects/actors) never leak into this
  // user's fan-out.
  let correlatedEvents: EventRecord[] = [];
  if (source.correlationId) {
    correlatedEvents = await eventRepository.getCorrelatedEvents(
      source.correlationId,
      source.userId
    );
  }
  const relatedEventIds = new Set<string>([source.id]);
  for (const ev of correlatedEvents) {
    relatedEventIds.add(ev.id);
    if (ev.id === source.id) continue;
    const kind = reactionKindForEventType(ev.eventType, ev);
    if (kind) {
      reactions.push({
        kind,
        label: ev.eventType,
        status: isFailedEvent(ev.eventType) ? "failed" : "success",
        detail: deriveSubject(ev),
      });
    }
  }

  // 2. Webhook deliveries for the source event + any correlated event.
  // `relatedEventIds` is already user-safe: it only contains the source event
  // (owned by source.userId) plus correlated events, which step 1 scoped to
  // source.userId. webhook_deliveries has no userId column, but since every
  // eventId here belongs to this user, the deliveries are transitively
  // user-scoped — no foreign subscription's deliveries can appear.
  const deliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.eventId, Array.from(relatedEventIds)));
  for (const d of deliveries) {
    reactions.push({
      kind: "webhook",
      label: "Webhook delivery",
      status: mapDeliveryStatus(d.status),
      responseStatus:
        d.responseStatus != null ? String(d.responseStatus) : d.status,
      detail: d.attempt > 1 ? `attempt ${d.attempt}` : undefined,
    });
  }

  // 3. Fallback time-window correlation for automation_runs + notifications.
  const windowMs = 5 * 60 * 1000;
  const from = new Date(source.timestamp.getTime() - windowMs);
  const to = new Date(source.timestamp.getTime() + windowMs);
  const workspaceId =
    typeof source.data?.workspaceId === "string"
      ? (source.data.workspaceId as string)
      : undefined;

  // TODO(reactions-correlation): the canonical fix is to add a `correlation_id`
  // column to `automation_runs` + `notifications` and thread it through the
  // jobs/notification-service inserts, then correlate exactly like webhooks.
  // Until then we fall back to an owner-scoped time-window for legacy/
  // uncorrelated rows. The window is NEVER run unscoped by owner.
  //
  // SECURITY: `automation_runs` has no userId column — only nullable
  // `workspaceId` + `triggeredBy` (text holding userId-or-"system"). Scope by
  // `triggeredBy = source.userId` so we never return pod-wide runs across
  // tenants. If we have neither a usable owner nor a provable workspaceId,
  // return NO automation reactions rather than an unscoped window.
  const runsPromise = source.userId
    ? db
        .select({
          id: automationRuns.id,
          status: automationRuns.status,
          outputSummary: automationRuns.outputSummary,
          startedAt: automationRuns.startedAt,
        })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.triggeredBy, source.userId),
            gte(automationRuns.startedAt, from),
            lte(automationRuns.startedAt, to),
            ...(workspaceId
              ? [eq(automationRuns.workspaceId, workspaceId)]
              : [])
          )
        )
        .limit(20)
    : Promise.resolve(
        [] as Array<{
          id: string;
          status: string;
          outputSummary: unknown;
          startedAt: Date | null;
        }>
      );

  const [runs, notifs] = await Promise.all([
    runsPromise,
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        title: notifications.title,
        status: notifications.status,
        createdAt: notifications.createdAt,
        userId: notifications.userId,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, source.userId),
          gte(notifications.createdAt, from),
          lte(notifications.createdAt, to),
          // Tighten with the workspace constraint when the source event carries
          // one (notifications.workspaceId is nullable for pod-wide notifs).
          ...(workspaceId ? [eq(notifications.workspaceId, workspaceId)] : [])
        )
      )
      .limit(20),
  ]);

  for (const run of runs) {
    reactions.push({
      kind: "automation",
      label: "Automation run",
      status: mapRunStatus(run.status),
      detail:
        run.outputSummary && typeof run.outputSummary === "object"
          ? JSON.stringify(run.outputSummary).slice(0, 120)
          : undefined,
    });
  }

  for (const n of notifs) {
    reactions.push({
      kind: "notify",
      label: n.title || n.type,
      status: "success",
      detail: n.type,
    });
  }

  return reactions;
}

/**
 * Map an event type to a Reaction kind for the fan-out projection.
 * Returns undefined for event types that aren't surfaced as reactions.
 */
function reactionKindForEventType(
  eventType: string,
  event: EventRecord
): ReactionKind | undefined {
  if (
    eventType.startsWith("notification.") ||
    eventType.includes(".notified")
  ) {
    return "notify";
  }
  if (eventType.startsWith("webhook.")) return "webhook";
  if (eventType.startsWith("message.") && eventType.includes("out")) {
    return "message_out";
  }
  // Proactive AI nudge posted to a feed channel (see proactive REST handler).
  if (eventType.startsWith("ai.nudge")) return "ai_feed";
  if (eventType.startsWith("proactive.") || eventType.includes("feed")) {
    return "ai_feed";
  }
  // AI-sourced downstream mutation → ai_react.
  if (deriveActorAI(event)) return "ai_react";
  return undefined;
}

/**
 * Extract the lifecycle phase from a `{subject}.{action}.{phase}` event type.
 * Proposals live as `.requested` events on the spine (see
 * `checkPermissionOrPropose`); `.validated`/`.completed` = approved+executed,
 * `.denied` = rejected. Returns null for non-phased event types.
 */
function phaseOf(
  eventType: string
): "requested" | "validated" | "completed" | "denied" | null {
  if (eventType.endsWith(".requested")) return "requested";
  if (eventType.endsWith(".validated")) return "validated";
  if (eventType.endsWith(".completed")) return "completed";
  if (eventType.endsWith(".denied")) return "denied";
  return null;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const subscriptionsRouter = router({
  /**
   * User-wide union of the reactive primitives into one discriminated,
   * timestamp-sorted feed (the Pulse data source).
   *
   * Source rows come from the `events` table (the spine), user-scoped via
   * `userId`. The optional `kind` / `eventType` / `lens` narrow the feed; the
   * `lens` filters each event's reactions by direction.
   *
   * NOTE: fan-out here is lightweight (no per-event downstream queries) to keep
   * the list cheap — `reactions[]` is populated densely by `eventFanout`. The
   * list still derives actor/inbound/failed/subject so the UI can render rows.
   */
  listAll: protectedProcedure
    .input(
      z.object({
        /**
         * 3-state workspace filter (copies the proposals convention):
         *   - string    → only events for that workspace (data.workspaceId)
         *   - null      → only pod-wide events (no workspaceId in data)
         *   - undefined → no filter
         */
        workspaceId: z.string().nullish(),
        limit: z.number().min(1).max(500).default(100),
        kind: reactionKindSchema.optional(),
        eventType: z.string().optional(),
        lens: lensSchema.default("all"),
        // NOTE: the `pending` decision-inbox filter was REMOVED. It narrowed to
        // `.requested` events in the recent window whose proposal is still open,
        // so older / correlationId-null pending proposals never appeared — the
        // queue read "all clear" over a real backlog. The authoritative decision
        // inbox reads `proposals.list` directly (see the browser
        // `usePendingDecisions` hook). This lens returns ACTIVITY only.
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // 3-state workspaceId. `searchEvents` filters by data->>'workspaceId'
      // when a string is passed; for `null` (pod-wide only) we post-filter.
      const events = await eventRepository.searchEvents({
        userId,
        eventType: input.eventType,
        workspaceId:
          typeof input.workspaceId === "string" ? input.workspaceId : undefined,
        limit: input.limit,
      });

      let filtered = events;
      if (input.workspaceId === null) {
        filtered = events.filter(
          (e) =>
            !e.data || (e.data as Record<string, unknown>).workspaceId == null
        );
      }

      // Resolve actor display names in one batch.
      const actorIds = filtered.flatMap((e) => {
        const data = e.data ?? {};
        return [
          typeof data.agentUserId === "string" ? data.agentUserId : undefined,
          typeof data.actorId === "string" ? data.actorId : undefined,
          e.userId,
        ].filter((v): v is string => Boolean(v));
      });
      const [actorNameById, subjectNameByKey] = await Promise.all([
        resolveActorNames(actorIds),
        resolveSubjectNames(filtered, userId),
      ]);

      // Keep the REAL EventRecord paired with each shell so the kind facet can
      // classify off the actual event (source + data), not a synthetic shell.
      // A synthetic record with source:"" / data:{} blanks deriveActorAI and
      // would make `ai_react` / AI kinds never match.
      const mapped = filtered.map((e) => ({
        event: e,
        shell: toReactionEventShell(e, actorNameById, subjectNameByKey),
        kind: reactionKindForEventType(e.eventType, e),
      }));

      // ── Pending-proposal resolution (the decision-inbox signal) ───────────
      // A `.requested` event is "pending" when its linked proposal is still
      // PENDING and no later `.validated`/`.denied` for the same correlationId
      // appears in this window. Resolved by joining `proposals` via the
      // correlation_id Step 1 now persists.
      const resolvedCorrelations = new Set<string>();
      for (const e of filtered) {
        const ph = phaseOf(e.eventType);
        if (
          (ph === "validated" || ph === "completed" || ph === "denied") &&
          e.correlationId
        ) {
          resolvedCorrelations.add(e.correlationId);
        }
      }
      const requestedCorrelationIds = filtered
        .filter(
          (e) =>
            phaseOf(e.eventType) === "requested" &&
            e.correlationId &&
            !resolvedCorrelations.has(e.correlationId)
        )
        .map((e) => e.correlationId as string);

      // correlationId → { proposalId, pending } for the open `.requested` events.
      const proposalByCorrelation = new Map<
        string,
        { proposalId: string; pending: boolean }
      >();
      if (requestedCorrelationIds.length > 0) {
        const rows = await db
          .select({
            id: proposals.id,
            correlationId: proposals.correlationId,
            status: proposals.status,
          })
          .from(proposals)
          .where(inArray(proposals.correlationId, requestedCorrelationIds));
        for (const r of rows) {
          if (!r.correlationId) continue;
          proposalByCorrelation.set(r.correlationId, {
            proposalId: r.id,
            pending: r.status === ProposalStatus.PENDING,
          });
        }
      }

      for (const m of mapped) {
        if (phaseOf(m.event.eventType) !== "requested") continue;
        const corr = m.event.correlationId;
        if (!corr) continue;
        const p = proposalByCorrelation.get(corr);
        if (p?.pending) {
          m.shell.pending = true;
          m.shell.proposalId = p.proposalId;
        }
      }

      // If a `kind` filter is set, keep only events that map to that kind by
      // their own type (the dense fan-out filter happens in eventFanout). The
      // `.requested` shells are still marked `pending`/`proposalId` above so the
      // activity strip can exclude open-decision rows (the authoritative queue
      // owns those) — but there is no longer a decision-inbox NARROWING here.
      const final = mapped
        .filter((m) => (input.kind ? m.kind === input.kind : true))
        .map((m) => m.shell);

      return { items: final, lens: input.lens as ReactionLens };
    }),

  /**
   * Windowed activity counts for the Activity plane's pulse band.
   *
   * The band shows RATES/COMPARISONS with an explicit window — never a bare
   * all-time cumulative counter. The client only holds the newest ~200 events
   * (`listAll`), so it cannot compute an honest total; this proc does the count
   * server-side as a real SQL aggregate over the SAME population `listAll`
   * renders (see `EventRepository.activityStats`).
   *
   * Population + category derivation are matched to the feed 1:1 (pending-
   * proposal events excluded; fromAgents = deriveActorAI, leftPod = external
   * reaction kinds, needsLook = failed). "today" = start of UTC day; each window
   * carries its `sinceIso` so the band can scope-label every number.
   */
  activityStats: protectedProcedure
    .input(
      z.object({
        /**
         * 3-state workspace filter (same convention as `listAll`):
         *   - string    → only that workspace's events
         *   - null      → only pod-wide events (no workspaceId)
         *   - undefined → no filter (whole pod, every workspace the user owns)
         */
        workspaceId: z.string().nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const todaySince = startOfUtcDay();
      const weekSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const stats = await eventRepository.activityStats({
        userId,
        // Preserve the 3-state distinction: pass `null` through (pod-wide only),
        // a string through (that ws), or omit entirely (no filter).
        ...(input.workspaceId === undefined
          ? {}
          : { workspaceId: input.workspaceId }),
        todaySince,
        weekSince,
      });

      return {
        today: { ...stats.today, sinceIso: todaySince.toISOString() },
        last7d: { ...stats.last7d, sinceIso: weekSince.toISOString() },
      };
    }),

  /**
   * Populate the full fan-out (`reactions[]`) for a single source event.
   *
   * Returns the source `ReactionEvent` with its downstream reactions resolved
   * from automation_runs, webhook_deliveries, notifications, and correlated
   * events. See `buildFanout` for the correlationId-vs-time-window strategy.
   */
  eventFanout: protectedProcedure
    .input(
      z.object({
        eventId: z.string().uuid(),
        lens: lensSchema.default("all"),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Fetch the source event by primary key (one indexed lookup) and assert
      // ownership. Scanning the user's 500 most recent events would falsely
      // 404 anything older than that window.
      const source = await eventRepository.findById(input.eventId);
      if (!source || source.userId !== userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Event not found or not visible to this user",
        });
      }

      const actorNameById = await resolveActorNames([
        source.userId,
        typeof source.data?.agentUserId === "string"
          ? (source.data.agentUserId as string)
          : "",
        typeof source.data?.actorId === "string"
          ? (source.data.actorId as string)
          : "",
      ]);

      const subjectNameByKey = await resolveSubjectNames([source], userId);
      const shell = toReactionEventShell(
        source,
        actorNameById,
        subjectNameByKey
      );
      const reactions = await buildFanout(source);
      shell.reactions = filterReactionsByLens(
        reactions,
        input.lens as ReactionLens
      );

      return shell;
    }),
});
