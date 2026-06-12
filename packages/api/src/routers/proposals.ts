/**
 * Universal Proposals Router
 *
 * Handles listing, approving, and rejecting proposals for ALL entity types.
 * Replaces legacy document_proposals logic.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import type { Context } from "../context.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  EventRepository,
  proposals,
  documents,
  documentVersions,
  eq,
  and,
  or,
  desc,
  inArray,
  isNull,
  isNotNull,
  gt,
  lt,
  entities,
  users,
  getWorkspaceMembership,
  normalizeDocumentType,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  ProfileResolutionService,
  sql,
} from "@synap/database";
import type { EventRecord } from "@synap/database";
import { ProposalStatus, workspaces } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import type {
  ProposalReviewChange,
  ProposalReviewEvent,
  ProposalReviewModel,
  StoredProposalData,
  ProposalMaterializedRecord,
} from "@synap-core/types";
import {
  isDocumentContentProposalData,
  isRequestShapedProposalData,
  isCompositeProposalData,
  buildRequestFromProposal,
  buildFallbackTitle,
  isLikelyUUID,
  opRef,
} from "@synap-core/types/proposals";
import type {
  UpdateRequest,
  ProposalReviewGraph,
  CompositeProposalData,
  CompositeCreateEntityOp,
  CompositeCreateRelationOp,
} from "@synap-core/types/proposals";
import { storage } from "@synap/storage";
import { requireUserId } from "../utils/user-scoped.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { auditLog } from "../utils/audit-log.js";
import { createEventBackedProposal } from "../utils/event-backed-proposal.js";
import { materializeCompositeGraph } from "../utils/materialize-composite.js";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "../utils/intelligence-routing.js";
import { channelsRouter } from "./channels.js";
import { entitiesRouter as regularEntitiesRouter } from "./entities.js";
import { relationsRouter } from "./relations.js";
import { documentsRouter } from "./documents.js";
import { messages } from "@synap/database/schema";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { notifications } from "@synap/database/schema";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";

const logger = createLogger({ module: "proposals" });

/**
 * Fire-and-forget: mark the corresponding notification row as 'actioned'
 * when a proposal is approved or rejected. Uses the source index on
 * (sourceType, sourceId) for efficient lookup.
 */
function markProposalNotificationActioned(proposalId: string): void {
  db.update(notifications)
    .set({ status: "actioned", readAt: new Date() })
    .where(
      and(
        eq(notifications.sourceType, "proposal"),
        eq(notifications.sourceId, proposalId)
      )
    )
    .then(() => {
      logger.debug({ proposalId }, "Proposal notification marked as actioned");
    })
    .catch((err) => {
      // Non-fatal — notifications must never break the proposal flow
      logger.warn(
        { err, proposalId },
        "Failed to mark proposal notification as actioned (non-fatal)"
      );
    });
}

/**
 * Fire-and-forget: notify connected clients that a proposal was reviewed.
 * The bell panel uses this to remove the item immediately without a refetch.
 * Also enqueues automation-trigger-match for the proposal_event trigger type.
 */
function emitProposalReviewed(
  proposalId: string,
  workspaceId: string | null | undefined,
  status: "approved" | "rejected",
  userId?: string
): void {
  if (!workspaceId) return;
  emitChatEvent({
    event: "proposal:reviewed",
    data: { proposalId, status, workspaceId },
    workspaceId,
  });
  // Automation side-effects: proposal.approved.completed / proposal.rejected.completed
  emitSideEffects({
    subjectType: "proposal",
    action: status,
    subjectId: proposalId,
    userId: userId ?? "",
    workspaceId,
    data: { proposalStatus: status },
  });
  // Mark the corresponding notification as actioned (fire-and-forget)
  markProposalNotificationActioned(proposalId);
  // Notify the originating channel so waiting agents can continue (fire-and-forget)
  enqueueProposalReviewedNotify(proposalId, status);
}

/**
 * Fire-and-forget: enqueue a pg-boss job that posts a status message back to
 * the channel where the proposal originated, so agents waiting for approval
 * can resume work.
 */
function enqueueProposalReviewedNotify(
  proposalId: string,
  status: string
): void {
  void (async () => {
    try {
      await getBoss().send("proposal-reviewed-notify", { proposalId, status });
    } catch (err) {
      logger.warn(
        { err, proposalId },
        "Failed to enqueue proposal-reviewed-notify (non-fatal)"
      );
    }
  })();
}

/**
 * Fire-and-forget: report a proposal outcome to the IS telemetry endpoint.
 * The IS records a Langfuse score on the originating conversation trace.
 * Never awaited — never throws — never blocks the user response.
 */
