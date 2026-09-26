/**
 * THE SHARE CORE (Sites W2 S3) — every owner share door calls this module:
 * tRPC `shares.*`, Hub REST `/shares*`, the `relations.exposeToAnchor` alias,
 * and the `share/create` approval executor. No door re-implements a rule.
 *
 * MODEL (0276 + S2 floor)
 *   - An ANCHOR is always a `projects` row with a workspace. A pod-personal
 *     (NULL-workspace) project is refused.
 *   - GUEST exposure = the record becomes readable by the anchor's members,
 *     guests included:
 *       entity   → a `visible_to` edge  entity → project
 *       document → its ENTITY's edge (documents follow their entity); a
 *                  document with no owning entity cannot be shared
 *       view     → `views.exposed_at/exposed_by` (+ `project_id` = anchor when
 *                  the view was unpinned; a view pinned to ANOTHER project, and
 *                  a scoped surface, are refused)
 *       project  → nothing to expose (members already see their project); a
 *                  project is shared by LINK only
 *   - A LINK = a `resource_shares` row (audience 'link', anchored) whose token
 *     redeems into a `project_members` row with role 'guest'. A link share also
 *     writes the guest exposure, so a redeemer sees what the link names.
 *
 * GOVERNANCE. `share.create` is ADMIN-floored in `@synap/governance-policy`:
 * the human owner shares DIRECTLY (the gate grants a non-agent principal), an
 * agent ALWAYS gets a proposal and no `governance_rules` row can widen it.
 * Approval (`share-executors.ts`) replays `applyShare` re-floored on the
 * proposal's subject, and creates a link row WITHOUT a token — only a signed-in
 * human mints the secret (`rotateLink`). Unshare / revoke narrow access and are
 * DIRECT for everyone, agents included.
 *
 * SECRETS. A link token is shown ONCE (`share` for a human, `rotateLink`) and
 * stored as its SHA-256 only (`utils/share-token.ts`); `public_token` is never
 * written. It is never logged: no logger call in this module takes it, the tRPC
 * audit middleware redacts an input key named `token`, and no audit payload
 * carries it. Redemption looks it up through the unique `token_hash` index —
 * never a scan — and answers every miss (unknown, revoked, expired) with the
 * SAME NOT_FOUND.
 */

import { TRPCError } from "@trpc/server";
import {
  getDb,
  and,
  eq,
  isNull,
  isNotNull,
  desc,
  eventRepository,
  RelationRepository,
  ProjectMemberRepository,
  WorkspaceRepository,
  getActingAgentUserId,
} from "@synap/database";
import {
  entities,
  views,
  projects,
  relations,
  resourceShares,
  projectMembers,
  workspaces,
} from "@synap/database/schema";
import { randomUUID } from "node:crypto";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { auditLog } from "../../utils/audit-log.js";
import { generateShareToken, hashToken } from "../../utils/share-token.js";
import { VISIBLE_TO } from "../../utils/project-scope.js";
import { assertAnchorAdmin } from "./anchor-admin.js";
import {
  parseExposurePolicyInput,
  resolveExposurePolicy,
  type ResolvedExposurePolicy,
  type ShareKind,
} from "./exposure-policy.js";

// ── Actor ────────────────────────────────────────────────────────────────────

/** Who is calling. Built by each door from its own auth context. */
export interface ShareActor {
  /** The human the write is for (an agent key's linked operator). */
  userId: string;
  /** The acting agent, when the caller is one. */
  agentUserId?: string | null;
  /** Request source (`ai` / `intelligence` for an AI-sourced call). */
  source?: string | null;
  /** Set for any API-key authenticated request (never for a Kratos session). */
  keyType?: string | null;
  reasoning?: string;
}

/** The acting agent (ambient scope first). Shared with `publish-service.ts`. */
export function agentOf(actor: ShareActor): string | null {
  return getActingAgentUserId() ?? actor.agentUserId ?? null;
}

/**
 * The doors only a SIGNED-IN HUMAN may use: set the policy, mint a secret,
 * redeem one. An agent (attributed or ambient), an AI-sourced call and any
 * API-key request are refused — an agent must never hold a link secret, and
 * "agents get no set_policy door".
 */
