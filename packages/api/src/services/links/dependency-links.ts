/**
 * THE dependency door — `X --blocked_by--> Y` and `A --replaces--> B` across
 * unit-of-work kinds (session · entity · track).
 *
 * ONE edge for "this waits on that": a task blocked by a task, an entity by a
 * session, a session by a track, a track by a track. Entity relations `blocks`
 * / `depends_on` are the same fact under other names; the relation create doors
 * map them here ({@link normaliseDependencyRelation}) and migration 0301 moved
 * the stored rows. The RULE (which blockers still hold a unit up, `replaces`
 * following) is pure and lives once in `@synap-core/types/connections`
 * (`deriveOpenBlockers`); this file only reads the facts it needs.
 *
 * THREE layers, each the only one of its kind:
 *
 *   1. {@link insertDependencyEdge} / {@link deleteDependencyEdge} — THE store
 *      write (the one `blocked_by` / `replaces` producer; the
 *      `blocked-by-one-producer` tripwire pins it). Every write emits
 *      `link.create.completed` / `link.delete.completed` through
 *      `recordDomainMutation`, so automations can trigger on a dependency
 *      being declared or dropped. Session↔session callers
 *      (`session-blocked-by.ts`) floor ownership THEN call this.
 *   2. {@link validateDependencyEdge} — the endpoint floor: both kinds allowed,
 *      no self edge, BOTH endpoints visible to the caller through the canonical
 *      per-table read rule (`checkLinkEndpointsVisible`; a session is
 *      owner-only there, so every session end of these edges is the caller's
 *      own — the property the owner-blind session readers rely on). Also names
 *      the edge's workspace: the BLOCKED (FROM) end's own workspace, so the
 *      stamp never depends on which door wrote it.
 *   3. {@link governedDependencyLink} / {@link governedRemoveDependencyLink} —
 *      validate → `checkPermissionOrPropose` (`link/create` | `link/delete`,
 *      judged in the edge's workspace; an agent write files a proposal) → write
 *      → undo receipt. Approval of a filed proposal re-enters at
 *      {@link applyApprovedDependencyLink}, re-floored on the proposal's owner.
 *
 * WHAT IS DERIVED AT READ TIME, precisely. Nothing stores blocked-ness.
 * {@link readDependencyState} answers "is this unit blocked, and by what" for
 * any kind — by OPEN blockers, and by DROPPED ones (ended without delivering:
 * cancelled, failed, archived, lost), which hold their dependent until it
 * re-plans. Only a DELIVERED blocker clears (`classifyDependencyBlocker`).
 * The `session.unblocked` notification fires only for SESSION
 * dependents, on a SESSION close (`session-unblock-reactor.ts`), and its
 * "still open" test now spans every blocker kind. An entity or track that
 * clears does NOT notify anyone yet: there is no close event for an entity
 * status change or a track completion wired to a reactor here — their
 * dependents read as unblocked the next time they are read.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  or,
  inArray,
  links,
  entities,
  focusSessions,
  projectTracks,
  projects,
  drizzleSql,
  isLifecycleCategory,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  DEPENDENCY_LINK_TYPE,
  REPLACES_LINK_TYPE,
  deriveOpenBlockers,
  isDependencyEndpointKind,
  isDependencyEnded,
  isDependencyLinkType,
  normaliseDependencyRelation,
  type DependencyEdge,
  type DependencyLinkType,
  type DependencyNodeRef,
  type DependencyNodeState,
  type OpenBlocker,
} from "@synap-core/types/connections";
import { AccessContext, scopedDb } from "../../access/index.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import {
  checkLinkEndpointVisible,
  checkLinkEndpointsVisible,
} from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { stampAutoApprovedCreate } from "../proposals/stamp-materialized.js";

const logger = createLogger({ module: "dependency-links" });

/** The event subject for a `links` row (`@synap-core/types/events` SUBJECT_TYPES). */
export const LINK_EVENT_SUBJECT = "link" as const;

export interface DependencyEdgeInput {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  linkType: DependencyLinkType;
}

/** Who/what the write is attributed to, for the event spine. */
export interface LinkAttribution {
  agentUserId?: string | null;
  /** The proposal that authorized it (auto-approved receipt or approval). */
  proposalId?: string | null;
  sessionId?: string | null;
}

/**
 * `link.<action>.completed` — the log row + the automation fan-out, in one
 * door. Payload `{ linkType, fromType, fromId, toType, toId }`. Never throws:
 * the edge is already written, and a failed log must not undo it (the log
 * helper reports its own failures).
 */
