/**
 * LANDED OUTPUTS — what landed across the pod, newest first (`outputs.landed`).
 *
 * The browser's Data › Landed: one row per object the caller's work sessions
 * PRODUCED, with WHO made it, the SESSION it came from, and the DECISION that
 * let it exist. Decision D-d: this is `projects.outputs` GENERALISED, not
 * `entities.list` widened — so it runs the SAME scan (`scanSessionOutputs`:
 * the three-ledger join, title oracle, row key) and the SAME pager as the
 * project door. Only the session population differs:
 *
 *   project door  — `projectPathConditions` (work + tracked runs, one project)
 *   this door     — `sessionListConditions` with the same kind + triage lens,
 *                   and the workspace / project lenses as `signals` reads them
 *                   (absent workspace = the whole floor, never the header).
 *
 * ── WHAT THIS ADDS ON TOP OF THE SCAN ────────────────────────────────────────
 *   - ACTOR: the creating proposal's agent, else the object's own provenance
 *     columns (`entities` / `documents`: `agentUserId`, `createdByKind`,
 *     `createdByUserId`) when it recorded any, else the artifact ledger's
 *     `originKind`, else the object's (or session's) owner. A NULL-provenance row reads as a HUMAN (the owner),
 *     never as an agent — the schema's own rule for legacy rows.
 *   - DECISION: the object's CREATING proposal — `sourceProposalId` when the
 *     row was materialized from one, otherwise the earliest proposal on that
 *     target filed AT OR BEFORE the object's own `createdAt` (the auto-approve
 *     receipt is minted before the write; any later proposal on the target is
 *     an edit, not the creation). Mapped by `resolveLandedDecision`.
 *   - PENDING rows: a PENDING proposal filed into one of the scanned sessions
 *     whose target does not exist yet — a proposed creation. It is "To review"
 *     (`decision.state = 'pending'`), its door is the proposal, and it is
 *     never counted as landed.
 *
 * ── VISIBILITY ──────────────────────────────────────────────────────────────
 * Sessions: `sessionListConditions` (starts from `sessionReadableWhere`) AND
 * `scopedDb(access).predicate(focusSessions)` — the same floors the project
 * door applies. Proposals: read only BY the floored session ids or the
 * floored outputs' target ids, AND through `userVisibleWhere` — the predicate
 * every other proposal read (`attachSessionParticipants`) applies.
 *
 * ── BOUNDS ──────────────────────────────────────────────────────────────────
 * The scan reads the {@link PROJECT_OUTPUTS_SESSION_SCAN} most recently active
 * sessions; past that the page says `truncated: true`. `since` and `actor`
 * filter the projected rows before paging, so a page is always full when more
 * matching rows exist.
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  entities,
  documents,
  focusSessions,
  projects,
  proposals,
  users,
} from "@synap/database";
import {
  matchesLandedActor,
  resolveLandedDecision,
  type LandedActor,
  type LandedActorFilter,
  type LandedObjectRow,
  type LandedObjectsPage,
} from "@synap-core/types/landed";
import { normalizeObjectKind } from "@synap-core/types/vocabulary";
import { resolveTargetName } from "@synap-core/types/proposals";
import { scopedDb, type AccessContext } from "../../access/index.js";
import type { Lens } from "../../access/context.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { displayNameForUser } from "../../routers/proposals/helper-functions.js";
import { sessionListConditions } from "../focus-sessions/session-list-conditions.js";
import { UUID_RE } from "../focus-sessions/session-metadata.js";
import {
  PROJECT_OUTPUTS_MAX_LIMIT,
  pageNewestFirst,
  scanSessionOutputs,
  type ProjectOutputItem,
  type ScannedSession,
} from "../projects/project-outputs.js";

export const LANDED_OUTPUTS_MAX_LIMIT = PROJECT_OUTPUTS_MAX_LIMIT;

export interface LandedOutputsQuery {
  database?: typeof db;
  access: AccessContext;
  /** `undefined` = the whole floor · `null` = pod-personal · id(s) = narrow. */
  workspaceLens?: Lens;
  /** Narrow to one project's sessions. A project the caller cannot see ⇒ `null`. */
  projectId?: string;
  /** Only rows that landed (or were proposed) at or after this instant (ISO). */
  since?: string;
  actor?: LandedActorFilter;
  cursor?: string;
  limit: number;
}