function assertHumanSession(actor: ShareActor, what: string): void {
  if (
    agentOf(actor) ||
    actor.keyType ||
    actor.source === "ai" ||
    actor.source === "intelligence"
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${what} is a signed-in person's action; agents and API keys cannot do it.`,
    });
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

export const SHARE_AUDIENCES = ["guest", "link"] as const;
export type ShareAudience = (typeof SHARE_AUDIENCES)[number];

/** A share target after resolution. `document` resolves to its entity. */
type Target =
  | { kind: "entity"; id: string; workspaceId: string | null; ownerId: string }
  | {
      kind: "view";
      id: string;
      workspaceId: string | null;
      ownerId: string;
      projectId: string | null;
      exposedAt: Date | null;
      metadata: Record<string, unknown>;
    }
  | {
      kind: "project";
      id: string;
      workspaceId: string | null;
      ownerId: string;
    };

interface Anchor {
  id: string;
  workspaceId: string;
  userId: string;
}

type Db = Awaited<ReturnType<typeof getDb>>;

const notFound = (what: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
const badRequest = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

async function loadTarget(
  database: Db,
  kind: ShareKind,
  id: string
): Promise<Target> {
  if (kind === "entity" || kind === "document") {
    const [row] = await database
      .select({
        id: entities.id,
        workspaceId: entities.workspaceId,
        userId: entities.userId,
      })
      .from(entities)
      .where(
        and(
          kind === "entity" ? eq(entities.id, id) : eq(entities.documentId, id),
          isNull(entities.deletedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw kind === "entity"
        ? notFound("Entity")
        : badRequest(
            "This document has no owning entity, so it cannot be shared (a document follows its entity)."
          );
    }
    return {
      kind: "entity",
      id: row.id,
      workspaceId: row.workspaceId,
      ownerId: row.userId,
    };
  }
  if (kind === "view") {
    const [row] = await database
      .select({
        id: views.id,
        workspaceId: views.workspaceId,
        userId: views.userId,
        projectId: views.projectId,
        exposedAt: views.exposedAt,
        metadata: views.metadata,
      })
      .from(views)
      .where(eq(views.id, id))
      .limit(1);
    if (!row) throw notFound("View");
    return {
      kind: "view",
      id: row.id,
      workspaceId: row.workspaceId,
      ownerId: row.userId,
      projectId: row.projectId,
      exposedAt: row.exposedAt,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    };
  }
  const [row] = await database
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      userId: projects.userId,
    })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!row) throw notFound("Project");
  return {
    kind: "project",
    id: row.id,
    workspaceId: row.workspaceId,
    ownerId: row.userId,
  };
}

async function loadAnchor(
  database: Db,
  anchorProjectId: string
): Promise<Anchor> {
  const [row] = await database
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      userId: projects.userId,
    })
    .from(projects)
    .where(eq(projects.id, anchorProjectId))
    .limit(1);
  if (!row) throw notFound("Anchor project");
  if (!row.workspaceId) {
    throw badRequest(
      "A pod-personal project (no workspace) cannot anchor a share."
    );
  }
  return { id: row.id, workspaceId: row.workspaceId, userId: row.userId };
}

async function loadPolicy(
  database: Db,
  workspaceId: string
): Promise<ResolvedExposurePolicy> {
  const [ws] = await database
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw notFound("Workspace");
  return resolveExposurePolicy(ws.settings);
}

// ── Share (the gate) ─────────────────────────────────────────────────────────

export interface ShareRequest {
  resourceType: ShareKind;
  resourceId: string;
  /** Omitted for a project → the project itself. */
  anchorProjectId?: string;
  audience: ShareAudience;
  /** Links only. */
  expiresAt?: Date | null;
}

/** The validated, authorized plan — what the gate carries and approval replays. */
export interface SharePlan {
  requestedKind: ShareKind;
  target: Target;
  anchor: Anchor;
  audience: ShareAudience;
  expiresAt: Date | null;
  /** The workspace whose policy (and governance) applies. */
  policyWorkspaceId: string;
}

/**
 * Validate + authorize a share for `userId` (the human the write is for). Every
 * check reads LOADED rows, never request-supplied workspace ids. Re-run
 * verbatim by the approval executor on the proposal's subject.
 */