export function recordLinkMutation(
  action: "create" | "delete",
  row: {
    id: string;
    workspaceId: string | null;
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    linkType: string;
  },
  userId: string,
  attribution: LinkAttribution = {}
): void {
  void recordDomainMutation({
    subjectType: LINK_EVENT_SUBJECT,
    action,
    subjectId: row.id,
    userId,
    workspaceId: row.workspaceId,
    agentUserId: attribution.agentUserId ?? undefined,
    proposalId: attribution.proposalId ?? undefined,
    sessionId: attribution.sessionId ?? undefined,
    data: {
      linkType: row.linkType,
      fromType: row.fromType,
      fromId: row.fromId,
      toType: row.toType,
      toId: row.toId,
    },
  }).catch((err) => {
    logger.error({ err, linkId: row.id, action }, "link event emit failed");
  });
}

/**
 * THE store write for a dependency / replacement edge. Callers have ALREADY
 * floored both endpoints (this does no authorization). Idempotent on
 * `idx_links_unique_edge`; emits `link.create.completed` only when a row was
 * actually inserted.
 */
export async function insertDependencyEdge(input: {
  edge: DependencyEdgeInput;
  workspaceId: string | null;
  createdBy: string;
  metadata?: Record<string, unknown>;
  attribution?: LinkAttribution;
}): Promise<{ inserted: number; linkId?: string }> {
  const { edge } = input;
  const inserted = await db
    .insert(links)
    .values({
      workspaceId: input.workspaceId,
      fromType: edge.fromType as never,
      fromId: edge.fromId,
      toType: edge.toType as never,
      toId: edge.toId,
      linkType: edge.linkType,
      createdBy: input.createdBy,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    })
    .returning({ id: links.id });
  const linkId = inserted[0]?.id;
  if (linkId) {
    recordLinkMutation(
      "create",
      { id: linkId, workspaceId: input.workspaceId, ...edge },
      input.createdBy,
      input.attribution
    );
  }
  return { inserted: inserted.length, ...(linkId ? { linkId } : {}) };
}

/** THE delete. Emits `link.delete.completed` per row actually removed. */
export async function deleteDependencyEdge(input: {
  edge: DependencyEdgeInput;
  userId: string;
  attribution?: LinkAttribution;
}): Promise<{ removed: number }> {
  const { edge } = input;
  const deleted = await db
    .delete(links)
    .where(
      and(
        eq(links.fromType, edge.fromType as never),
        eq(links.fromId, edge.fromId),
        eq(links.toType, edge.toType as never),
        eq(links.toId, edge.toId),
        eq(links.linkType, edge.linkType)
      )
    )
    .returning({ id: links.id, workspaceId: links.workspaceId });
  for (const row of deleted) {
    recordLinkMutation(
      "delete",
      { id: row.id, workspaceId: row.workspaceId, ...edge },
      input.userId,
      input.attribution
    );
  }
  return { removed: deleted.length };
}

/** The existing row's id, for an idempotent re-link. */
async function existingLinkId(
  edge: DependencyEdgeInput
): Promise<string | null> {
  const [row] = await db
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, edge.fromType as never),
        eq(links.fromId, edge.fromId),
        eq(links.toType, edge.toType as never),
        eq(links.toId, edge.toId),
        eq(links.linkType, edge.linkType)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

export type DependencyRefusal =
  | { reason: "invalid_pair"; httpStatus: 400; error: string }
  | { reason: "self_edge"; httpStatus: 400; error: string }
  | { reason: "cycle"; httpStatus: 400; error: string }
  | { reason: "not_found"; httpStatus: 403 | 404; error: string }
  | { reason: "forbidden"; httpStatus: 403; error: string };

/** The FROM (blocked / replacing) end's own workspace and owner. */
async function endpointHome(
  kind: string,
  id: string
): Promise<{ workspaceId: string | null; ownerId: string | null } | null> {
  if (kind === "entity") {
    const [r] = await db
      .select({ w: entities.workspaceId, o: entities.userId })
      .from(entities)
      .where(eq(entities.id, id))
      .limit(1);
    return r ? { workspaceId: r.w ?? null, ownerId: r.o ?? null } : null;
  }
  if (kind === "session") {
    const [r] = await db
      .select({ w: focusSessions.workspaceId, o: focusSessions.userId })
      .from(focusSessions)
      .where(eq(focusSessions.id, id))
      .limit(1);
    return r ? { workspaceId: r.w ?? null, ownerId: r.o ?? null } : null;
  }
  if (kind === "track") {
    const [r] = await db
      .select({ w: projects.workspaceId, o: projectTracks.userId })
      .from(projectTracks)
      .innerJoin(projects, eq(projects.id, projectTracks.projectId))
      .where(eq(projectTracks.id, id))
      .limit(1);
    return r ? { workspaceId: r.w ?? null, ownerId: r.o ?? null } : null;
  }
  return null;
}

