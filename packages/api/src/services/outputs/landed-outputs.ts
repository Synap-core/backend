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
 *     an edit, not the creation) — `findCreatingProposals`, the ONE derivation
 *     `proposals.list({ subject })` pins too. Mapped by `resolveLandedDecision`;
 *     a creating proposal the viewer cannot see is `unknown`, and nothing of
 *     it (status, agent, reviewer) is read. `changeCount` is the undo's reach.
 *   - PENDING: a PENDING proposal filed into one of the scanned sessions whose
 *     target does not exist yet — a proposed creation. Never landed: it rides
 *     in `pending` ({ count, ≤3 samples }), apart from the paged `items`, so
 *     the surface shows ONE "N to review ›" row.
 *
 * ── VISIBILITY ──────────────────────────────────────────────────────────────
 * Sessions: `sessionListConditions` (starts from `sessionReadableWhere`) AND
 * `scopedDb(access).predicate(focusSessions)` — the same floors the project
 * door applies. Pending proposals: read BY the floored session ids AND through
 * `userVisibleWhere` — the predicate every other proposal read applies.
 * Creating proposals: read by the floored outputs' ids, UNfloored, carrying
 * `visible` = that same predicate — so a hidden one reads `unknown`.
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
  LANDED_PENDING_SAMPLES,
  matchesLandedActor,
  resolveLandedDecision,
  type LandedDecisionState,
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
  findCreatingProposals,
  type CreatingProposal,
  type CreatingProposalQuery,
} from "../proposals/object-subject.js";
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
  /** Narrow to one track's sessions (the lens read's track scope). */
  trackId?: string;
  /** Narrow to ONE session (the lens read's session scope). */
  sessionId?: string;
  /** Only rows that landed (or were proposed) at or after this instant (ISO). */
  since?: string;
  actor?: LandedActorFilter;
  cursor?: string;
  limit: number;
}

/** The kinds whose rows carry provenance columns this door reads. */
const PROVENANCE_KINDS = ["entity", "document"] as const;

interface ObjectProvenance {
  userId: string;
  createdByKind: string | null;
  createdByUserId: string | null;
  agentUserId: string | null;
  sourceProposalId: string | null;
  createdAt: Date;
}

/** A PENDING proposed creation — the only proposal read that needs `data`. */
interface PendingFact {
  id: string;
  targetType: string;
  targetId: string;
  agentUserId: string | null;
  proposedByUserId: string | null;
  sessionId: string | null;
  createdAt: Date;
  data: unknown;
}

const coord = (kind: string, id: string) =>
  `${normalizeObjectKind(kind)}:${id}`;

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
      .where(and(eq(projects.id, query.projectId), scoped.predicate(projects)))
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
      ...(query.trackId ? { trackId: query.trackId } : {}),
    }),
    ...(query.sessionId ? [eq(focusSessions.id, query.sessionId)] : []),
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
  // Pending creations are NOT landed: they ride apart, as a count plus the
  // newest few, for ONE "N to review ›" row — never mixed into the page.
  const landed = filtered.filter((r) => r.decision.state !== "pending");
  const pending = filtered
    .filter((r) => r.decision.state === "pending")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    ...pageNewestFirst(landed, query.cursor, limit),
    pending: {
      count: pending.length,
      samples: pending.slice(0, LANDED_PENDING_SAMPLES),
    },
    truncated,
  };
}