export async function planShare(
  database: Db,
  userId: string,
  req: ShareRequest
): Promise<SharePlan> {
  const target = await loadTarget(database, req.resourceType, req.resourceId);
  const anchorId =
    req.anchorProjectId ?? (target.kind === "project" ? target.id : undefined);
  if (!anchorId) throw badRequest("anchorProjectId is required");
  const anchor = await loadAnchor(database, anchorId);

  if (target.kind === "project") {
    if (req.audience !== "link") {
      throw badRequest(
        "A project is shared by link; its members already see it."
      );
    }
    if (anchor.id !== target.id) {
      throw badRequest("A project link must be anchored on that project.");
    }
  }
  if (target.kind === "view") {
    if (target.metadata.scopedSurface === true) {
      throw badRequest(
        "A scoped surface (a lens's canonical board or home) cannot be shared."
      );
    }
    if (target.projectId && target.projectId !== anchor.id) {
      throw badRequest(
        "This view is pinned to another project and cannot be shared with this one."
      );
    }
  }
  if (req.audience !== "link" && req.expiresAt) {
    throw badRequest("Only a link can expire.");
  }
  if (req.expiresAt && req.expiresAt.getTime() <= Date.now()) {
    throw badRequest("expiresAt must be in the future.");
  }

  // AuthZ on the LOADED rows: write the record AND administer the anchor.
  await assertWorkspaceWrite(database, userId, {
    workspaceId: target.workspaceId,
    ownerId: target.ownerId,
  });
  await assertAnchorAdmin(database, userId, anchor);

  // Policy: the record's workspace; a pod-wide record uses the anchor's.
  const policyWorkspaceId = target.workspaceId ?? anchor.workspaceId;
  const policy = await loadPolicy(database, policyWorkspaceId);
  if (policy[req.resourceType][req.audience].read !== "direct") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This workspace's exposure policy does not allow sharing a ${req.resourceType} with ${req.audience === "link" ? "a link" : "guests"}.`,
    });
  }

  return {
    requestedKind: req.resourceType,
    target,
    anchor,
    audience: req.audience,
    expiresAt: req.expiresAt ?? null,
    policyWorkspaceId,
  };
}

export type ShareResult =
  | { status: "proposed"; proposalId: string }
  | {
      status: "created" | "exists";
      resourceType: Target["kind"];
      resourceId: string;
      anchorProjectId: string;
      audience: ShareAudience;
      /** The link row, for a link share. */
      shareId?: string;
      /** Plaintext link token — present ONCE, on a human's fresh link only. */
      token?: string;
      /** Rows the write statements reported (0 when everything existed). */
      rowsWritten: number;
    };

/** The gate payload an agent's proposal stores (never a token). */
function proposalData(plan: SharePlan, req: ShareRequest) {
  return {
    id: randomUUID(),
    resourceType: req.resourceType,
    resourceId: req.resourceId,
    resolvedResourceType: plan.target.kind,
    resolvedResourceId: plan.target.id,
    anchorProjectId: plan.anchor.id,
    audience: plan.audience,
    expiresAt: plan.expiresAt ? plan.expiresAt.toISOString() : null,
    workspaceId: plan.policyWorkspaceId,
  };
}

/**
 * THE owner share door. A human is applied directly (and, for a new link,
 * handed its token once); an agent gets a proposal.
 */
export async function shareResource(
  actor: ShareActor,
  req: ShareRequest
): Promise<ShareResult> {
  const agentUserId = agentOf(actor);
  // ATTRIBUTION FLOOR: an API key with no agent behind it (a bare `user_pat` /
  // `service` / `hub_inbound` key) is neither the signed-in owner nor an
  // attributable agent — the gate would read it as the human and apply it
  // directly. Refused at every share door, like `/mcp` refuses such writes.
  if (actor.keyType && !agentUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Sharing needs a signed-in person or an agent key (run `synap init`); this API key is not attributed to either.",
    });
  }
  const database = await getDb();
  const plan = await planShare(database, actor.userId, req);

  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: agentUserId ?? undefined,
    workspaceId: plan.policyWorkspaceId,
    subjectType: "share",
    action: "create",
    source: actor.source ?? undefined,
    reasoning: actor.reasoning,
    data: proposalData(plan, req),
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }
  // Belt and braces: `share.create` is ADMIN-floored, so an agent can never be
  // granted here. If it ever were, it still gets no token.
  return applyShare(database, plan, {
    userId: actor.userId,
    agentUserId,
    mintToken: agentUserId === null,
  });
}