/** How deep the cycle walk follows `blocked_by` before giving up. */
const MAX_CYCLE_HOPS = 32;

/**
 * Would `from --blocked_by--> to` close a CYCLE — does `to` already wait,
 * through `blocked_by` edges of any kinds, on `from`? A cycle is a deadlock:
 * every unit in it waits on another that can never deliver first, so the edge
 * that closes one is refused at every door (the generic floor below and the
 * session door's `validateSessionBlocker`).
 *
 * Walks `to`'s outgoing `blocked_by` edges breadth-first, bounded by
 * {@link MAX_CYCLE_HOPS}. Measured limits: `replaces` edges are not walked (a
 * cycle closed only through a replacement is not seen), and a chain deeper
 * than the bound is not called a cycle. No authorization here — callers floor
 * both ends first, so the answer is a yes/no about units the caller may see.
 */
export async function closesDependencyCycle(edge: {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
}): Promise<boolean> {
  const target = refKey({ kind: edge.fromType, id: edge.fromId });
  const start = { kind: edge.toType, id: edge.toId };
  const seen = new Set([refKey(start)]);
  let frontier: DependencyNodeRef[] = [start];
  for (let hop = 0; hop < MAX_CYCLE_HOPS && frontier.length; hop++) {
    const rows = await db
      .select({ toType: links.toType, toId: links.toId })
      .from(links)
      .where(
        and(
          eq(links.linkType, DEPENDENCY_LINK_TYPE),
          or(
            ...frontier.map((r) =>
              and(eq(links.fromType, r.kind as never), eq(links.fromId, r.id))
            )
          )
        )
      );
    const next: DependencyNodeRef[] = [];
    for (const r of rows) {
      const ref = { kind: r.toType as string, id: r.toId };
      const k = refKey(ref);
      if (k === target) return true;
      if (seen.has(k)) continue;
      seen.add(k);
      next.push(ref);
    }
    frontier = next;
  }
  return false;
}

/** The refusal every door gives for a cycle — one sentence, one place. */
export const DEPENDENCY_CYCLE_ERROR =
  "This would make the two wait on each other: the blocker already waits, directly or through others, on the work you want to block. Remove one of those dependencies first.";

/**
 * The endpoint floor. Returns the edge's workspace (the FROM end's) on
 * success. An invisible and a nonexistent endpoint get the identical refusal.
 *
 * WHO MAY WRITE THE EDGE: the edge changes the BLOCKED (FROM) end's derived
 * state — whether it is blocked, and so the next-hour picks of whoever works
 * on it — so the caller must be able to WRITE that end
 * (`assertWorkspaceWrite`: a write role in its workspace, or its owner when it
 * is pod-personal), not merely see it.
 *
 * CREATE floors BOTH ends on visibility: you cannot declare a dependency on
 * something you cannot see — and, once the caller may write it, refuses a
 * `blocked_by` that would close a cycle ({@link closesDependencyCycle}).
 * DELETE floors only the BLOCKED end: a blocker the
 * reader cannot see (`hidden` in the neighbourhood, its status never
 * revealed) would otherwise hold their unit forever with no way out — the
 * owner of the blocked end may always drop the edge.
 */
export async function validateDependencyEdge(
  edge: DependencyEdgeInput,
  userId: string,
  requestWorkspaceId: string | null = null,
  action: "create" | "delete" = "create"
): Promise<
  { ok: true; workspaceId: string | null } | ({ ok: false } & DependencyRefusal)