/** The kinds whose rows carry provenance columns this door reads. */
const PROVENANCE_KINDS = new Set(["entity", "document"]);

interface ObjectProvenance {
  userId: string;
  createdByKind: string | null;
  createdByUserId: string | null;
  agentUserId: string | null;
  sourceProposalId: string | null;
  createdAt: Date;
}

interface ProposalFact {
  id: string;
  status: string;
  targetType: string;
  targetId: string;
  agentUserId: string | null;
  proposedByUserId: string | null;
  sessionId: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  data: unknown;
}

const coord = (kind: string, id: string) => `${normalizeObjectKind(kind)}:${id}`;

/** Returns `null` when `projectId` names a project the caller cannot see. */
export async function listLandedOutputs(
  query: LandedOutputsQuery
): Promise<LandedObjectsPage | null> {
  const database = query.database ?? db;
  const scoped = scopedDb(query.access);
  const viewer = query.access.userId;
  const limit = Math.max(1, Math.min(query.limit, LANDED_OUTPUTS_MAX_LIMIT));
  const actorFilter = query.actor ?? "all";
  const sinceMs = query.since ? Date.parse(query.since) : null;
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid since" });
  }

  if (query.projectId) {
    const [project] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, query.projectId), scoped.predicate(projects))
      )
      .limit(1);
    if (!project) return null;
  }

  const { items, sessions, truncated } = await scanSessionOutputs(database, [
    ...sessionListConditions({
      userId: viewer,
      scope: {
        workspaceLens: query.workspaceLens,
        projectLens: query.projectId,
      },
      status: "all",
      lens: "default",
      kind: "work",
      includeTrackedRuns: true,
      roster: query.access.actor === "operator",
    }),
    scoped.predicate(focusSessions),
  ]);

  const rows = await attachLandedProvenance(database, {
    items,
    sessions,
    viewer,
  });

  const filtered = rows.filter(
    (r) =>
      (sinceMs === null || Date.parse(r.createdAt) >= sinceMs) &&
      matchesLandedActor(r.actor, actorFilter)
  );
  return { ...pageNewestFirst(filtered, query.cursor, limit), truncated };
}

/**
 * Actor + decision for every scanned output, plus the pending rows — in a
 * FIXED number of queries (objects ×2, proposals ×2, pending-target existence
 * ×2, users ×1), never one per row.
 */