/**
 * Write an authorized plan. Idempotent: an existing exposure / live link is
 * reported as `exists` (and never re-mints a token — `rotateLink` does that).
 */
export async function applyShare(
  database: Db,
  plan: SharePlan,
  opts: {
    userId: string;
    agentUserId?: string | null;
    sourceProposalId?: string;
    mintToken: boolean;
  }
): Promise<Extract<ShareResult, { status: "created" | "exists" }>> {
  const { target, anchor } = plan;
  let exposed: "created" | "exists" | "none" = "none";
  // Rows the WRITE statements reported (RETURNING), for the approval receipt —
  // never inferred from "we got here".
  let rowsWritten = 0;

  if (target.kind === "entity") {
    const [edge] = await database
      .select({ id: relations.id })
      .from(relations)
      .where(
        and(
          eq(relations.sourceEntityId, target.id),
          eq(relations.targetEntityId, anchor.id),
          eq(relations.type, VISIBLE_TO)
        )
      )
      .limit(1);
    if (edge) {
      exposed = "exists";
    } else {
      const edgeRow = await new RelationRepository(
        database,
        eventRepository
      ).create(
        {
          id: randomUUID(),
          sourceEntityId: target.id,
          targetEntityId: anchor.id,
          type: VISIBLE_TO,
          workspaceId: anchor.workspaceId,
          userId: opts.userId,
          agentUserId: opts.agentUserId ?? undefined,
          sourceProposalId: opts.sourceProposalId,
        },
        opts.userId
      );
      rowsWritten += edgeRow ? 1 : 0;
      exposed = "created";
    }
  } else if (target.kind === "view") {
    // Re-read inside the write: the plan may be days old (a proposal).
    const [row] = await database
      .select({ projectId: views.projectId, exposedAt: views.exposedAt })
      .from(views)
      .where(eq(views.id, target.id))
      .limit(1);
    if (!row) throw notFound("View");
    if (row.projectId && row.projectId !== anchor.id) {
      throw badRequest(
        "This view is pinned to another project and cannot be shared with this one."
      );
    }
    if (row.projectId === anchor.id && row.exposedAt) {
      exposed = "exists";
    } else {
      const updatedViews = await database
        .update(views)
        .set({
          projectId: anchor.id,
          exposedAt: new Date(),
          exposedBy: opts.userId,
          // Remember that SHARING pinned this view, so unshare can unpin it
          // again instead of leaving it looking like a project surface.
          ...(row.projectId
            ? {}
            : {
                metadata: {
                  ...target.metadata,
                  exposurePinnedProject: true,
                },
              }),
          updatedAt: new Date(),
        })
        .where(eq(views.id, target.id))
        .returning({ id: views.id });
      rowsWritten += updatedViews.length;
      exposed = "created";
    }
  }

  let shareId: string | undefined;
  let token: string | undefined;
  let linkStatus: "created" | "exists" | "none" = "none";
  if (plan.audience === "link") {
    const [live] = await database
      .select({ id: resourceShares.id })
      .from(resourceShares)
      .where(
        and(
          eq(resourceShares.resourceType, target.kind),
          eq(resourceShares.resourceId, target.id),
          eq(resourceShares.anchorProjectId, anchor.id),
          eq(resourceShares.audience, "link"),
          isNull(resourceShares.revokedAt)
        )
      )
      .limit(1);
    if (live) {
      shareId = live.id;
      linkStatus = "exists";
    } else {
      const minted = opts.mintToken ? generateShareToken() : undefined;
      const [row] = await database
        .insert(resourceShares)
        .values({
          resourceType: target.kind,
          resourceId: target.id,
          workspaceId: target.workspaceId,
          audience: "link",
          anchorProjectId: anchor.id,
          state: "draft",
          expiresAt: plan.expiresAt,
          createdBy: opts.userId,
          permissions: { read: true },
          tokenHash: minted ? hashToken(minted) : null,
          tokenPrefix: minted ? minted.slice(0, 6) : null,
        })
        .returning({ id: resourceShares.id });
      shareId = row!.id;
      rowsWritten += row ? 1 : 0;
      token = minted;
      linkStatus = "created";
    }
  }

  const created = exposed === "created" || linkStatus === "created";
  auditLog({
    subjectType: "sharing",
    action: "create",
    phase: "completed",
    subjectId: shareId ?? target.id,
    userId: opts.userId,
    agentUserId: opts.agentUserId ?? undefined,
    proposalId: opts.sourceProposalId,
    workspaceId: anchor.workspaceId,
    data: {
      resourceType: target.kind,
      resourceId: target.id,
      anchorProjectId: anchor.id,
      audience: plan.audience,
      ...(shareId ? { shareId } : {}),
      outcome: created ? "created" : "exists",
    },
  });

  return {
    status: created ? "created" : "exists",
    resourceType: target.kind,
    resourceId: target.id,
    anchorProjectId: anchor.id,
    audience: plan.audience,
    ...(shareId ? { shareId } : {}),
    ...(token ? { token } : {}),
    rowsWritten,
  };
}