> {
  if (
    !isDependencyLinkType(edge.linkType) ||
    !isDependencyEndpointKind(edge.fromType) ||
    !isDependencyEndpointKind(edge.toType)
  ) {
    return {
      ok: false,
      reason: "invalid_pair",
      httpStatus: 400,
      error: `${edge.linkType} links connect two units of work (session, entity or track)`,
    };
  }
  if (edge.fromType === edge.toType && edge.fromId === edge.toId) {
    return {
      ok: false,
      reason: "self_edge",
      httpStatus: 400,
      error:
        edge.linkType === DEPENDENCY_LINK_TYPE
          ? "A unit of work cannot be blocked by itself"
          : "A unit of work cannot replace itself",
    };
  }
  const refusal =
    action === "delete"
      ? await checkLinkEndpointVisible(
          edge.fromType,
          edge.fromId,
          userId,
          requestWorkspaceId
        )
      : await checkLinkEndpointsVisible(edge, userId, requestWorkspaceId);
  if (refusal) {
    return {
      ok: false,
      reason: "not_found",
      httpStatus: refusal.status,
      error: refusal.error,
    };
  }
  const home = await endpointHome(edge.fromType, edge.fromId);
  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId: home?.workspaceId ?? null,
      ownerId: home?.ownerId ?? null,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "forbidden",
      httpStatus: 403,
      error:
        err instanceof Error
          ? err.message
          : "You cannot change what this waits on.",
    };
  }
  if (
    action === "create" &&
    edge.linkType === DEPENDENCY_LINK_TYPE &&
    (await closesDependencyCycle(edge))
  ) {
    return {
      ok: false,
      reason: "cycle",
      httpStatus: 400,
      error: DEPENDENCY_CYCLE_ERROR,
    };
  }
  return { ok: true, workspaceId: home?.workspaceId ?? null };
}

/** Validate + write, ungoverned — for doors whose write is already authorized. */
export async function writeDependencyLink(input: {
  edge: DependencyEdgeInput;
  userId: string;
  metadata?: Record<string, unknown>;
  attribution?: LinkAttribution;
}): Promise<
  | {
      ok: true;
      inserted: number;
      linkId: string | null;
      workspaceId: string | null;
    }
  | ({ ok: false } & DependencyRefusal)
> {
  const valid = await validateDependencyEdge(input.edge, input.userId);
  if (!valid.ok) return valid;
  const written = await insertDependencyEdge({
    edge: input.edge,
    workspaceId: valid.workspaceId,
    createdBy: input.userId,
    metadata: input.metadata,
    attribution: input.attribution,
  });
  return {
    ok: true,
    inserted: written.inserted,
    linkId: written.linkId ?? (await existingLinkId(input.edge)),
    workspaceId: valid.workspaceId,
  };
}

export type GovernedLinkResult =
  | {
      status: "created" | "exists";
      linkId: string | null;
      inserted: number;
    }
  | { status: "removed" | "absent"; removed: number }
  | {
      status: "proposed";
      proposalId: string;
      reviewPath?: string;
      reviewUrl?: string;
    }
  | { status: "denied"; reason: string }
  | ({ status: "refused" } & DependencyRefusal);

interface GovernedInput {
  edge: DependencyEdgeInput;
  /** The acting HUMAN (the agent's linked user on an agent door). */
  userId: string;
  /** Set on an agent door — the write is governed as that agent. */
  agentUserId?: string | null;
  /**
   * The write is ALREADY approved (a composite approval re-entering a door):
   * skip the gate, stamp the event with this proposal.
   */
  approvedProposalId?: string | null;
  requestWorkspaceId?: string | null;
  reasoning?: string;
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
  /** The door, for the undo receipt's log line. */
  door: string;
}

function linkTitle(edge: DependencyEdgeInput): string {
  return `${edge.fromType} --${edge.linkType}--> ${edge.toType}`;
}

async function gate(
  input: GovernedInput,
  action: "create" | "delete",
  workspaceId: string | null
): Promise<
  { go: true; receiptId?: string } | { go: false; result: GovernedLinkResult }
> {
  if (input.approvedProposalId) return { go: true };
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId ?? undefined,
    workspaceId,
    subjectType: "link",
    action,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.reasoning?.trim() ? { reasoning: input.reasoning.trim() } : {}),
    data: {
      title: linkTitle(input.edge),
      fromType: input.edge.fromType,
      fromId: input.edge.fromId,
      toType: input.edge.toType,
      toId: input.edge.toId,
      linkType: input.edge.linkType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    return { go: false, result: { status: "denied", reason: perm.reason } };
  }
  if ("proposalId" in perm) {
    return {
      go: false,
      result: {
        status: "proposed",
        proposalId: perm.proposalId,
        ...(perm.reviewPath ? { reviewPath: perm.reviewPath } : {}),
        ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
      },
    };
  }
  return {
    go: true,
    receiptId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
  };
}

/**
 * THE governed create: floor → `checkPermissionOrPropose` (`link/create`, in
 * the edge's workspace) → write → undo receipt. An agent write either applies
 * (auto-approved, with a receipt) or files a `link/create` proposal whose
 * approval is applied by {@link applyApprovedDependencyLink}.
 */