/**
 * Actor + decision for every scanned output, plus the pending rows — in a
 * FIXED number of queries (objects ×2, pending ×1, pending-target existence
 * ×2, creating proposals ×2, users ×1), never one per row. Only the pending
 * read selects `proposals.data` (its title lives there).
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
          .select({
            id: proposals.id,
            targetType: proposals.targetType,
            targetId: proposals.targetId,
            agentUserId: proposals.agentUserId,
            proposedByUserId: proposals.proposedByUserId,
            sessionId: proposals.sessionId,
            createdAt: proposals.createdAt,
            data: proposals.data,
          })
          .from(proposals)
          .where(
            and(
              inArray(proposals.sessionId, sessionIds),
              eq(proposals.status, "pending"),
              inArray(proposals.targetType, [...PROVENANCE_KINDS]),
              userVisibleWhere(proposals.workspaceId, viewer)
            )
          )
      : Promise.resolve([] as PendingFact[]),
  ]);

  const provenance = new Map<string, ObjectProvenance>();
  for (const r of entityRows) provenance.set(coord("entity", r.id), r);
  for (const r of documentRows) provenance.set(coord("document", r.id), r);

  // THE creating proposal per output (`findCreatingProposals`, the same
  // derivation `proposals.list({ subject })` pins). Bound = the object's own
  // creation; an output with no object row is bounded by when it was produced.
  const creatingQueries = new Map<string, CreatingProposalQuery>();
  for (const item of items) {
    if (!UUID_RE.test(item.ref.id) || creatingQueries.has(item.ref.id))
      continue;
    const obj = provenance.get(coord(item.kind, item.ref.id));
    creatingQueries.set(item.ref.id, {
      id: item.ref.id,
      sourceProposalId: obj?.sourceProposalId ?? null,
      bound: obj?.createdAt ?? new Date(item.createdAt),
    });
  }
  const pendingTargets = [
    ...new Set(
      pendingRows.map((p) => p.targetId).filter((id) => UUID_RE.test(id))
    ),
  ];
  const [creating, liveEntities, liveDocuments] = await Promise.all([
    findCreatingProposals(database, [...creatingQueries.values()], viewer),
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

  const live = new Set([
    ...liveEntities.map((r) => r.id),
    ...liveDocuments.map((r) => r.id),
  ]);
  const proposedCreations = pendingRows.filter(
    (p) => p.sessionId && sessionById.has(p.sessionId) && !live.has(p.targetId)
  );

  type Draft = {
    row: Omit<LandedObjectRow, "actor" | "decision">;
    actor: { kind: "agent" | "human"; id: string | null };
    decision: {
      state: LandedDecisionState;
      proposalId: string | null;
      reviewedBy: string | null;
      reviewedAt: Date | null;
      changeCount: number | null;
    };
  };
  const drafts: Draft[] = [];
  for (const item of items) {
    const session = sessionById.get(item.sessionId);
    if (!session) continue;
    const obj = provenance.get(coord(item.kind, item.ref.id));
    const found = creating.get(item.ref.id);
    // A creating proposal the viewer cannot see is an UNKNOWN decision, and
    // NOTHING of it is read: not its status, not its agent, not its reviewer.
    const seen = found?.visible ? found : undefined;
    const state = found
      ? resolveLandedDecision(found.status, { visible: found.visible })
      : resolveLandedDecision(null);
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
      actor: resolveActor({ proposal: seen, obj, item, session }),
      decision: {
        state,
        proposalId: seen?.id ?? null,
        reviewedBy: seen?.reviewedBy ?? null,
        reviewedAt: seen?.reviewedAt ?? null,
        changeCount: seen?.changeCount ?? null,
      },
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
        createdAt: new Date(p.createdAt).toISOString(),
        session: { id: session.id, title: session.title },
      },
      actor: p.agentUserId
        ? { kind: "agent", id: p.agentUserId }
        : { kind: "human", id: p.proposedByUserId ?? session.userId },
      decision: {
        state: "pending",
        proposalId: p.id,
        reviewedBy: null,
        reviewedAt: null,
        changeCount: null,
      },
    });
  }

  // Resolve every person / agent named anywhere on the page in ONE read.
  const nameIds = [
    ...new Set(
      drafts.flatMap((d) =>
        [d.actor.id, d.decision.reviewedBy].filter((id): id is string =>
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

  return drafts.map(({ row, actor, decision }) => {
    const decided =
      decision.reviewedBy &&
      (decision.state === "approved" || decision.state === "reverted");
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
        state: decision.state,
        proposalId: decision.proposalId,
        decidedBy: decided
          ? {
              id: decision.reviewedBy!,
              name: nameById.get(decision.reviewedBy!) ?? null,
            }
          : null,
        decidedAt:
          decided && decision.reviewedAt
            ? decision.reviewedAt.toISOString()
            : null,
        changeCount: decision.changeCount,
      },
    };
  });
}

/**
 * WHO made it, in evidence order. A legacy row with no provenance is the
 * owner's (a human), never an agent's. An INVISIBLE creating proposal is
 * never read here (`proposal` is undefined for it).
 */
function resolveActor(input: {
  proposal: CreatingProposal | undefined;
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
  return {
    kind: "human",
    id: obj ? (obj.createdByUserId ?? obj.userId) : session.userId,
  };
}

/** The proposed object's name, through the shared proposal-name resolver. */
function proposedTitle(p: PendingFact): string {
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
