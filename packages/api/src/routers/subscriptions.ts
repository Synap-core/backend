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
  eq,
  and,
  gte,
  lte,
  inArray,
} from "@synap/database";
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

/**
 * Map a single event record into a ReactionEvent shell (no reactions yet).
 */
function toReactionEventShell(
  event: EventRecord,
  actorNameById: Map<string, string>
): ReactionEvent {
  return {
    id: event.id,
    type: event.eventType,
    timestamp: event.timestamp.toISOString(),
    subject: deriveSubject(event),
    subjectId: event.subjectId,
    subjectType: event.subjectType,
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
        /**
         * Decision-inbox filter: when true, return only `.requested` events
         * whose linked proposal is still pending (awaiting approve/reject).
         */
        pending: z.boolean().optional(),
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
      const actorNameById = await resolveActorNames(actorIds);

      // Keep the REAL EventRecord paired with each shell so the kind facet can
      // classify off the actual event (source + data), not a synthetic shell.
      // A synthetic record with source:"" / data:{} blanks deriveActorAI and
      // would make `ai_react` / AI kinds never match.
      const mapped = filtered.map((e) => ({
        event: e,
        shell: toReactionEventShell(e, actorNameById),
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
      // their own type (the dense fan-out filter happens in eventFanout).
      // If `pending` is set, narrow to the decision inbox (open proposals).
      const final = mapped
        .filter((m) => (input.kind ? m.kind === input.kind : true))
        .filter((m) => (input.pending ? m.shell.pending === true : true))
        .map((m) => m.shell);

      return { items: final, lens: input.lens as ReactionLens };
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

      const shell = toReactionEventShell(source, actorNameById);
      const reactions = await buildFanout(source);
      shell.reactions = filterReactionsByLens(
        reactions,
        input.lens as ReactionLens
      );

      return shell;
    }),
});