export async function governedDependencyLink(
  input: GovernedInput
): Promise<GovernedLinkResult> {
  const valid = await validateDependencyEdge(
    input.edge,
    input.userId,
    input.requestWorkspaceId ?? null
  );
  if (!valid.ok) {
    const { ok: _ok, ...refusal } = valid;
    return { status: "refused", ...refusal };
  }
  const g = await gate(input, "create", valid.workspaceId);
  if (!g.go) return g.result;
  const attribution: LinkAttribution = {
    agentUserId: input.agentUserId,
    proposalId: input.approvedProposalId ?? g.receiptId,
    sessionId: input.sessionId,
  };
  const written = await insertDependencyEdge({
    edge: input.edge,
    workspaceId: valid.workspaceId,
    createdBy: input.userId,
    metadata: input.metadata,
    attribution,
  });
  await stampAutoApprovedCreate({
    receiptId: g.receiptId,
    record: written.linkId ? { linkIds: [written.linkId] } : {},
    door: input.door,
  });
  return written.linkId
    ? { status: "created", linkId: written.linkId, inserted: written.inserted }
    : {
        status: "exists",
        linkId: await existingLinkId(input.edge),
        inserted: 0,
      };
}

/** THE governed delete (`link/delete`). Same floor; reports absence honestly. */
export async function governedRemoveDependencyLink(
  input: GovernedInput
): Promise<GovernedLinkResult> {
  const valid = await validateDependencyEdge(
    input.edge,
    input.userId,
    input.requestWorkspaceId ?? null,
    "delete"
  );
  if (!valid.ok) {
    const { ok: _ok, ...refusal } = valid;
    return { status: "refused", ...refusal };
  }
  const g = await gate(input, "delete", valid.workspaceId);
  if (!g.go) return g.result;
  const { removed } = await deleteDependencyEdge({
    edge: input.edge,
    userId: input.userId,
    attribution: {
      agentUserId: input.agentUserId,
      proposalId: input.approvedProposalId ?? g.receiptId,
      sessionId: input.sessionId,
    },
  });
  return removed > 0
    ? { status: "removed", removed }
    : { status: "absent", removed: 0 };
}

/**
 * Apply an APPROVED `link/create` | `link/delete` dependency proposal, floored
 * on the proposal's OWNER (`proposals.subjectUserId` — never the approver,
 * never the payload; see `applyApprovedBlockedBy` for why) against TODAY's
 * rows. Throws a reason string on refusal; nothing is written.
 */
export async function applyApprovedDependencyLink(input: {
  action: "create" | "delete";
  data: Record<string, unknown>;
  ownerUserId: string | null | undefined;
  proposalId: string;
}): Promise<{ ok: true; rows: number } | { ok: false; why: string }> {
  const d = input.data;
  if (
    typeof d.fromType !== "string" ||
    typeof d.fromId !== "string" ||
    typeof d.toType !== "string" ||
    typeof d.toId !== "string" ||
    !isDependencyLinkType(d.linkType as string)
  ) {
    return { ok: false, why: "the proposal does not name a dependency edge." };
  }
  if (!input.ownerUserId) {
    return {
      ok: false,
      why: "the proposal records no owner (subject_user_id), so whose endpoints these are cannot be established.",
    };
  }
  const edge: DependencyEdgeInput = {
    fromType: d.fromType,
    fromId: d.fromId,
    toType: d.toType,
    toId: d.toId,
    linkType: d.linkType as DependencyLinkType,
  };
  const valid = await validateDependencyEdge(
    edge,
    input.ownerUserId,
    null,
    input.action
  );
  if (!valid.ok) {
    return {
      ok: false,
      why:
        input.action === "delete"
          ? `${valid.error}. The waiting end must still exist and be writable by the proposal's owner.`
          : `${valid.error}. Both ends must still exist and be visible to the proposal's owner, who must be able to write the waiting end.`,
    };
  }
  const attribution = { proposalId: input.proposalId };
  if (input.action === "delete") {
    const { removed } = await deleteDependencyEdge({
      edge,
      userId: input.ownerUserId,
      attribution,
    });
    return { ok: true, rows: removed };
  }
  const metadata =
    d.metadata && typeof d.metadata === "object" && !Array.isArray(d.metadata)
      ? (d.metadata as Record<string, unknown>)
      : undefined;
  const written = await insertDependencyEdge({
    edge,
    workspaceId: valid.workspaceId,
    createdBy: input.ownerUserId,
    metadata,
    attribution,
  });
  return { ok: true, rows: written.inserted };
}

// ── The read side: derived blocked-ness for ANY kind ────────────────────────

/** How far `replaces` chains are followed (a chain longer than this is data rot). */
const MAX_REPLACEMENT_HOPS = 8;