// ── Unshare / revoke (direct for everyone) ──────────────────────────────────

/**
 * Stop sharing a record with a project: remove the guest exposure AND revoke
 * every live link of it into that project. Direct for everyone (it only
 * narrows); the caller must still administer the anchor or write the record.
 * Guests who already joined keep their membership (they lose sight of this
 * record only).
 */
export async function unshareResource(
  actor: ShareActor,
  req: { resourceType: ShareKind; resourceId: string; anchorProjectId?: string }
): Promise<{ status: "removed" | "none"; revokedLinks: number }> {
  const database = await getDb();
  const target = await loadTarget(database, req.resourceType, req.resourceId);
  const anchorId =
    req.anchorProjectId ?? (target.kind === "project" ? target.id : undefined);
  if (!anchorId) throw badRequest("anchorProjectId is required");
  const anchor = await loadAnchor(database, anchorId);
  await assertCanNarrow(database, actor.userId, target, anchor);

  let removed = false;
  if (target.kind === "entity") {
    const edges = await database
      .select({ id: relations.id, userId: relations.userId })
      .from(relations)
      .where(
        and(
          eq(relations.sourceEntityId, target.id),
          eq(relations.targetEntityId, anchor.id),
          eq(relations.type, VISIBLE_TO)
        )
      );
    const repo = new RelationRepository(database, eventRepository);
    for (const edge of edges) {
      // The repository deletes by (id, owner); the edge's own owner is passed
      // so an anchor admin can remove an edge someone else minted. The ACTOR
      // is recorded in the sharing audit row below.
      await repo.delete(edge.id, edge.userId ?? actor.userId);
      removed = true;
    }
  } else if (target.kind === "view") {
    if (target.projectId === anchor.id && target.exposedAt) {
      const pinnedByShare = target.metadata.exposurePinnedProject === true;
      const { exposurePinnedProject: _drop, ...metadata } = target.metadata;
      await database
        .update(views)
        .set({
          exposedAt: null,
          exposedBy: null,
          ...(pinnedByShare ? { projectId: null, metadata } : {}),
          updatedAt: new Date(),
        })
        .where(eq(views.id, target.id));
      removed = true;
    }
  }

  const revoked = await database
    .update(resourceShares)
    .set({
      revokedAt: new Date(),
      revokedBy: actor.userId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resourceShares.resourceType, target.kind),
        eq(resourceShares.resourceId, target.id),
        eq(resourceShares.anchorProjectId, anchor.id),
        isNull(resourceShares.revokedAt)
      )
    )
    .returning({ id: resourceShares.id });

  if (removed || revoked.length > 0) {
    auditLog({
      subjectType: "sharing",
      action: "delete",
      phase: "completed",
      subjectId: target.id,
      userId: actor.userId,
      agentUserId: agentOf(actor) ?? undefined,
      workspaceId: anchor.workspaceId,
      data: {
        resourceType: target.kind,
        resourceId: target.id,
        anchorProjectId: anchor.id,
        exposureRemoved: removed,
        revokedShareIds: revoked.map((r) => r.id),
      },
    });
  }
  return {
    status: removed || revoked.length > 0 ? "removed" : "none",
    revokedLinks: revoked.length,
  };
}