export async function attachLandedProvenance(
  database: typeof db,
  input: {
    items: ProjectOutputItem[];
    sessions: ScannedSession[];
    viewer: string;
  }
): Promise<LandedObjectRow[]> {
  const { items, sessions, viewer } = input;
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const sessionIds = sessions.map((s) => s.id);

  const idsOf = (kind: string) => [
    ...new Set(
      items
        .filter((i) => i.kind === kind && UUID_RE.test(i.ref.id))
        .map((i) => i.ref.id)
    ),
  ];
  const entityIds = idsOf("entity");
  const documentIds = idsOf("document");
  const targetIds = [
    ...new Set(items.map((i) => i.ref.id).filter((id) => UUID_RE.test(id))),
  ];

  const [entityRows, documentRows, pendingRows] = await Promise.all([
    entityIds.length
      ? database
          .select({
            id: entities.id,
            userId: entities.userId,
            createdByKind: entities.createdByKind,
            createdByUserId: entities.createdByUserId,
            agentUserId: entities.agentUserId,
            sourceProposalId: entities.sourceProposalId,
            createdAt: entities.createdAt,
          })
          .from(entities)
          .where(inArray(entities.id, entityIds))
      : Promise.resolve([]),
    documentIds.length
      ? database
          .select({
            id: documents.id,
            userId: documents.userId,
            createdByKind: documents.createdByKind,
            createdByUserId: documents.createdByUserId,
            agentUserId: documents.agentUserId,
            sourceProposalId: documents.sourceProposalId,
            createdAt: documents.createdAt,
          })
          .from(documents)
          .where(inArray(documents.id, documentIds))
      : Promise.resolve([]),
    sessionIds.length
      ? database
          .select(proposalFactColumns)
          .from(proposals)
          .where(
            and(
              inArray(proposals.sessionId, sessionIds),
              eq(proposals.status, "pending"),
              inArray(proposals.targetType, [...PROVENANCE_KINDS]),
              userVisibleWhere(proposals.workspaceId, viewer)
            )
          )
      : Promise.resolve([] as ProposalFact[]),
  ]);

  const provenance = new Map<string, ObjectProvenance>();
  for (const r of entityRows) provenance.set(coord("entity", r.id), r);
  for (const r of documentRows) provenance.set(coord("document", r.id), r);

  // Creating proposals: by the stamped lineage, and by target for the
  // receipt path (inline writes stamp no `sourceProposalId`).
  const sourceIds = [
    ...new Set(
      [...provenance.values()]
        .map((p) => p.sourceProposalId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const pendingTargets = [
    ...new Set(
      pendingRows.map((p) => p.targetId).filter((id) => UUID_RE.test(id))
    ),
  ];
  const [targetProposals, sourceProposals, liveEntities, liveDocuments] =
    await Promise.all([
      targetIds.length
        ? database
            .select(proposalFactColumns)
            .from(proposals)
            .where(
              and(
                inArray(proposals.targetId, targetIds),
                userVisibleWhere(proposals.workspaceId, viewer)
              )
            )
        : Promise.resolve([] as ProposalFact[]),
      sourceIds.length
        ? database
            .select(proposalFactColumns)
            .from(proposals)
            .where(
              and(
                inArray(proposals.id, sourceIds),
                userVisibleWhere(proposals.workspaceId, viewer)
              )
            )
        : Promise.resolve([] as ProposalFact[]),
      pendingTargets.length
        ? database
            .select({ id: entities.id })
            .from(entities)
            .where(inArray(entities.id, pendingTargets))
        : Promise.resolve([]),
      pendingTargets.length
        ? database
            .select({ id: documents.id })
            .from(documents)
            .where(inArray(documents.id, pendingTargets))
        : Promise.resolve([]),
    ]);

  const proposalById = new Map<string, ProposalFact>();
  for (const p of [...sourceProposals, ...targetProposals]) {
    proposalById.set(p.id, p);
  }
  const byTarget = new Map<string, ProposalFact[]>();
  for (const p of targetProposals) {
    const key = coord(p.targetType, p.targetId);
    const list = byTarget.get(key) ?? [];
    list.push(p);
    byTarget.set(key, list);
  }

  /** The proposal that CREATED this object, when governance recorded one. */
  const creatingProposal = (
    item: ProjectOutputItem,
    obj: ObjectProvenance | undefined
  ): ProposalFact | undefined => {
    if (obj?.sourceProposalId) {
      const stamped = proposalById.get(obj.sourceProposalId);
      if (stamped) return stamped;
    }
    const bound = (obj?.createdAt ?? new Date(item.createdAt)).getTime();
    return (byTarget.get(coord(item.kind, item.ref.id)) ?? [])
      .filter((p) => p.status !== "pending" && p.createdAt.getTime() <= bound)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  };

  const live = new Set([
    ...liveEntities.map((r) => r.id),
    ...liveDocuments.map((r) => r.id),
  ]);
  const proposedCreations = pendingRows.filter(
    (p) => p.sessionId && sessionById.has(p.sessionId) && !live.has(p.targetId)
  );

  // Resolve every person / agent named anywhere on the page in ONE read.
  type Draft = {
    row: Omit<LandedObjectRow, "actor" | "decision">;
    actor: { kind: "agent" | "human"; id: string | null };
    proposal: ProposalFact | undefined;
  };
  const drafts: Draft[] = [];
  for (const item of items) {
    const session = sessionById.get(item.sessionId);
    if (!session) continue;
    const obj = provenance.get(coord(item.kind, item.ref.id));
    const proposal = creatingProposal(item, obj);
    drafts.push({
      row: {
        id: item.id,
        kind: item.kind,
        title: item.title,
        ref: item.ref,
        ...(item.entityProfile ? { entityProfile: item.entityProfile } : {}),
        createdAt: item.createdAt,
        session: { id: session.id, title: session.title },
      },
      actor: resolveActor({ proposal, obj, item, session }),
      proposal,
    });
  }
  for (const p of proposedCreations) {
    const session = sessionById.get(p.sessionId!)!;
    drafts.push({
      row: {
        id: `proposal:${p.id}`,
        kind: normalizeObjectKind(p.targetType),
        title: proposedTitle(p),
        ref: { kind: "proposal", id: p.id },
        createdAt: p.createdAt.toISOString(),
        session: { id: session.id, title: session.title },
      },
      actor: p.agentUserId
        ? { kind: "agent", id: p.agentUserId }
        : { kind: "human", id: p.proposedByUserId ?? session.userId },
      proposal: p,
    });
  }

  const nameIds = [
    ...new Set(
      drafts.flatMap((d) =>
        [d.actor.id, d.proposal?.reviewedBy].filter((id): id is string =>
          Boolean(id)
        )
      )
    ),
  ];
  const nameById = new Map<string, string>();
  if (nameIds.length) {
    const rows = await database
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        userType: users.userType,
        agentMetadata: users.agentMetadata,
      })
      .from(users)
      .where(inArray(users.id, nameIds));
    for (const u of rows) {
      const name = displayNameForUser(u);
      if (name) nameById.set(u.id, name);
    }
  }

  return drafts.map(({ row, actor, proposal }) => {
    const state = resolveLandedDecision(proposal?.status);
    const decided =
      proposal?.reviewedBy && (state === "approved" || state === "reverted");
    const landedActor: LandedActor =
      actor.kind === "agent"
        ? {
            kind: "agent",
            id: actor.id,
            name: actor.id ? (nameById.get(actor.id) ?? null) : null,
          }
        : {
            kind: "human",
            id: actor.id!,
            name: nameById.get(actor.id!) ?? null,
            isViewer: actor.id === viewer,
          };
    return {
      ...row,
      actor: landedActor,
      decision: {
        state,
        proposalId: proposal?.id ?? null,
        decidedBy: decided
          ? {
              id: proposal!.reviewedBy!,
              name: nameById.get(proposal!.reviewedBy!) ?? null,
            }
          : null,
        decidedAt:
          decided && proposal!.reviewedAt
            ? proposal!.reviewedAt.toISOString()
            : null,
      },
    };
  });
}

const proposalFactColumns = {
  id: proposals.id,
  status: proposals.status,
  targetType: proposals.targetType,
  targetId: proposals.targetId,
  agentUserId: proposals.agentUserId,
  proposedByUserId: proposals.proposedByUserId,
  sessionId: proposals.sessionId,
  reviewedBy: proposals.reviewedBy,
  reviewedAt: proposals.reviewedAt,
  createdAt: proposals.createdAt,
  data: proposals.data,
};

/**
 * WHO made it, in evidence order. A legacy row with no provenance is the
 * owner's (a human), never an agent's.
 */
function resolveActor(input: {
  proposal: ProposalFact | undefined;
  obj: ObjectProvenance | undefined;
  item: ProjectOutputItem;
  session: ScannedSession;
}): { kind: "agent" | "human"; id: string | null } {
  const { proposal, obj, item, session } = input;
  if (proposal?.agentUserId) return { kind: "agent", id: proposal.agentUserId };
  if (obj?.agentUserId) return { kind: "agent", id: obj.agentUserId };
  if (obj?.createdByKind === "agent") return { kind: "agent", id: null };
  // The object RECORDED a non-agent author: that is evidence, and it wins.
  if (obj?.createdByKind) {
    return { kind: "human", id: obj.createdByUserId ?? obj.userId };
  }
  // No provenance on the object (legacy / never stamped): the artifact
  // ledger's `originKind` is the next positive evidence…
  if (item.producedBy === "agent") return { kind: "agent", id: null };
  // …and with none at all, the row is its owner's — a human, never an agent.
  return { kind: "human", id: obj ? (obj.createdByUserId ?? obj.userId) : session.userId };
}

/** The proposed object's name, through the shared proposal-name resolver. */
function proposedTitle(p: ProposalFact): string {
  const data =
    p.data && typeof p.data === "object"
      ? (p.data as Record<string, unknown>)
      : null;
  // The pending door nests the payload in a request envelope (`data.data`);
  // a receipt spreads it flat — the same unwrap `buildRequestFromProposal` does.
  const nested = data?.data;
  const inner =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : data;
  return resolveTargetName({
    targetName: typeof data?.targetName === "string" ? data.targetName : null,
    targetType: p.targetType,
    targetId: p.targetId,
    entityPayload: inner,
  });
}