export interface DependencyState {
  blocked: boolean;
  /**
   * The blockers still holding it up, after `replaces` following — open ones
   * and dropped ones (`dropped: true`, ended without delivering).
   */
  openBlockers: OpenBlocker[];
  /** Every declared blocker (outgoing `blocked_by`), open or cleared. */
  declared: DependencyNodeRef[];
}

const refKey = (r: DependencyNodeRef) => `${r.kind}:${r.id}`;

/**
 * Follow `replaces` INTO `start` (`X --replaces--> blocker`), bounded by
 * {@link MAX_REPLACEMENT_HOPS}. Returns every `replaces` edge walked and adds
 * each replacement it reaches to `seen` (cycle-safe). THE one walk — the
 * one-node and the many-node readers both call it, so they cannot drift.
 */
async function followReplacements(
  start: readonly DependencyNodeRef[],
  seen: Set<string>
): Promise<DependencyEdge[]> {
  const walked: DependencyEdge[] = [];
  let frontier: DependencyNodeRef[] = [...start];
  for (let hop = 0; hop < MAX_REPLACEMENT_HOPS && frontier.length; hop++) {
    const rows = await db
      .select({
        fromType: links.fromType,
        fromId: links.fromId,
        toType: links.toType,
        toId: links.toId,
        linkType: links.linkType,
      })
      .from(links)
      .where(
        and(
          eq(links.linkType, REPLACES_LINK_TYPE),
          or(
            ...frontier.map((r) =>
              and(eq(links.toType, r.kind as never), eq(links.toId, r.id))
            )
          )
        )
      );
    walked.push(...rows);
    frontier = rows
      .map((r) => ({ kind: r.fromType as string, id: r.fromId }))
      .filter((r) => {
        const k = refKey(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  }
  return walked;
}

/**
 * How a dependency read sees SESSION endpoints: owner-only by default; a door
 * that reads a session through its human roster (the continuation packet)
 * passes `roster: true`, so a blocker it may see there keeps its name.
 */
export interface DependencyReadOptions {
  roster?: boolean;
}

async function readStates(
  refs: readonly DependencyNodeRef[],
  userId: string,
  opts: DependencyReadOptions = {}
): Promise<Map<string, DependencyNodeState>> {
  const out = new Map<string, DependencyNodeState>();
  const idsOf = (kind: string) => [
    ...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id)),
  ];
  const access = scopedDb(AccessContext.operator({ userId }));

  const sessionIds = idsOf("session");
  if (sessionIds.length) {
    const visible = new Set(
      (
        await db
          .select({ id: focusSessions.id })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, sessionIds),
              sessionReadableWhere({ userId, roster: opts.roster === true })
            )
          )
      ).map((r) => r.id)
    );
    const rows = await db
      .select({
        id: focusSessions.id,
        status: focusSessions.status,
        title: focusSessions.title,
        goal: focusSessions.goal,
      })
      .from(focusSessions)
      .where(inArray(focusSessions.id, sessionIds));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of sessionIds) {
      const row = found.get(id);
      out.set(
        `session:${id}`,
        !row
          ? { missing: true }
          : {
              status: row.status ?? null,
              title: resolveSessionTitle(row),
              hidden: !visible.has(id),
            }
      );
    }
  }

  const entityIds = idsOf("entity");
  if (entityIds.length) {
    const visible = new Set(
      (
        await db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(inArray(entities.id, entityIds), access.predicate(entities))
          )
      ).map((r) => r.id)
    );
    const rows = await db
      .select({
        id: entities.id,
        title: entities.title,
        status: entities.status,
        statusCategory: entities.statusCategory,
        properties: entities.properties,
        deletedAt: entities.deletedAt,
      })
      .from(entities)
      .where(inArray(entities.id, entityIds));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of entityIds) {
      const row = found.get(id);
      if (!row || row.deletedAt) {
        out.set(`entity:${id}`, { missing: true });
        continue;
      }
      // The kind's lifecycle COLUMNS are the truth (0319): the status and its
      // fixed category. A kind that declares no lifecycle has neither; its
      // free `status` property is then the only status there is.
      const propStatus = (row.properties as Record<string, unknown> | null)
        ?.status;
      out.set(`entity:${id}`, {
        status:
          row.status ?? (typeof propStatus === "string" ? propStatus : null),
        category: isLifecycleCategory(row.statusCategory)
          ? row.statusCategory
          : null,
        title: row.title ?? null,
        hidden: !visible.has(id),
      });
    }
  }

  const trackIds = idsOf("track");
  if (trackIds.length) {
    const visible = new Set(
      (
        await db
          .select({ id: projectTracks.id })
          .from(projectTracks)
          .where(
            and(
              inArray(projectTracks.id, trackIds),
              access.predicate(projectTracks)
            )
          )
      ).map((r) => r.id)
    );
    const rows = await db
      .select({
        id: projectTracks.id,
        status: projectTracks.status,
        name: projectTracks.name,
      })
      .from(projectTracks)
      .where(inArray(projectTracks.id, trackIds));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of trackIds) {
      const row = found.get(id);
      out.set(
        `track:${id}`,
        !row
          ? { missing: true }
          : {
              status: row.status ?? null,
              title: row.name,
              hidden: !visible.has(id),
            }
      );
    }
  }
  return out;
}