/** Narrowing needs LESS than sharing: administer the anchor OR write the record. */
async function assertCanNarrow(
  database: Db,
  userId: string,
  target: Target,
  anchor: Anchor
): Promise<void> {
  try {
    await assertAnchorAdmin(database, userId, anchor);
    return;
  } catch {
    // fall through to the record-write check
  }
  await assertWorkspaceWrite(database, userId, {
    workspaceId: target.workspaceId,
    ownerId: target.ownerId,
  });
}

async function loadLink(database: Db, shareId: string) {
  const [row] = await database
    .select({
      id: resourceShares.id,
      resourceType: resourceShares.resourceType,
      resourceId: resourceShares.resourceId,
      audience: resourceShares.audience,
      anchorProjectId: resourceShares.anchorProjectId,
      revokedAt: resourceShares.revokedAt,
      expiresAt: resourceShares.expiresAt,
    })
    .from(resourceShares)
    .where(eq(resourceShares.id, shareId))
    .limit(1);
  if (!row || row.audience !== "link" || !row.anchorProjectId) {
    throw notFound("Link");
  }
  return row as typeof row & { anchorProjectId: string };
}

/**
 * Revoke ONE link, permanently (0276 trigger: a revoked row is frozen; sharing
 * again creates a NEW row). Guests who already joined through it stay members.
 */
export async function revokeLink(
  actor: ShareActor,
  shareId: string
): Promise<{ status: "revoked" | "already_revoked"; shareId: string }> {
  const database = await getDb();
  const link = await loadLink(database, shareId);
  const anchor = await loadAnchor(database, link.anchorProjectId);
  await assertAnchorAdmin(database, actor.userId, anchor);
  if (link.revokedAt) return { status: "already_revoked", shareId };
  await database
    .update(resourceShares)
    .set({
      revokedAt: new Date(),
      revokedBy: actor.userId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(resourceShares.id, shareId), isNull(resourceShares.revokedAt))
    );
  auditLog({
    subjectType: "sharing",
    action: "delete",
    phase: "completed",
    subjectId: shareId,
    userId: actor.userId,
    agentUserId: agentOf(actor) ?? undefined,
    workspaceId: anchor.workspaceId,
    data: {
      shareId,
      resourceType: link.resourceType,
      resourceId: link.resourceId,
      anchorProjectId: anchor.id,
      revoked: true,
    },
  });
  return { status: "revoked", shareId };
}

/**
 * Mint (or replace) a link's secret. HUMAN only. Returns the plaintext ONCE;
 * only its hash and a 6-character display prefix are stored. A revoked or
 * expired link cannot be re-tokened — share again for a new one.
 */
export async function rotateLink(
  actor: ShareActor,
  shareId: string
): Promise<{ shareId: string; token: string; tokenPrefix: string }> {
  assertHumanSession(actor, "Minting a link");
  const database = await getDb();
  const link = await loadLink(database, shareId);
  const anchor = await loadAnchor(database, link.anchorProjectId);
  await assertAnchorAdmin(database, actor.userId, anchor);
  if (link.revokedAt) {
    throw badRequest("This link was revoked; share again to get a new link.");
  }
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    throw badRequest("This link has expired; share again to get a new link.");
  }
  const token = generateShareToken();
  const tokenPrefix = token.slice(0, 6);
  const updated = await database
    .update(resourceShares)
    .set({ tokenHash: hashToken(token), tokenPrefix, updatedAt: new Date() })
    .where(
      and(eq(resourceShares.id, shareId), isNull(resourceShares.revokedAt))
    )
    .returning({ id: resourceShares.id });
  if (updated.length === 0) {
    throw badRequest("This link was revoked; share again to get a new link.");
  }
  auditLog({
    subjectType: "sharing",
    action: "update",
    phase: "completed",
    subjectId: shareId,
    userId: actor.userId,
    workspaceId: anchor.workspaceId,
    // The prefix is display-only (already shown in listShares); the token and
    // its hash never enter an audit row.
    data: { shareId, tokenRotated: true, tokenPrefix },
  });
  return { shareId, token, tokenPrefix };
}

/** The ONE answer for every redemption miss — no oracle between unknown,
 *  revoked and expired. */
const LINK_UNAVAILABLE = () =>
  new TRPCError({ code: "NOT_FOUND", message: "This link is not available." });