function reportProposalOutcome(params: {
  proposalId: string;
  outcome: "approved" | "rejected";
  sourceMessageId: string | null | undefined;
  agentUserId: string | null | undefined;
  targetType: string | null | undefined;
}): void {
  const internalKey = process.env.INTELLIGENCE_HUB_INTERNAL_KEY;
  if (!internalKey || !params.agentUserId) return; // only track AI proposals

  void (async () => {
    try {
      // Resolve hub endpoint from DB (registered IS) rather than env vars
      const { endpoint: hubUrl } = await getDefaultActiveService();

      // Resolve channelId (= Langfuse traceId) from sourceMessageId
      let traceId: string | undefined;
      if (params.sourceMessageId) {
        const [msg] = await db
          .select({ channelId: messages.channelId })
          .from(messages)
          .where(eq(messages.id, params.sourceMessageId))
          .limit(1);
        traceId = msg?.channelId ?? undefined;
      }

      await fetch(`${hubUrl}/api/internal/telemetry/proposal-outcome`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": internalKey,
        },
        body: JSON.stringify({
          traceId,
          proposalId: params.proposalId,
          outcome: params.outcome,
          targetType: params.targetType,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      // Non-fatal — telemetry must never affect proposal approval UX
      logger.warn(
        { err, proposalId: params.proposalId },
        "Failed to report proposal outcome to IS telemetry"
      );
    }
  })();
}

type ProposalRow = typeof proposals.$inferSelect;
type DisplayEnrichedProposal = ProposalRow & {
  request: UpdateRequest;
  authorName?: string;
  targetName?: string;
  review: ProposalReviewModel;
};

type ProposalApprovalPolicy = "admins_only" | "any_editor" | "owner_and_admins";

/**
 * Single source of truth for "may this member review (approve / reject / revert)
 * this workspace-scoped proposal?" — the SAME ladder that `approve`,
 * `batchApprove`, `revert`, and the list's `viewerCanReview` flag all read, so
 * the button shows iff the mutation would succeed. Pod-wide proposals (no
 * workspace) skip this entirely and are decided by the caller.
 */
function canReviewProposal(args: {
  policy: ProposalApprovalPolicy;
  memberRole: string | undefined;
  isOwner: boolean;
}): boolean {
  const isAdmin = args.memberRole === "admin";
  const isEditor = args.memberRole === "editor" || isAdmin;
  return args.policy === "admins_only"
    ? isAdmin
    : args.policy === "any_editor"
      ? isEditor
      : /* owner_and_admins */ args.isOwner || isAdmin;
}

async function enrichProposalsForDisplay(
  rows: ProposalRow[],
  userId: string
): Promise<DisplayEnrichedProposal[]> {
  const requests = rows.map((row) => buildRequestFromProposal(row));
  const entityIds = uniqueStrings(
    requests
      .filter((request) => request.targetType === "entity")
      .map((request) => request.targetId)
      .filter(isLikelyUUID)
  );
  const userIds = uniqueStrings(
    rows.flatMap((row, idx) => [
      row.agentUserId ?? undefined,
      row.createdBy ?? undefined,
      requests[idx]?.sourceId || undefined,
    ])
  );
  // correlation_id is a uuid column — clamp to valid uuids so the batch query's
  // ::uuid[] cast can't throw on a legacy non-uuid value.
  const correlationIds = uniqueStrings(
    requests.map((request) => request.correlationId)
  ).filter(isLikelyUUID);

  const eventRepo = new EventRepository(sql);
  const [entityRows, userRows, traceEntries] = await Promise.all([
    entityIds.length > 0
      ? db
          .select({
            id: entities.id,
            title: entities.title,
            preview: entities.preview,
            type: entities.type,
            properties: entities.properties,
          })
          .from(entities)
          .where(inArray(entities.id, entityIds))
      : Promise.resolve([]),
    userIds.length > 0
      ? db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(inArray(users.id, userIds))
      : Promise.resolve([]),
    // ONE batched query for ALL correlation ids on this page (was N+1: one
    // round-trip per proposal → pool exhaustion). Grouped in memory below.
    correlationIds.length > 0
      ? eventRepo
          .getCorrelatedEventsBatch(correlationIds, userId)
          .then((events) => {
            const grouped = new Map<string, EventRecord[]>();
            for (const ev of events) {
              const key = ev.correlationId;
              if (!key) continue;
              const bucket = grouped.get(key);
              if (bucket) bucket.push(ev);
              else grouped.set(key, [ev]);
            }
            return Array.from(grouped.entries()) as Array<
              readonly [string, EventRecord[]]
            >;
          })
      : Promise.resolve([] as Array<readonly [string, EventRecord[]]>),
  ]);

  const entityById = new Map(entityRows.map((row) => [row.id, row]));
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const traceByCorrelationId = new Map<string, EventRecord[]>(traceEntries);

  return rows.map((row, idx) => {
    const request = requests[idx]!;
    const payload =
      request.data && typeof request.data === "object"
        ? request.data
        : undefined;
    const entityMeta = entityById.get(request.targetId);
    const targetName =
      request.targetName ??
      displayLabelFromRecord(payload) ??
      entityMeta?.title ??
      entityMeta?.preview ??
      undefined;
    const profileSlug =
      stringProp(payload, "profileSlug") ??
      stringProp(payload, "type") ??
      entityMeta?.type ??
      undefined;
    const authorRow = userById.get(
      row.agentUserId ?? row.createdBy ?? request.sourceId
    );
    const authorName = authorRow ? displayNameForUser(authorRow) : undefined;
    const summary =
      request.summary ??
      buildFallbackTitle({
        changeType: request.changeType,
        profileSlug,
        targetType: request.targetType,
        targetName,
      });

    return {
      ...row,
      authorName,
      targetName,
      request: {
        ...request,
        targetName,
        summary,
      },
      review: buildProposalReviewModel({
        row,
        request: {
          ...request,
          targetName,
          summary,
        },
        authorName,
        targetName,
        current: entityMeta,
        events: request.correlationId
          ? (traceByCorrelationId.get(request.correlationId) ?? [])
          : [],
      }),
    };
  });
}

function buildProposalReviewModel(params: {
  row: ProposalRow;
  request: UpdateRequest;
  authorName?: string;
  targetName?: string;
  /** Current state of the target entity (for update before→after diffs). */
  current?: {
    title?: string | null;
    preview?: string | null;
    type?: string | null;
    properties?: unknown;
  };
  events: Awaited<ReturnType<EventRepository["getCorrelatedEvents"]>>;
}): ProposalReviewModel {
  const { row, request, authorName, targetName, current, events } = params;
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  // Composite (graph) proposals store `{ operations: [...] }` in row.data, which
  // the flat `changes` model can't express. Detect and build a `graph` instead.
  const rawData = row.data as StoredProposalData | null | undefined;
  const graph = isCompositeProposalData(rawData)
    ? buildProposalGraph(rawData)
    : undefined;
  const reviewEvents = events.map(toProposalReviewEvent);
  const requestedEvent =
    reviewEvents.find((event) => event.phase === "requested") ??
    reviewEvents.find((event) => event.eventType.endsWith(".requested"));
  const validatedEvent =
    reviewEvents.find((event) => event.phase === "validated") ??
    reviewEvents.find((event) => event.eventType.endsWith(".validated"));
  const completedEvent =
    reviewEvents.find((event) => event.phase === "completed") ??
    reviewEvents.find((event) => event.eventType.endsWith(".completed"));

  return {
    summary:
      request.summary ??
      buildFallbackTitle({
        changeType: request.changeType,
        targetType: request.targetType,
        targetName,
      }),
    actorName: authorName,
    targetName,
    reasoning: request.reasoning,
    source: request.source,
    sourceId: request.sourceId,
    sourceMessageId: row.sourceMessageId,
    threadId: row.threadId,
    commandRunId: row.commandRunId,
    correlationId: request.correlationId,
    requestedEventId: request.requestedEventId ?? requestedEvent?.eventId,
    validatedEventId: request.validatedEventId ?? validatedEvent?.eventId,
    completedEventId: request.completedEventId ?? completedEvent?.eventId,
    changes: buildProposalChanges(requestData, request.changeType, current),
    ...(graph ? { graph } : {}),
    events: reviewEvents,
  };
}

/**
 * Build the reviewable graph for a composite proposal.
 *
 * Pass 1: walk the create_entity ops, assigning each a stable ref (its own `ref`
 * or the positional `$opN`) and recording ref→title so relations can show human
 * labels. Pass 2: map each create_relation's source/target refs to those titles;
 * a ref that is a real UUID (a pre-existing entity, not created here) gets a
 * short `entity <8hex>` label.
 *
 * Emits the PINNED ProposalReviewGraph contract — keep in sync with the frontend.
 */
function buildProposalGraph(data: CompositeProposalData): ProposalReviewGraph {
  const refToTitle = new Map<string, string>();
  const entities: ProposalReviewGraph["entities"] = [];

  data.operations.forEach((op, index) => {
    if (op.op !== "create_entity") return;
    const entityOp = op as CompositeCreateEntityOp;
    const ref = entityOp.ref ?? opRef(index);
    const title = entityOp.title ?? "Untitled";
    refToTitle.set(ref, title);
    // Positional ref always resolves too (a relation may reference $opN even
    // when the op carries its own ref).
    refToTitle.set(opRef(index), title);
    entities.push({
      ref,
      profileSlug: entityOp.profileSlug,
      title,
      propertyCount: Object.keys(entityOp.properties ?? {}).length,
      hasContent: !!entityOp.content,
    });
  });

  const labelForRef = (ref: string): string => {
    const known = refToTitle.get(ref);
    if (known) return known;
    if (isLikelyUUID(ref)) return `entity ${ref.slice(0, 8)}`;
    return ref;
  };

  const relations: ProposalReviewGraph["relations"] = [];
  for (const op of data.operations) {
    if (op.op !== "create_relation") continue;
    const relOp = op as CompositeCreateRelationOp;
    relations.push({
      type: relOp.type,
      sourceLabel: labelForRef(relOp.sourceRef),
      targetLabel: labelForRef(relOp.targetRef),
    });
  }

  return {
    entities,
    relations,
    entityCount: entities.length,
    relationCount: relations.length,
  };
}

function toProposalReviewEvent(event: {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  timestamp: Date;
  userId: string;
  source?: string;
  correlationId?: string;
}): ProposalReviewEvent {
  const parts = event.eventType.split(".");
  return {
    eventId: event.id,
    eventType: event.eventType,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    action: parts.length >= 2 ? parts[1] : undefined,
    phase: parts.length >= 3 ? parts[2] : undefined,
    timestamp: event.timestamp.toISOString(),
    userId: event.userId,
    source: event.source,
    correlationId: event.correlationId,
  };
}

function buildProposalChanges(
  data: Record<string, unknown>,
  changeType: string,
  current?: {
    title?: string | null;
    preview?: string | null;
    type?: string | null;
    properties?: unknown;
  }
): ProposalReviewChange[] {
  const changes: ProposalReviewChange[] = [];
  const operation =
    changeType === "delete"
      ? "delete"
      : changeType === "create"
        ? "create"
        : "update";

  // Current-state lookup so update diffs show before→after (not just after).
  // Maps each proposed top-level field to the matching entity column.
  const currentProps =
    current?.properties && typeof current.properties === "object"
      ? (current.properties as Record<string, unknown>)
      : {};
  const beforeFor = (key: string): unknown => {
    if (operation !== "update" || !current) return undefined;
    if (key === "title") return current.title ?? undefined;
    if (key === "description") return current.preview ?? undefined;
    if (key === "profileSlug") return current.type ?? undefined;
    return undefined;
  };

  for (const key of ["title", "description", "profileSlug", "documentId"]) {
    if (data[key] !== undefined) {
      changes.push({
        path: key,
        label: labelFromPath(key),
        operation,
        before: beforeFor(key),
        after: data[key],
        valueType: valueTypeOf(data[key]),
      });
    }
  }

  const properties =
    data.properties && typeof data.properties === "object"
      ? (data.properties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(properties)) {
    changes.push({
      path: `properties.${key}`,
      label: labelFromPath(key),
      operation,
      before: operation === "update" ? currentProps[key] : undefined,
      after: value,
      valueType: valueTypeOf(value),
    });
  }

  return changes;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

function stringProp(
  record: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function displayLabelFromRecord(
  record: Record<string, unknown> | undefined
): string | undefined {
  return (
    stringProp(record, "title") ??
    stringProp(record, "name") ??
    stringProp(record, "displayName") ??
    stringProp(record, "label")
  );
}

function displayNameForUser(row: {
  name: string | null;
  email: string;
  userType: string;
  agentMetadata: { agentType?: string; description?: string } | null;
}): string | undefined {
  if (row.name) return row.name;
  if (row.userType === "agent") {
    return row.agentMetadata?.agentType ?? row.agentMetadata?.description;
  }
  return row.email || undefined;
}

function labelFromPath(path: string): string {
  return path
    .replace(/^properties\./, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function valueTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Revert planning (pure — no DB, fully unit-testable)
// ---------------------------------------------------------------------------

/**
 * The concrete inverse a `revert` must apply. Either a list of soft-deletes /
 * deletes of the rows the proposal created, or `unsupported` with a loud reason.
 *
 * Effect verbs:
 *   - "delete-creations" → the proposal CREATED rows; the inverse is to delete
 *     them (entities/relations/documents the approval produced).
 *
 * Update/edit proposals carry no recoverable before-snapshot, so reverting them
 * is `unsupported` and the mutation FAILS LOUD rather than fabricating a state.
 */
export type ProposalRevertPlan =
  | {
      kind: "delete-creations";
      entityIds: string[];
      relationIds: string[];
      documentIds: string[];
    }
  | { kind: "unsupported"; reason: string };

/**
 * Minimal projection of a proposal row the planner needs. Keeps the planner
 * decoupled from drizzle's `$inferSelect` so it can be unit-tested with a
 * plain object.
 */
export interface RevertPlannerInput {
  status: string;
  targetType: string;
  targetId: string;
  proposalType: string;
  data: unknown;
}

/**
 * Decide the inverse of an approved proposal, reading ONLY the proposal's own
 * stored data — no schema change. The created ids come from:
 *   - `data.materialized.{entityIds,relationIds,documentIds}` — the canonical
 *     record the approve flow stamps (REQUIRED for inline-create + composite,
 *     whose ids are minted fresh and are otherwise unrecoverable);
 *   - falling back to `targetId` for the branches whose materialized id is the
 *     proposal target itself (generic `.validated` create where subjectId is the
 *     target; document create where documentId === targetId).
 *
 * Returns `unsupported` (→ fail loud) for update/edit proposals (no before-state)
 * and for anything we cannot positively map to created rows.
 */
export function planProposalRevert(
  proposal: RevertPlannerInput
): ProposalRevertPlan {
  const data =
    proposal.data && typeof proposal.data === "object"
      ? (proposal.data as StoredProposalData)
      : undefined;
  const materialized = data?.materialized;

  // Normalize the change kind. proposalType is a free string ("create",
  // "update", "edit", "delete", "create_branch", …) and request-shaped data
  // carries a `changeType`. Prefer changeType, fall back to proposalType.
  const changeType =
    (data && isRequestShapedProposalData(data) ? data.changeType : undefined) ??
    proposal.proposalType;
  const isCreate =
    proposal.proposalType === "create" ||
    changeType === "create" ||
    isCompositeProposalData(data ?? null);
  const isUpdate =
    !isCreate &&
    (proposal.proposalType === "update" ||
      proposal.proposalType === "edit" ||
      proposal.proposalType === "user_edit" ||
      changeType === "update");
  const isDelete =
    !isCreate &&
    !isUpdate &&
    (proposal.proposalType === "delete" || changeType === "delete");

  // Update/edit: reverting needs the BEFORE-state, which is NOT persisted
  // anywhere on the row (the review enrich computes a before→after diff at read
  // time from the live entity, but the pre-approval snapshot is gone). Fail loud
  // rather than fabricate.
  if (isUpdate) {
    return {
      kind: "unsupported",
      reason:
        "Revert of an update/edit proposal is not supported without a before-snapshot (none is persisted on the proposal).",
    };
  }

  // Delete/archive: undoing a delete means RESTORING the target. Entity deletes
  // in this codebase are HARD deletes (no soft-delete row survives), so there is
  // nothing to restore — fail loud rather than silently no-op.
  if (isDelete) {
    return {
      kind: "unsupported",
      reason:
        "Revert of a delete proposal is not supported: deletes are hard-deletes with no recoverable before-snapshot to restore.",
    };
  }

  if (isCreate) {
    const entityIds = [...(materialized?.entityIds ?? [])];
    const relationIds = [...(materialized?.relationIds ?? [])];
    const documentIds = [...(materialized?.documentIds ?? [])];

    // Fallback for branches whose created id IS the proposal target and which
    // therefore may not have stamped `materialized` (generic `.validated` entity
    // create; document create where documentId === targetId).
    if (
      entityIds.length === 0 &&
      relationIds.length === 0 &&
      documentIds.length === 0
    ) {
      if (proposal.targetType === "entity" && proposal.targetId) {
        entityIds.push(proposal.targetId);
      } else if (proposal.targetType === "document" && proposal.targetId) {
        documentIds.push(proposal.targetId);
      }
    }

    if (
      entityIds.length === 0 &&
      relationIds.length === 0 &&
      documentIds.length === 0
    ) {
      return {
        kind: "unsupported",
        reason: `Revert of a '${proposal.targetType}' create proposal is not supported: no materialized record of created rows.`,
      };
    }

    return { kind: "delete-creations", entityIds, relationIds, documentIds };
  }

  return {
    kind: "unsupported",
    reason: `Revert of proposal type '${proposal.targetType}/${proposal.proposalType}' is not supported.`,
  };
}

export const proposalsRouter = router({
  /**
   * List proposals (Inbox)
   * Can be filtered by workspace, targetType, or specific targetId
   */
  list: protectedProcedure
    .input(
      paginatedInput.extend({
        /**
         * Workspace filter — three-state:
         *   - `string`     → only proposals for that workspace
         *   - `null`       → only pod-wide proposals (workspaceId IS NULL)
         *                    used by the Pod Admin Overview which previously
         *                    fetched all proposals and filtered client-side
         *   - `undefined`  → no filter (every workspace + pod-wide)
         */
        workspaceId: z.string().nullish(),
        targetType: z
          .enum(["document", "entity", "whiteboard", "view", "profile"])
          .optional(),
        targetId: z.string().optional(),
        /** Filter to proposals originating from a specific chat thread */
        threadId: z.string().uuid().optional(),
        /** Filter to proposals linked to a specific focus session via correlationId */
        correlationId: z.string().optional(),
        /** Filter to proposals linked to a specific focus session via session_id FK */
        sessionId: z.string().uuid().optional(),
        /** Filter to proposals created by a specific agent */
        agentUserId: z.string().optional(),
        /** When true, only return proposals where agentUserId is not null */
        agentOnly: z.boolean().optional(),
        /** When true, include expired proposals (expiresAt in the past) */
        includeExpired: z.boolean().optional(),
        status: z
          .enum(["pending", "validated", "rejected", "all"])
          .default("pending"),
        /** Cursor-based pagination: ISO timestamp of the last item's createdAt */
        cursor: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions = [];

      // Filter by Workspace (Security Boundary)
      // Three-state: string = that workspace, null = pod-wide only,
      // undefined = no filter (return all).
      if (input.workspaceId === null) {
        conditions.push(isNull(proposals.workspaceId));
      } else if (typeof input.workspaceId === "string") {
        conditions.push(eq(proposals.workspaceId, input.workspaceId));
      } else {
        // undefined = user-wide queue. Scope to workspaces the caller belongs
        // to (+ pod-wide globals) — WITHOUT this, list leaks every workspace's
        // proposals (and their data payloads) to any authenticated user.
        conditions.push(
          userVisibleWhere(proposals.workspaceId, requireUserId(ctx.userId))
        );
      }

      if (input.targetType) {
        conditions.push(eq(proposals.targetType, input.targetType));
      }

      if (input.targetId) {
        conditions.push(eq(proposals.targetId, input.targetId));
      }

      if (input.agentUserId) {
        conditions.push(eq(proposals.agentUserId, input.agentUserId));
      }

      if (input.agentOnly) {
        conditions.push(isNotNull(proposals.agentUserId));
      }

      if (input.threadId) {
        conditions.push(eq(proposals.threadId, input.threadId));
      }

      /** Filter to proposals with a specific correlationId (used to link back to focus sessions) */
      if (input.correlationId) {
        conditions.push(eq(proposals.correlationId, input.correlationId));
      }

      if (input.sessionId) {
        conditions.push(eq(proposals.sessionId, input.sessionId));
      }

      if (input.status === "pending") {
        conditions.push(eq(proposals.status, ProposalStatus.PENDING));
      } else if (input.status === "validated") {
        // "Approved" tab = applied proposals: BOTH human-approved AND
        // auto-approved (both are revertable, and the board's count folds
        // them together). Auto-approved AI mutations are the primary revert
        // target, so they must surface here, not only under "All".
        conditions.push(
          inArray(proposals.status, [
            ProposalStatus.APPROVED,
            ProposalStatus.AUTO_APPROVED,
          ])
        );
      } else if (input.status === "rejected") {
        conditions.push(eq(proposals.status, ProposalStatus.REJECTED));
      }

      // Exclude expired proposals unless caller explicitly requests them
      if (!input.includeExpired) {
        conditions.push(
          or(isNull(proposals.expiresAt), gt(proposals.expiresAt, new Date()))!
        );
      }

      // Verify user has editor+ access to the workspace
      if (input.workspaceId) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, requireUserId(ctx.userId))
          ),
        });
        if (
          !membership ||
          !["owner", "admin", "editor"].includes(membership.role)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Editor or higher role required to view proposals",
          });
        }
      }

      // Cursor-based pagination: when cursor is provided, add a createdAt < cursor
      // condition and ignore offset.
      if (input.cursor) {
        conditions.push(lt(proposals.createdAt, new Date(input.cursor)));
      }

      const rows = await db.query.proposals.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [desc(proposals.createdAt), desc(proposals.id)],
        limit: input.limit + 1,
        offset: input.cursor ? 0 : input.offset,
      });

      // Enrich each proposal with a pre-formed `request` object and resolved
      // display metadata. Eve/Studio can render useful labels without leaking
      // raw UUIDs into the main review surface.
      const reviewerId = requireUserId(ctx.userId);
      const enriched = await enrichProposalsForDisplay(rows, reviewerId);

      const { items, pagination } = buildPaginatedResponse(enriched, input);

      // viewerCanReview — per proposal, "can this user approve / reject / revert
      // it?" computed from the SAME ladder the mutations enforce, so the UI shows
      // review actions (Approve, Revert) iff the call would succeed. Batched:
      // one workspace-settings query + one membership query across all distinct
      // workspaces in the page. Pod-wide proposals (no workspace) are reviewable.
      const wsIds = [
        ...new Set(
          rows.map((r) => r.workspaceId).filter((w): w is string => Boolean(w))
        ),
      ];
      const policyByWs = new Map<string, ProposalApprovalPolicy>();
      const roleByWs = new Map<string, string>();
      if (wsIds.length > 0) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const wsRows = await db
          .select({ id: workspaces.id, settings: workspaces.settings })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds));
        for (const w of wsRows) {
          const s = w.settings as WorkspaceSettings | undefined;
          policyByWs.set(
            w.id,
            (s?.aiGovernance?.proposalApprovalPolicy ??
              "owner_and_admins") as ProposalApprovalPolicy
          );
        }
        const memberRows = await db.query.workspaceMembers.findMany({
          where: and(
            eq(workspaceMembers.userId, reviewerId),
            inArray(workspaceMembers.workspaceId, wsIds)
          ),
        });
        for (const m of memberRows) roleByWs.set(m.workspaceId, m.role);
      }
      // Compute over the typed `rows` (not the casted enriched items) so the
      // workspaceId/data reads are compiler-checked and can't silently break if
      // enrichment ever reshapes the display payload.
      const viewerCanReviewById = new Map<string, boolean>();
      for (const r of rows) {
        const data = r.data as Record<string, unknown> | null;
        viewerCanReviewById.set(
          r.id,
          !r.workspaceId
            ? true
            : canReviewProposal({
                policy: policyByWs.get(r.workspaceId) ?? "owner_and_admins",
                memberRole: roleByWs.get(r.workspaceId),
                isOwner: data?.sourceId === reviewerId,
              })
        );
      }
      const itemsWithPermission = items.map((it) => {
        const viewerCanReview = viewerCanReviewById.get(it.id) ?? false;
        return { ...it, viewerCanReview };
      });

      const nextCursor =
        pagination.hasMore && itemsWithPermission.length > 0
          ? itemsWithPermission[
              itemsWithPermission.length - 1
            ]!.createdAt.toISOString()
          : undefined;

      return {
        items: itemsWithPermission,
        pagination: { ...pagination, nextCursor },
        /** @deprecated Use `items` instead */
        proposals: itemsWithPermission,
      };
    }),

  /**
   * Fetch a single proposal by ID.
   *
   * Used by the Studio's /proposals/:id detail page — the destination of the
   * `reviewUrl` returned on every `"status": "proposed"` response. Enforces
   * the same workspace-access check as `list` (editor or higher).
   */
  get: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .query(async ({ input, ctx }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
      });

      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      // Workspace access check
      if (proposal.workspaceId) {
        const { workspaceMembers } = await import("@synap/database/schema");
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, proposal.workspaceId),
            eq(workspaceMembers.userId, userId)
          ),
        });
        if (
          !membership ||
          !["owner", "admin", "editor"].includes(membership.role)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Editor or higher role required to view this proposal",
          });
        }
      } else {
        // Pod-wide proposal (no workspaceId) — only the proposer can see it
        const proposalData = proposal.data as Record<string, unknown> | null;
        if (proposalData?.sourceId !== userId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not authorized to view this proposal",
          });
        }
      }

      return {
        ...(await enrichProposalsForDisplay([proposal], userId))[0],
      };
    }),

  /**
   * Approve a proposal
   * For hub-created document proposals (AI edit): applies proposedContent to storage + DB.
   * For other proposals: emits the original request event as *.validated.
   */
  approve: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
      });

      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      // Ownership check: who can approve this proposal?
      if (proposal.workspaceId) {
        const [ws] = await db
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, proposal.workspaceId))
          .limit(1);

        const settings = ws?.settings as WorkspaceSettings | undefined;
        const policy =
          settings?.aiGovernance?.proposalApprovalPolicy ?? "owner_and_admins";

        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId,
          userId
        );
        const proposalData = proposal.data as Record<string, unknown> | null;

        const canApprove = canReviewProposal({
          policy: policy as ProposalApprovalPolicy,
          memberRole: membership?.role,
          isOwner: proposalData?.sourceId === userId,
        });

        if (!canApprove) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not authorized to approve this proposal",
          });
        }
      }

      const payload = proposal.data as StoredProposalData | null | undefined;

      // B0: Composite (multi-op) GRAPH proposal — one approval creates N
      // entities AND M relations among them, atomically validated as a unit
      // (e.g. an imported note graph, or a Question + links to its captures).
      // Checked BEFORE the single-op branches. Pass 1 creates every
      // create_entity op via the canonical entity path (full side effects),
      // building a ref→realId map; pass 2 creates relations resolving each
      // sourceRef/targetRef ($opN / op `ref` / PRIMARY_REF / real UUID).
      // Linking is best-effort — an individual relation failure is logged but
      // never discards the (valid) created entities.
      if (isCompositeProposalData(payload)) {
        let compositeCtx: {
          db: typeof db;
          authenticated: true;
          userId: string;
          workspaceId: string | null;
          workspaceRole: string;
        };
        if (proposal.workspaceId) {
          const membership = await getWorkspaceMembership(
            db,
            proposal.workspaceId,
            userId
          );
          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "No workspace access",
            });
          }
          compositeCtx = {
            db,
            authenticated: true as const,
            userId,
            workspaceId: proposal.workspaceId,
            workspaceRole: membership.role,
          };
        } else {
          compositeCtx = {
            db,
            authenticated: true as const,
            userId,
            workspaceId: null,
            workspaceRole: "owner",
          };
        }

        const entityCaller = regularEntitiesRouter.createCaller(
          compositeCtx as unknown as Context
        );
        const relationCaller = relationsRouter.createCaller(
          compositeCtx as unknown as Context
        );

        // Shared materialization: N entities → ref map → M relations.
        // Same logic the user-import (/import/apply) path uses.
        const {
          created: createdCount,
          linked,
          primaryId,
          entities: createdEntities,
        } = await materializeCompositeGraph(
          payload.operations,
          entityCaller,
          relationCaller,
          (err, type) =>
            logger.warn(
              { err, type },
              "composite proposal: relation create failed (entities kept)"
            ),
          // Workspace-scoped imports must pin their entities to the target
          // workspace on approval (overriding pod-default profile entityScope),
          // mirroring rest/capture.ts /import/apply. Only when the proposal is
          // workspace-bound; interactive pod-default approvals stay global.
          proposal.workspaceId ? { workspaceScoped: true } : undefined
        );

        // Record what we materialized so `revert` can compute the inverse.
        // Only entities CREATED here (not pre-existing linked ones) are ours to
        // undo. Relation ids aren't returned by the materializer, so revert of a
        // composite undoes the created entities (the cascade removes the
        // relations touching them).
        const compositeMaterialized: ProposalMaterializedRecord = {
          entityIds: createdEntities
            .filter((entity) => !entity.linked)
            .map((entity) => entity.entityId),
        };
        const compositePayload: StoredProposalData = {
          ...payload,
          materialized: compositeMaterialized,
        };

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            data: compositePayload,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true, primaryId, created: createdCount, linked };
      }

      // B3: Document content proposal (hub/chat/user_edit) – apply content directly
      if (
        proposal.targetType === "document" &&
        isDocumentContentProposalData(payload)
      ) {
        const { storage } = await import("@synap/storage");
        const { documents, documentVersions } =
          await import("@synap/database/schema");

        const document = await db.query.documents.findFirst({
          where: eq(documents.id, proposal.targetId),
        });

        if (!document?.storageKey) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Document not found or has no storage key",
          });
        }

        const newVersion = (document.currentVersion ?? 1) + 1;
        const content = payload.proposedContent;

        await storage.upload(
          document.storageKey,
          Buffer.from(content, "utf-8"),
          { contentType: document.mimeType || "text/plain" }
        );
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId,
          documentId: proposal.targetId,
          versionId,
          documentType: document.type,
          mimeType: document.mimeType || "text/plain",
          content,
        });

        await db.insert(documentVersions).values({
          id: versionId,
          documentId: proposal.targetId,
          version: newVersion,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: userId,
          message: "AI edit accepted",
        });

        await db
          .update(documents)
          .set({
            currentVersion: newVersion,
            lastSavedVersion: newVersion,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, proposal.targetId));

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Document creation proposal: AI proposed a new document (content stored in JSONB).
      // Upload content to MinIO and insert DB row now that the user approved.
      if (
        proposal.targetType === "document" &&
        proposal.proposalType === "create"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const documentId = proposal.targetId;
        const docType = normalizeDocumentType(
          (data.type as string) || "markdown",
          "markdown"
        );
        const extension = docType === "markdown" ? "md" : docType;
        const content = (data.content as string) || "";
        const docUserId = (data.userId as string) || userId;
        const storageKey = storage.buildPath(
          docUserId,
          "document",
          documentId,
          extension
        );
        const mimeType =
          docType === "html"
            ? "text/html"
            : docType === "code"
              ? "text/plain"
              : "text/markdown";
        const metadata = await storage.upload(storageKey, content, {
          contentType: mimeType,
        });
        const versionId = randomUUID();
        const snapshot = await uploadDocumentVersionSnapshot({
          userId: docUserId,
          documentId,
          versionId,
          documentType: docType,
          mimeType: "text/markdown",
          content,
        });

        await db.insert(documents).values({
          id: documentId,
          title: (data.title as string) || "Untitled",
          type: docType,
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId: docUserId,
          workspaceId: proposal.workspaceId,
          currentVersion: 1,
          lastSavedVersion: 1,
        });

        await db.insert(documentVersions).values({
          id: versionId,
          documentId,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: userId,
          message: "Initial version",
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Branch creation proposal: AI proposed creating a branch.
      // Execute via channelsRouter now that the user approved.
      if (
        proposal.targetType === "channel" &&
        proposal.proposalType === "create_branch"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const branchWorkspaceId = proposal.workspaceId || null;
        if (!branchWorkspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Proposal is missing a valid workspaceId",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          branchWorkspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const branchCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: branchWorkspaceId,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(branchCallerCtx);
        await caller.createChannel({
          parentChannelId: data.parentChannelId as string,
          branchPurpose: data.branchPurpose as string,
          agentId: data.agentId as string | undefined,
          agentConfig: data.agentConfig as Record<string, unknown> | undefined,
          inheritContext: (data.inheritContext as boolean) ?? true,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Branch merge proposal: AI proposed merging a branch.
      // The user must always validate a merge — execute now that they approved.
      if (
        proposal.targetType === "channel" &&
        proposal.proposalType === "merge_branch"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const mergeWorkspaceId = proposal.workspaceId || null;
        if (!mergeWorkspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Proposal is missing a valid workspaceId",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          mergeWorkspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const mergeCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: mergeWorkspaceId,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(mergeCallerCtx);
        await caller.mergeBranch({
          branchId: data.branchId as string,
          summary: data.summary as string | undefined,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // External channel import proposal: AI (e.g. OpenClaw) wants to import a
      // WhatsApp/Slack/Telegram conversation as a Synap channel.
      // Execute createExternalChannel now that the user approved.
      if (
        proposal.targetType === "channel" &&
        proposal.proposalType === "create_external"
      ) {
        const data = (proposal.data ?? {}) as Record<string, unknown>;
        const extWorkspaceId = proposal.workspaceId || null;
        if (!extWorkspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Proposal is missing a valid workspaceId",
          });
        }
        const membership = await getWorkspaceMembership(
          db,
          extWorkspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const extCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: extWorkspaceId,
          workspaceRole: membership.role,
        };
        const caller = channelsRouter.createCaller(extCallerCtx);
        await caller.createExternalChannel({
          externalSource: data.externalSource as string,
          externalChannelId: data.externalChannelId as string,
          title: data.title as string,
          externalParticipants: data.externalParticipants as
            | string[]
            | undefined,
          initialMessage: data.initialMessage as string | undefined,
          metadata: data.metadata as Record<string, unknown> | undefined,
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Entity creation proposal: AI proposed a new entity.
      // Execute inline via entitiesRouter (human approver context bypasses governance).
      if (
        proposal.targetType === "entity" &&
        proposal.proposalType === "create"
      ) {
        const innerData = ((proposal.data as Record<string, unknown>)?.data ??
          {}) as Record<string, unknown>;
        const profileSlug = innerData.profileSlug as string | undefined;
        if (!profileSlug) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Entity proposal is missing profileSlug",
          });
        }

        const proposalWorkspaceId = proposal.workspaceId || null;

        // Check whether this profile is pod-wide or workspace-scoped.
        // Pod-wide entities (task, event, note, project, …) can be created without
        // a workspace context — the membership check is skipped and the entity is
        // stored with workspaceId = null.
        const profileService = new ProfileResolutionService(db);
        const entityScope = await profileService.getEntityScope(
          profileSlug,
          proposalWorkspaceId
        );
        const isPodWide = entityScope === "pod";

        let entityCallerCtx: {
          db: typeof db;
          authenticated: true;
          userId: string;
          workspaceId: string | null;
          workspaceRole: string;
        };

        if (isPodWide) {
          entityCallerCtx = {
            db,
            authenticated: true as const,
            userId,
            workspaceId: null,
            workspaceRole: "owner",
          };
        } else {
          if (!proposalWorkspaceId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Entity creation proposal for a workspace-scoped profile is missing a valid workspaceId",
            });
          }
          const membership = await getWorkspaceMembership(
            db,
            proposalWorkspaceId,
            userId
          );
          if (!membership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "No workspace access",
            });
          }
          entityCallerCtx = {
            db,
            authenticated: true as const,
            userId,
            workspaceId: proposalWorkspaceId,
            workspaceRole: membership.role,
          };
        }

        const entityCaller = regularEntitiesRouter.createCaller(
          entityCallerCtx as unknown as Context
        );
        const createdEntity = (await entityCaller.create({
          profileSlug,
          title: (innerData.title as string) || "Untitled",
          description: innerData.description as string | undefined,
          properties: innerData.properties as
            | Record<string, unknown>
            | undefined,
          // Long-form body (e.g. imported markdown) → materialized as a linked
          // document with versioning, not stuffed into a content property.
          content: innerData.content as string | undefined,
          source: "system",
        })) as { id?: string };

        // entities.create mints a FRESH id (≠ proposal.targetId), so record it
        // so `revert` can delete exactly the entity this approval created.
        const createMaterialized: ProposalMaterializedRecord = createdEntity?.id
          ? { entityIds: [createdEntity.id] }
          : {};
        const createPayload: StoredProposalData = {
          ...(payload as StoredProposalData),
          materialized: createMaterialized,
        };

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            data: createPayload,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Entity update proposal: AI proposed changes to an existing entity.
      // Execute inline via entitiesRouter (human approver context bypasses governance).
      if (
        proposal.targetType === "entity" &&
        proposal.proposalType === "update"
      ) {
        const innerData = ((proposal.data as Record<string, unknown>)?.data ??
          {}) as Record<string, unknown>;
        const entityId = (innerData.id as string) || proposal.targetId;
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId!,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        const entityCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId!,
          workspaceRole: membership.role,
        };
        const entityCaller = regularEntitiesRouter.createCaller(
          entityCallerCtx as unknown as Context
        );
        await entityCaller.update({
          id: entityId,
          title: innerData.title as string | undefined,
          description: innerData.description as string | undefined,
          properties: innerData.properties as
            | Record<string, unknown>
            | undefined,
          deleteProperties: innerData.deleteProperties as string[] | undefined,
          source: "system",
        });

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Workspace-join proposal (PRODUCT DECISION "agent asks to join"): an agent
      // filed this because it was not a workspace member. Approval emits a
      // `workspace.join.validated` event → the materialization hook enqueues a job
      // → the materializer's `workspace` case inserts the workspace_members row
      // idempotently. This mirrors the generic `.validated` path but does not
      // require request-shaped data (the join payload is a small {role,...} object,
      // and targetType "workspace" / action "join" fall outside UpdateRequest's
      // closed unions).
      if (
        proposal.targetType === "workspace" &&
        proposal.proposalType === "join"
      ) {
        const joinData = (proposal.data ?? {}) as Record<string, unknown>;
        const validatedEvent = await auditLog({
          subjectType: "workspace",
          action: "join",
          phase: "validated",
          // Governance-critical: a failed `.validated` append must NOT leave the
          // proposal APPROVED-but-unmaterialized.
          throwOnError: true,
          subjectId: proposal.targetId,
          userId,
          workspaceId: proposal.workspaceId ?? undefined,
          correlationId:
            typeof joinData.correlationId === "string"
              ? joinData.correlationId
              : undefined,
          data: {
            role: typeof joinData.role === "string" ? joinData.role : "editor",
            agentUserId: proposal.agentUserId ?? joinData.agentUserId,
            workspaceId: proposal.workspaceId,
            approvedBy: userId,
            approvedAt: new Date().toISOString(),
            approvalComment: input.comment,
            sourceProposalId: input.proposalId,
          },
          source: "api",
        });

        const joinUpdatedData = {
          ...joinData,
          ...(validatedEvent ? { validatedEventId: validatedEvent.id } : {}),
        };

        await db
          .update(proposals)
          .set({
            status: ProposalStatus.APPROVED,
            data: joinUpdatedData,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(proposals.id, input.proposalId));

        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "approved",
          userId
        );
        return { success: true };
      }

      // Generic flow: emit .validated event → materialization hook picks it up
      if (isRequestShapedProposalData(payload)) {
        const {
          targetType,
          changeType,
          data: requestData,
          correlationId: proposalCorrelationId,
        } = payload as typeof payload & { correlationId?: string };

        const eventPayload =
          typeof requestData === "object" && requestData !== null
            ? { ...requestData }
            : {};

        // Normalize entity payload fields
        if (targetType === "entity") {
          if (
            changeType === "update" &&
            eventPayload.entityId != null &&
            eventPayload.id == null
          ) {
            eventPayload.id = eventPayload.entityId;
          }
          if (
            changeType === "create" &&
            eventPayload.description != null &&
            eventPayload.preview == null
          ) {
            eventPayload.preview = eventPayload.description;
          }
        }

        const subjectId = (eventPayload.id as string) || proposal.targetId;

        // Emit .validated event with the same correlationId as the .requested event.
        // The materialization hook (setup-event-broadcasting.ts) will pick this up
        // and enqueue it to the materializer worker via pg-boss.
        const validatedEvent = await auditLog({
          subjectType: targetType,
          action: changeType,
          phase: "validated",
          // Governance-critical: a failed `.validated` append must NOT leave the
          // proposal flipped to APPROVED-but-unmaterialized — surface it so the
          // status flip below is skipped and the approval can be retried.
          throwOnError: true,
          subjectId,
          userId,
          workspaceId: proposal.workspaceId ?? undefined,
          correlationId: proposalCorrelationId,
          data: {
            ...eventPayload,
            workspaceId: proposal.workspaceId,
            approvedBy: userId,
            approvedAt: new Date().toISOString(),
            approvalComment: input.comment,
            sourceProposalId: input.proposalId,
          },
          source: "api",
        });

        if (validatedEvent) {
          payload.validatedEventId = validatedEvent.id;
        }
      } else {
        // Payload doesn't match any known request shape and targetType was not
        // handled by a specific branch above — throw rather than silently succeed.
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: `Proposal approval for type '${proposal.targetType}' is not yet implemented`,
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          ...(isRequestShapedProposalData(payload) ? { data: payload } : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportProposalOutcome({
        proposalId: input.proposalId,
        outcome: "approved",
        sourceMessageId: proposal.sourceMessageId,
        agentUserId: proposal.agentUserId,
        targetType: proposal.targetType,
      });

      emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    }),

  /**
   * Reject a proposal
   */
  reject: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Fetch first to get sourceMessageId + agentUserId for telemetry + workspaceId for realtime
      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: {
          sourceMessageId: true,
          agentUserId: true,
          targetType: true,
          workspaceId: true,
        },
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.REJECTED,
          rejectionReason: input.reason,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      if (proposal) {
        reportProposalOutcome({
          proposalId: input.proposalId,
          outcome: "rejected",
          sourceMessageId: proposal.sourceMessageId,
          agentUserId: proposal.agentUserId,
          targetType: proposal.targetType,
        });
        emitProposalReviewed(
          input.proposalId,
          proposal.workspaceId,
          "rejected",
          userId
        );
      }

      return { success: true };
    }),

  /**
   * Revert an APPROVED / AUTO-APPROVED proposal — the undo half of
   * "reviewable AND reversible". Reads the proposal's own stored data to compute
   * the inverse (no schema change): a create proposal's materialized entity /
   * relation / document ids are deleted; update and delete proposals fail loud
   * (no recoverable before-snapshot). Authority mirrors `approve`.
   */
  revert: protectedProcedure
    .input(
      z.object({
        proposalId: z.string(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const proposal = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
      });

      if (!proposal) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });
      }

      // Only an applied proposal can be reverted.
      if (
        proposal.status !== ProposalStatus.APPROVED &&
        proposal.status !== ProposalStatus.AUTO_APPROVED
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Only approved or auto-approved proposals can be reverted (status: ${proposal.status}).`,
        });
      }

      // Authority — SAME policy as approve (owner_and_admins | admins_only |
      // any_editor). Pod-wide proposals (no workspace) skip the workspace check,
      // mirroring approve.
      if (proposal.workspaceId) {
        const [ws] = await db
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, proposal.workspaceId))
          .limit(1);

        const settings = ws?.settings as WorkspaceSettings | undefined;
        const policy =
          settings?.aiGovernance?.proposalApprovalPolicy ?? "owner_and_admins";

        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId,
          userId
        );
        const proposalData = proposal.data as Record<string, unknown> | null;

        const canRevert = canReviewProposal({
          policy: policy as ProposalApprovalPolicy,
          memberRole: membership?.role,
          isOwner: proposalData?.sourceId === userId,
        });

        if (!canRevert) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not authorized to revert this proposal",
          });
        }
      }

      // Compute the inverse from the proposal's own data. Fail loud on anything
      // we can't safely undo (update/delete, or a create with no recorded ids).
      const plan = planProposalRevert({
        status: proposal.status,
        targetType: proposal.targetType,
        targetId: proposal.targetId,
        proposalType: proposal.proposalType,
        data: proposal.data,
      });

      if (plan.kind === "unsupported") {
        throw new TRPCError({
          code: "NOT_IMPLEMENTED",
          message: plan.reason,
        });
      }

      // Build a caller ctx mirroring approve's composite branch. Pod-wide
      // proposals run as owner with no workspace (entities.delete is a
      // podProcedure that reads ctx.workspaceId).
      let revertCtx: {
        db: typeof db;
        authenticated: true;
        userId: string;
        workspaceId: string | null;
        workspaceRole: string;
      };
      if (proposal.workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          proposal.workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        revertCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: proposal.workspaceId,
          workspaceRole: membership.role,
        };
      } else {
        revertCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: null,
          workspaceRole: "owner",
        };
      }

      const entityCaller = regularEntitiesRouter.createCaller(
        revertCtx as unknown as Context
      );
      const relationCaller = relationsRouter.createCaller(
        revertCtx as unknown as Context
      );
      const documentCaller = documentsRouter.createCaller(
        revertCtx as unknown as Context
      );

      // Apply the inverse through the SAME canonical routers approve uses, so the
      // undo is governed and emits its own delete events. Each delete is
      // idempotent (entities.delete soft/hard-deletes by id; relations/documents
      // delete by id) so a partial earlier revert can be retried safely.
      const deleted: ProposalMaterializedRecord = {
        entityIds: [],
        relationIds: [],
        documentIds: [],
      };
      const failures: string[] = [];

      for (const relationId of plan.relationIds) {
        try {
          await relationCaller.delete({ id: relationId });
          deleted.relationIds!.push(relationId);
        } catch (err) {
          logger.warn({ err, relationId }, "revert: relation delete failed");
          failures.push(`relation ${relationId}`);
        }
      }
      for (const entityId of plan.entityIds) {
        try {
          await entityCaller.delete({ id: entityId });
          deleted.entityIds!.push(entityId);
        } catch (err) {
          logger.warn({ err, entityId }, "revert: entity delete failed");
          failures.push(`entity ${entityId}`);
        }
      }
      for (const documentId of plan.documentIds) {
        try {
          await documentCaller.delete({ documentId });
          deleted.documentIds!.push(documentId);
        } catch (err) {
          logger.warn({ err, documentId }, "revert: document delete failed");
          failures.push(`document ${documentId}`);
        }
      }

      // If we mapped rows to undo but EVERY delete failed, treat the revert as
      // failed rather than flipping the proposal to reverted with no effect.
      const attempted =
        plan.entityIds.length +
        plan.relationIds.length +
        plan.documentIds.length;
      const succeeded =
        deleted.entityIds!.length +
        deleted.relationIds!.length +
        deleted.documentIds!.length;
      if (attempted > 0 && succeeded === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Revert failed — could not undo: ${failures.join(", ")}`,
        });
      }

      const revertedAt = new Date();
      const existingData =
        proposal.data && typeof proposal.data === "object"
          ? (proposal.data as StoredProposalData)
          : ({} as StoredProposalData);
      const revertedPayload: StoredProposalData = {
        ...existingData,
        revertedBy: userId,
        revertedAt: revertedAt.toISOString(),
        revertReason: input.reason,
      };

      // Flip to reverted, but only from an applied state — guards the
      // double-revert race: two concurrent calls both pass the precheck, but
      // the loser's UPDATE matches 0 rows (status is already `reverted`) and we
      // treat that as "already reverted" rather than reverting twice.
      const flipped = await db
        .update(proposals)
        .set({
          status: ProposalStatus.REVERTED,
          data: revertedPayload,
          reviewedBy: userId,
          reviewedAt: revertedAt,
          updatedAt: revertedAt,
        })
        .where(
          and(
            eq(proposals.id, input.proposalId),
            inArray(proposals.status, [
              ProposalStatus.APPROVED,
              ProposalStatus.AUTO_APPROVED,
            ])
          )
        )
        .returning({ id: proposals.id });

      if (flipped.length === 0) {
        // A concurrent revert won; the rows are already undone. Report success
        // without double-auditing.
        return { success: true, reverted: deleted, alreadyReverted: true };
      }

      // Audit the undo: a record that this proposal was reverted, plus a
      // best-effort delete.completed for the target subject for attribution.
      await auditLog({
        subjectType: "proposal",
        action: "delete",
        phase: "completed",
        subjectId: input.proposalId,
        userId,
        workspaceId: proposal.workspaceId ?? undefined,
        data: {
          reverted: true,
          sourceProposalId: input.proposalId,
          revertReason: input.reason,
          deletedEntityIds: deleted.entityIds,
          deletedRelationIds: deleted.relationIds,
          deletedDocumentIds: deleted.documentIds,
        },
        source: "api",
      });

      return {
        success: true,
        reverted: deleted,
        ...(failures.length > 0 ? { partialFailures: failures } : {}),
      };
    }),

  /**
   * Batch approve multiple proposals in a single call.
   * The frontend handles selection; this processes the IDs.
   * Each proposal goes through the same ownership + materialization flow.
   */
  batchApprove: protectedProcedure
    .input(
      z.object({
        proposalIds: z.array(z.string()).min(1).max(50),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const results: Array<{
        proposalId: string;
        success: boolean;
        error?: string;
      }> = [];

      for (const proposalId of input.proposalIds) {
        try {
          const proposal = await db.query.proposals.findFirst({
            where: eq(proposals.id, proposalId),
          });

          if (!proposal) {
            results.push({ proposalId, success: false, error: "Not found" });
            continue;
          }

          if (proposal.status !== ProposalStatus.PENDING) {
            results.push({
              proposalId,
              success: false,
              error: `Already ${proposal.status}`,
            });
            continue;
          }

          // Ownership check
          if (proposal.workspaceId) {
            const [ws] = await db
              .select({ settings: workspaces.settings })
              .from(workspaces)
              .where(eq(workspaces.id, proposal.workspaceId))
              .limit(1);

            const settings = ws?.settings as WorkspaceSettings | undefined;
            const policy =
              settings?.aiGovernance?.proposalApprovalPolicy ??
              "owner_and_admins";

            const membership = await getWorkspaceMembership(
              db,
              proposal.workspaceId,
              userId
            );
            const proposalData = proposal.data as Record<
              string,
              unknown
            > | null;

            const canApprove = canReviewProposal({
              policy: policy as ProposalApprovalPolicy,
              memberRole: membership?.role,
              isOwner: proposalData?.sourceId === userId,
            });

            if (!canApprove) {
              results.push({
                proposalId,
                success: false,
                error: "Not authorized",
              });
              continue;
            }
          }

          // Emit .validated event for generic proposals (same as single approve)
          const payload = proposal.data as
            | StoredProposalData
            | null
            | undefined;

          if (payload && isRequestShapedProposalData(payload)) {
            const {
              targetType,
              changeType,
              data: requestData,
              correlationId: proposalCorrelationId,
            } = payload as typeof payload & { correlationId?: string };

            const eventPayload =
              typeof requestData === "object" && requestData !== null
                ? { ...requestData }
                : {};

            if (targetType === "entity") {
              if (
                changeType === "update" &&
                eventPayload.entityId != null &&
                eventPayload.id == null
              ) {
                eventPayload.id = eventPayload.entityId;
              }
              if (
                changeType === "create" &&
                eventPayload.description != null &&
                eventPayload.preview == null
              ) {
                eventPayload.preview = eventPayload.description;
              }
            }

            const subjectId = (eventPayload.id as string) || proposal.targetId;

            const validatedEvent = await auditLog({
              subjectType: targetType,
              action: changeType,
              phase: "validated",
              // Governance-critical (batch): failed `.validated` append → throw,
              // caught per-item below so this proposal is reported failed and NOT
              // flipped to APPROVED-but-unmaterialized.
              throwOnError: true,
              subjectId,
              userId,
              workspaceId: proposal.workspaceId ?? undefined,
              correlationId: proposalCorrelationId,
              data: {
                ...eventPayload,
                workspaceId: proposal.workspaceId,
                approvedBy: userId,
                approvedAt: new Date().toISOString(),
                approvalComment: input.comment,
                sourceProposalId: proposalId,
              },
              source: "api",
            });

            if (validatedEvent) {
              payload.validatedEventId = validatedEvent.id;
            }
          }

          await db
            .update(proposals)
            .set({
              status: ProposalStatus.APPROVED,
              ...(payload && isRequestShapedProposalData(payload)
                ? { data: payload }
                : {}),
              reviewedBy: userId,
              reviewedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(proposals.id, proposalId));

          emitProposalReviewed(
            proposalId,
            proposal.workspaceId,
            "approved",
            userId
          );
          results.push({ proposalId, success: true });
        } catch (error) {
          results.push({
            proposalId,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }

      return { results };
    }),

  /**
   * Batch reject multiple proposals in a single call.
   */
  batchReject: protectedProcedure
    .input(
      z.object({
        proposalIds: z.array(z.string()).min(1).max(50),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      for (const proposalId of input.proposalIds) {
        const [updated] = await db
          .update(proposals)
          .set({
            status: ProposalStatus.REJECTED,
            rejectionReason: input.reason,
            reviewedBy: userId,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(proposals.id, proposalId),
              eq(proposals.status, ProposalStatus.PENDING)
            )
          )
          .returning({ workspaceId: proposals.workspaceId });

        if (updated) {
          emitProposalReviewed(
            proposalId,
            updated.workspaceId,
            "rejected",
            userId
          );
        }
      }

      return { success: true };
    }),

  /**
   * Submit a proposal (Universal Request)
   * Emits *.requested event.
   * If user has permission + auto-approve enabled -> Validated.
   * If not -> Pending Proposal.
   */
  submit: protectedProcedure
    .input(
      z.object({
        targetType: z.enum([
          "document",
          "entity",
          "relation",
          "workspace",
          "view",
          "profile",
        ]),
        targetId: z.string().optional(),
        changeType: z.enum(["create", "update", "delete"]),
        data: z.record(z.string(), z.any()),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const workspaceId = (input.data.workspaceId as string) || null;
      const targetId = input.targetId || randomUUID();
      const { proposal } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: input.targetType,
        targetId,
        proposalType: input.changeType,
        action: input.changeType,
        summary: buildFallbackTitle({
          changeType: input.changeType,
          targetType: input.targetType,
        }),
        data: {
          requestId: randomUUID(),
          source: "user",
          sourceId: userId,
          workspaceId,
          targetType: input.targetType,
          targetId,
          changeType: input.changeType,
          data: input.data,
          reasoning: input.reasoning,
          submittedBy: userId,
        },
      });

      return {
        success: true,
        requestId: proposal.id,
        status: "proposed",
        message: "Proposal submitted",
      };
    }),

  /**
   * Create a document edit proposal (suggest edit): replace text in range [from, to] with replacementText.
   * Used when user selects text and clicks "Suggest edit" in the editor.
   */
  createDocumentEdit: workspaceProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
        replacementText: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace context required",
        });
      }

      const document = await db.query.documents.findFirst({
        where: eq(documents.id, input.documentId),
      });

      if (!document) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Document not found",
        });
      }

      if (document.workspaceId !== workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Document is not in the current workspace",
        });
      }

      let currentContent: string;
      if (document.storageKey) {
        const contentBuffer = await storage.downloadBuffer(document.storageKey);
        currentContent =
          (document.mimeType?.includes("base64") ?? false)
            ? contentBuffer.toString("base64")
            : contentBuffer.toString("utf-8");
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Document has no stored content (e.g. whiteboard); suggest edit not supported",
        });
      }

      const from = Math.min(input.from, currentContent.length);
      const to = Math.min(input.to, currentContent.length);
      const proposedContent =
        currentContent.slice(0, from) +
        input.replacementText +
        currentContent.slice(to);

      const { proposal } = await createEventBackedProposal({
        userId: ctx.userId,
        workspaceId,
        targetType: "document",
        targetId: input.documentId,
        proposalType: "user_edit",
        action: "update",
        summary: "Suggest document edit",
        data: {
          source: "user",
          sourceId: ctx.userId,
          proposedContent,
          range: [from, to],
          originalSnippet: currentContent.slice(from, to),
          replacementText: input.replacementText,
        },
      });

      if (!proposal) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create proposal",
        });
      }

      return { proposalId: proposal.id };
    }),
});