/**
 * Is `node` blocked right now, and by what — for ANY dependency kind. Reads
 * the node's outgoing `blocked_by` edges, follows `replaces` into them
 * (bounded), batch-reads every far end's status, and hands the facts to the
 * ONE rule (`deriveOpenBlockers`). A blocker the reader cannot see is still a
 * blocker (`hidden`), never dropped; a failed read THROWS — it is never
 * folded into "not blocked".
 */
export async function readDependencyState(
  node: DependencyNodeRef,
  userId: string,
  opts: DependencyReadOptions = {}
): Promise<DependencyState> {
  const declaredRows = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toType: links.toType,
      toId: links.toId,
      linkType: links.linkType,
    })
    .from(links)
    .where(
      and(
        eq(links.fromType, node.kind as never),
        eq(links.fromId, node.id),
        eq(links.linkType, DEPENDENCY_LINK_TYPE)
      )
    );
  const edges: DependencyEdge[] = [...declaredRows];
  const declared: DependencyNodeRef[] = declaredRows.map((r) => ({
    kind: r.toType as string,
    id: r.toId,
  }));

  // Follow `replaces` INTO the frontier: `X --replaces--> blocker`.
  const seen = new Set(declared.map(refKey));
  edges.push(...(await followReplacements(declared, seen)));

  const refs = [...seen].map((k) => {
    const i = k.indexOf(":");
    return { kind: k.slice(0, i), id: k.slice(i + 1) };
  });
  const states = await readStates(refs, userId, opts);
  const openBlockers = deriveOpenBlockers(node, edges, (r) =>
    states.get(`${r.kind}:${r.id}`)
  );
  return { blocked: openBlockers.length > 0, openBlockers, declared };
}

/** Per node: is it blocked, and how many open units of work wait on it. */
export interface DependencyFacts {
  /**
   * Blockers still holding it up after `replaces` following
   * (`deriveOpenBlockers`) — open AND dropped.
   */
  openBlockers: number;
  /** The same blockers, each with its `dropped` mark and (when visible) name. */
  blockers: OpenBlocker[];
  /**
   * Dependents still OPEN by their own kind's rule that declare
   * `blocked_by` this node — "Unblocks N". A deleted dependent does not
   * count; one the reader cannot see still does (a number, never a name).
   */
  unblocks: number;
}

/**
 * {@link readDependencyState} for MANY nodes at once — the same edges, the
 * same `replaces` following, the same batch state read and the ONE rule
 * (`deriveOpenBlockers`) — plus each node's open dependents. A bounded number
 * of queries whatever the node count (a list read, e.g. the lens page's
 * next-hour picks). A failed read THROWS; it is never folded into "free".
 */