/**
 * A signed-in person presents a link token and becomes a GUEST of its anchor
 * project. Indexed hash lookup (unique `token_hash` index), never a scan.
 * Idempotent: an existing membership (any role) is returned as-is — a link
 * never demotes or promotes an existing member.
 */
export async function redeemLink(
  actor: ShareActor,
  token: string
): Promise<{ status: "joined" | "already_member"; projectId: string }> {
  assertHumanSession(actor, "Redeeming a link");
  if (typeof token !== "string" || token.length < 16 || token.length > 256) {
    throw LINK_UNAVAILABLE();
  }
  const database = await getDb();
  const [link] = await database
    .select({
      id: resourceShares.id,
      audience: resourceShares.audience,
      anchorProjectId: resourceShares.anchorProjectId,
      revokedAt: resourceShares.revokedAt,
      expiresAt: resourceShares.expiresAt,
    })
    .from(resourceShares)
    .where(eq(resourceShares.tokenHash, hashToken(token)))
    .limit(1);
  if (
    !link ||
    link.audience !== "link" ||
    !link.anchorProjectId ||
    link.revokedAt ||
    (link.expiresAt && link.expiresAt.getTime() <= Date.now())
  ) {
    throw LINK_UNAVAILABLE();
  }
  const projectId = link.anchorProjectId;

  const [existing] = await database
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, actor.userId)
      )
    )
    .limit(1);
  if (existing) return { status: "already_member", projectId };

  const [anchor] = await database
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!anchor) throw LINK_UNAVAILABLE();

  let memberId: string;
  try {
    const member = await new ProjectMemberRepository(
      database,
      eventRepository
    ).add(
      {
        projectId,
        userId: actor.userId,
        role: "guest",
        grantedViaShareId: link.id,
      },
      actor.userId
    );
    memberId = member.id;
  } catch (err) {
    // A concurrent redeem won the (project, user) unique index: same outcome.
    const [raced] = await database
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, actor.userId)
        )
      )
      .limit(1);
    if (raced) return { status: "already_member", projectId };
    throw err;
  }
  await database
    .update(resourceShares)
    .set({ lastAccessedAt: new Date() })
    .where(eq(resourceShares.id, link.id));
  auditLog({
    subjectType: "projectMember",
    action: "create",
    phase: "completed",
    subjectId: memberId,
    userId: actor.userId,
    workspaceId: anchor.workspaceId,
    data: { projectId, role: "guest", grantedViaShareId: link.id },
  });
  return { status: "joined", projectId };
}

// ── Listing ──────────────────────────────────────────────────────────────────

export const LIST_SHARES_CAP = 100;

export interface ShareListing {
  exposures: Array<{
    resourceType: "entity" | "view";
    resourceId: string;
    anchorProjectId: string;
  }>;
  links: Array<{
    id: string;
    resourceType: string;
    resourceId: string;
    anchorProjectId: string | null;
    tokenPrefix: string | null;
    hasToken: boolean;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    createdBy: string;
  }>;
  /** True when either list hit {@link LIST_SHARES_CAP}. */
  truncated: boolean;
}

/**
 * Who a record is shared with (by resource) or what a project shares (by
 * anchor). Capped. Never returns a token or its hash. The caller must be able
 * to administer the anchor, or write the record.
 */
export async function listShares(
  actor: ShareActor,
  req:
    | { resourceType: ShareKind; resourceId: string }
    | { anchorProjectId: string }
): Promise<ShareListing> {
  const database = await getDb();
  const cap = LIST_SHARES_CAP;
  const exposures: ShareListing["exposures"] = [];

  let linkWhere;
  if ("anchorProjectId" in req) {
    const anchor = await loadAnchor(database, req.anchorProjectId);
    await assertAnchorAdmin(database, actor.userId, anchor);
    const edges = await database
      .select({ sourceEntityId: relations.sourceEntityId })
      .from(relations)
      .where(
        and(
          eq(relations.targetEntityId, anchor.id),
          eq(relations.type, VISIBLE_TO)
        )
      )
      .orderBy(desc(relations.createdAt))
      .limit(cap);
    for (const e of edges) {
      if (e.sourceEntityId)
        exposures.push({
          resourceType: "entity",
          resourceId: e.sourceEntityId,
          anchorProjectId: anchor.id,
        });
    }
    const exposedViews = await database
      .select({ id: views.id })
      .from(views)
      .where(and(eq(views.projectId, anchor.id), isNotNull(views.exposedAt)))
      .orderBy(desc(views.exposedAt))
      .limit(cap);
    for (const v of exposedViews) {
      exposures.push({
        resourceType: "view",
        resourceId: v.id,
        anchorProjectId: anchor.id,
      });
    }
    linkWhere = eq(resourceShares.anchorProjectId, anchor.id);
  } else {
    const target = await loadTarget(database, req.resourceType, req.resourceId);
    await assertWorkspaceWrite(database, actor.userId, {
      workspaceId: target.workspaceId,
      ownerId: target.ownerId,
    });
    if (target.kind === "entity") {
      const edges = await database
        .select({ targetEntityId: relations.targetEntityId })
        .from(relations)
        .where(
          and(
            eq(relations.sourceEntityId, target.id),
            eq(relations.type, VISIBLE_TO)
          )
        )
        .limit(cap);
      for (const e of edges) {
        if (e.targetEntityId)
          exposures.push({
            resourceType: "entity",
            resourceId: target.id,
            anchorProjectId: e.targetEntityId,
          });
      }
    } else if (target.kind === "view" && target.projectId && target.exposedAt) {
      exposures.push({
        resourceType: "view",
        resourceId: target.id,
        anchorProjectId: target.projectId,
      });
    }
    linkWhere = and(
      eq(resourceShares.resourceType, target.kind),
      eq(resourceShares.resourceId, target.id)
    );
  }

  const rows = await database
    .select({
      id: resourceShares.id,
      resourceType: resourceShares.resourceType,
      resourceId: resourceShares.resourceId,
      anchorProjectId: resourceShares.anchorProjectId,
      tokenPrefix: resourceShares.tokenPrefix,
      tokenHash: resourceShares.tokenHash,
      expiresAt: resourceShares.expiresAt,
      revokedAt: resourceShares.revokedAt,
      createdAt: resourceShares.createdAt,
      createdBy: resourceShares.createdBy,
    })
    .from(resourceShares)
    .where(and(linkWhere, eq(resourceShares.audience, "link")))
    .orderBy(desc(resourceShares.createdAt))
    .limit(cap);

  return {
    exposures: exposures.slice(0, cap),
    links: rows.map(({ tokenHash, ...r }) => ({ ...r, hasToken: !!tokenHash })),
    truncated: exposures.length >= cap || rows.length >= cap,
  };
}

// ── Policy (owner only, human only) ──────────────────────────────────────────

async function assertWorkspaceOwner(
  database: Db,
  userId: string,
  workspaceId: string
): Promise<void> {
  const [ws] = await database
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw notFound("Workspace");
  if (ws.ownerId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the workspace owner can see or change what it shares.",
    });
  }
}

/** The EFFECTIVE policy (defaults filled, ceiling applied). Owner only. */
export async function getExposurePolicy(
  actor: ShareActor,
  workspaceId: string
): Promise<ResolvedExposurePolicy> {
  const database = await getDb();
  await assertWorkspaceOwner(database, actor.userId, workspaceId);
  return loadPolicy(database, workspaceId);
}

/**
 * Store the owner's policy through the ONE writer. Owner + signed-in human
 * only — agents have no door here. `null` resets to the code default.
 */
export async function setExposurePolicy(
  actor: ShareActor,
  workspaceId: string,
  policy: unknown
): Promise<ResolvedExposurePolicy> {
  assertHumanSession(actor, "Changing what a workspace shares");
  const database = await getDb();
  await assertWorkspaceOwner(database, actor.userId, workspaceId);
  let stored: Record<string, unknown> | null = null;
  if (policy !== null) {
    try {
      stored = parseExposurePolicyInput(policy) as Record<string, unknown>;
    } catch (err) {
      throw badRequest(
        `Invalid exposure policy: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const updated = await new WorkspaceRepository(
    database,
    eventRepository
  ).setExposurePolicy(workspaceId, stored, actor.userId);
  auditLog({
    subjectType: "sharing",
    action: "update",
    phase: "completed",
    subjectId: workspaceId,
    userId: actor.userId,
    workspaceId,
    data: { exposurePolicy: stored },
  });
  return resolveExposurePolicy(updated.settings);
}