export async function readDependencyFacts(
  nodes: readonly DependencyNodeRef[],
  userId: string
): Promise<Map<string, DependencyFacts>> {
  const out = new Map<string, DependencyFacts>();
  if (nodes.length === 0) return out;
  const nodeKey = (r: DependencyNodeRef) => `${r.kind}:${r.id}`;
  const byEnd = (end: "from" | "to") =>
    or(
      ...[...new Set(nodes.map((n) => n.kind))].map((kind) =>
        and(
          eq(end === "from" ? links.fromType : links.toType, kind as never),
          inArray(
            end === "from" ? links.fromId : links.toId,
            nodes.filter((n) => n.kind === kind).map((n) => n.id)
          )
        )
      )
    );
  const cols = {
    fromType: links.fromType,
    fromId: links.fromId,
    toType: links.toType,
    toId: links.toId,
    linkType: links.linkType,
  };
  const [declaredRows, dependentRows] = await Promise.all([
    db
      .select(cols)
      .from(links)
      .where(and(byEnd("from"), eq(links.linkType, DEPENDENCY_LINK_TYPE))),
    db
      .select(cols)
      .from(links)
      .where(and(byEnd("to"), eq(links.linkType, DEPENDENCY_LINK_TYPE))),
  ]);
  const edges: DependencyEdge[] = [...declaredRows];

  // Follow `replaces` INTO the blockers, bounded — the one-node read's helper.
  const blockers: DependencyNodeRef[] = declaredRows.map((r) => ({
    kind: r.toType as string,
    id: r.toId,
  }));
  const seen = new Set(blockers.map(nodeKey));
  edges.push(...(await followReplacements(blockers, seen)));
  const dependents = dependentRows.map((r) => ({
    kind: r.fromType as string,
    id: r.fromId,
  }));
  for (const d of dependents) seen.add(nodeKey(d));

  const refs = [...seen].map((k) => {
    const i = k.indexOf(":");
    return { kind: k.slice(0, i), id: k.slice(i + 1) };
  });
  const states = await readStates(refs, userId);
  const stateOf = (r: DependencyNodeRef) => states.get(nodeKey(r));

  for (const node of nodes) {
    const waiting = new Set<string>();
    for (const e of dependentRows) {
      if (e.toType !== node.kind || e.toId !== node.id) continue;
      const dep = { kind: e.fromType as string, id: e.fromId };
      const st = stateOf(dep);
      if (!st || st.missing) continue;
      if (isDependencyEnded(dep.kind, st.status, st.category)) continue;
      waiting.add(nodeKey(dep));
    }
    const blockers = deriveOpenBlockers(node, edges, stateOf);
    out.set(nodeKey(node), {
      openBlockers: blockers.length,
      blockers,
      unblocks: waiting.size,
    });
  }
  return out;
}

/**
 * For the relation doors that write WITHOUT a governance gate of their own
 * (capture's already-receipted materialize, `relations.batchCreate`): if
 * `type` is `blocks` / `depends_on`, write THE dependency edge instead and
 * return the relation-door-shaped result (`storedAs: "link"`); otherwise
 * `null` — the caller writes its relation as before. A refused endpoint
 * THROWS (the per-edge `try` of every caller reports it), never a silent skip.
 */
export async function writeRelationAsDependency(input: {
  type: string;
  sourceEntityId: string;
  targetEntityId: string;
  userId: string;
  metadata?: Record<string, unknown>;
  attribution?: LinkAttribution;
}): Promise<{
  id: string;
  status: "created" | "exists";
  storedAs: "link";
  inserted: number;
} | null> {
  const dependency = normaliseDependencyRelation(
    input.type,
    input.sourceEntityId,
    input.targetEntityId
  );
  if (!dependency) return null;
  const written = await writeDependencyLink({
    edge: {
      fromType: "entity",
      fromId: dependency.fromId,
      toType: "entity",
      toId: dependency.toId,
      linkType: dependency.linkType,
    },
    userId: input.userId,
    metadata: { ...(input.metadata ?? {}), relationType: input.type },
    attribution: input.attribution,
  });
  if (!written.ok) throw new Error(written.error);
  return {
    id: written.linkId ?? "",
    status: written.inserted > 0 ? "created" : "exists",
    storedAs: "link",
    inserted: written.inserted,
  };
}

/** The tRPC code for a dependency refusal — one mapping for every tRPC door. */
export function trpcCodeForDependencyRefusal(
  httpStatus: DependencyRefusal["httpStatus"]
): "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" {
  return httpStatus === 400
    ? "BAD_REQUEST"
    : httpStatus === 403
      ? "FORBIDDEN"
      : "NOT_FOUND";
}

/**
 * The dependency edge a relation reader's id names: the LINK id a relation
 * read returned (`storedAs: "link"`), or the relation id migration 0301 moved
 * (`metadata.migratedFromRelationId`). `null` when it names neither. No
 * authorization here — the caller hands the edge to a governed door, which
 * floors it.
 */
export async function findDependencyEdgeByRelationReadId(
  id: string
): Promise<DependencyEdgeInput | null> {
  const [row] = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toType: links.toType,
      toId: links.toId,
      linkType: links.linkType,
    })
    .from(links)
    .where(
      and(
        eq(links.linkType, DEPENDENCY_LINK_TYPE),
        or(
          eq(links.id, id),
          drizzleSql`${links.metadata}->>'migratedFromRelationId' = ${id}`
        )
      )
    )
    .limit(1);
  if (!row) return null;
  return {
    fromType: row.fromType as string,
    fromId: row.fromId,
    toType: row.toType as string,
    toId: row.toId,
    linkType: DEPENDENCY_LINK_TYPE,
  };
}
