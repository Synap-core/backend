/**
 * THE PUBLISH DOOR (Sites W5a) — put a record on the public web, and take it
 * off again. Every door calls this module: tRPC `shares.publish` /
 * `shares.unpublish`, Hub REST `POST /shares/publish` / `POST /shares/unpublish`,
 * and the `share/create` approval executor (an agent's publish).
 *
 * WHAT A PUBLICATION IS (0276). One `resource_shares` row per record with
 * `audience = 'public'`, addressed by a TOKEN exactly like a link row (the S3
 * machinery: `generateShareToken`, stored as SHA-256 + a 6-char prefix, shown
 * ONCE). `GET /public/shares/:token` (W3, `public-read.ts`) serves it only while
 * `state = 'published'`, not revoked, not expired. What it serves is fixed HERE,
 * at publish time, never read from the live record:
 *   - `published_properties` — a SNAPSHOT of exactly the keys the workspace's
 *     workspace exposure policy's PUBLIC cell for that kind allowlists in
 *     `fields` (`resolvePublicFields`, `exposure-policy.ts`; `title`
 *     = the record's title), scalar values only (string / finite number /
 *     boolean; a Date becomes its ISO string), re-filtered through the SAME
 *     `projectPublishedProperties` the read uses (identity keys and id-valued
 *     properties never enter the row);
 *   - `published_document_version_id` — the latest `document_versions`
 *     checkpoint of the record's document, if it has one.
 * Re-publishing takes a NEW snapshot and a new pin; the URL stays the same.
 *
 * WHAT CAN BE PUBLISHED. An entity, or a document (which resolves to its
 * owning entity — documents follow their entity). Views and projects are
 * refused: the public read serves entities only (W3). A pod-wide record (no
 * workspace) is refused: there is no workspace policy to publish it under.
 * The policy must say `public.read = 'direct'` for the requested kind (the
 * default denies public entirely).
 *
 * GOVERNANCE. Publishing files the SAME gate door as sharing — `share/create`,
 * with `audience: 'public'` in the payload — which is ADMIN-floored in
 * `@synap/governance-policy`: the human owner publishes DIRECTLY, an agent
 * ALWAYS gets a proposal and no `governance_rules` row can widen it. (A
 * dedicated `share/publish` door would need a new gate pair in
 * governance-policy + its dist rebuilt; publishing IS sharing with the public
 * audience, so the one floored door is the honest home.) Approval replays
 * {@link planPublish} on the proposal's subject and publishes WITHOUT a token;
 * the signed-in owner then calls publish again, which mints the missing token.
 *
 * UNPUBLISH narrows, so it is DIRECT for everyone (agents included), like
 * unshare: `state` goes back to `draft` and the URL answers the uniform 404.
 * The token is KEPT, so publishing again restores the same URL. It never
 * touches a revoked row (the lookup is `revoked_at IS NULL`, and the 0276
 * trigger freezes a revoked row anyway): revocation is permanent.
 */

import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";
import { getDb, and, eq, isNull, desc } from "@synap/database";
import {
  entities,
  documentVersions,
  resourceShares,
  workspaces,
} from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { auditLog } from "../../utils/audit-log.js";
import { generateShareToken, hashToken } from "../../utils/share-token.js";
import {
  resolveExposurePolicy,
  resolvePublicFields,
  type ShareKind,
} from "./exposure-policy.js";
import { projectPublishedProperties } from "./public-read.js";
import { agentOf, type ShareActor } from "./share-service.js";

type Db = Awaited<ReturnType<typeof getDb>>;

const notFound = (what: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
const badRequest = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

export interface PublishRequest {
  resourceType: ShareKind;
  resourceId: string;
}

/** The validated, authorized plan — what the gate carries and approval replays. */
export interface PublishPlan {
  requestedKind: "entity" | "document";
  entityId: string;
  workspaceId: string;
  documentId: string | null;
  /** The policy's public `fields` allowlist for the requested kind. */
  fields: string[];
}

/** Load the record a publish names. A document resolves to its owning entity. */
async function loadRecord(
  database: Db,
  req: PublishRequest
): Promise<{
  id: string;
  workspaceId: string | null;
  ownerId: string;
  documentId: string | null;
}> {
  if (req.resourceType !== "entity" && req.resourceType !== "document") {
    throw badRequest(
      "Only a record (an entity, or its document) can be published; views and projects are shared with guests or by link."
    );
  }
  const [row] = await database
    .select({
      id: entities.id,
      workspaceId: entities.workspaceId,
      userId: entities.userId,
      documentId: entities.documentId,
    })
    .from(entities)
    .where(
      and(
        req.resourceType === "entity"
          ? eq(entities.id, req.resourceId)
          : eq(entities.documentId, req.resourceId),
        isNull(entities.deletedAt)
      )
    )
    .limit(1);
  if (!row) {
    throw req.resourceType === "entity"
      ? notFound("Entity")
      : badRequest(
          "This document has no owning entity, so it cannot be published (a document follows its entity)."
        );
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerId: row.userId,
    documentId: row.documentId ?? null,
  };
}

/**
 * Validate + authorize a publish for `userId` (the human it is for). Reads
 * LOADED rows only. Re-run verbatim by the approval executor on the proposal's
 * subject, so a policy tightened while a proposal waited still refuses.
 */
export async function planPublish(
  database: Db,
  userId: string,
  req: PublishRequest
): Promise<PublishPlan> {
  const record = await loadRecord(database, req);
  if (!record.workspaceId) {
    throw badRequest(
      "A pod-wide record has no workspace policy to publish it under."
    );
  }
  await assertWorkspaceWrite(database, userId, {
    workspaceId: record.workspaceId,
    ownerId: record.ownerId,
  });
  const [ws] = await database
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, record.workspaceId))
    .limit(1);
  if (!ws) throw notFound("Workspace");
  const kind = req.resourceType as "entity" | "document";
  if (resolveExposurePolicy(ws.settings)[kind].public.read !== "direct") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This workspace's exposure policy does not allow publishing a ${kind}.`,
    });
  }
  return {
    requestedKind: kind,
    entityId: record.id,
    workspaceId: record.workspaceId,
    documentId: record.documentId,
    fields: resolvePublicFields(ws.settings, kind),
  };
}

/** A property value the snapshot may hold, or `undefined` to leave it out. */
function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return undefined;
}

/** The snapshot: the allowlisted keys, scalar values, re-filtered by the read's own projector. */
export async function buildPublishedSnapshot(
  database: Db,
  plan: PublishPlan
): Promise<Record<string, string | number | boolean>> {
  if (plan.fields.length === 0) return {};
  const [row] = await database
    .select({ title: entities.title, properties: entities.properties })
    .from(entities)
    .where(eq(entities.id, plan.entityId))
    .limit(1);
  if (!row) throw notFound("Entity");
  const props = (row.properties ?? {}) as Record<string, unknown>;
  const raw: Record<string, unknown> = {};
  for (const key of plan.fields) {
    const v = scalar(key === "title" ? row.title : props[key]);
    if (v !== undefined) raw[key] = v;
  }
  return projectPublishedProperties(raw);
}

async function latestCheckpointId(
  database: Db,
  documentId: string | null
): Promise<string | null> {
  if (!documentId) return null;
  const [v] = await database
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.version), desc(documentVersions.createdAt))
    .limit(1);
  return v?.id ?? null;
}

export type PublishResult =
  | { status: "proposed"; proposalId: string }
  | {
      status: "published" | "republished";
      shareId: string;
      /** Plaintext token — present ONCE, when a human's publish minted it. */
      token?: string;
      tokenPrefix: string | null;
      /** False after an agent's approved publish: the owner publishes again to mint it. */
      hasToken: boolean;
      publishedAt: Date;
      /** The keys the snapshot actually holds. */
      publishedFields: string[];
      pinned: boolean;
      rowsWritten: number;
    };

/**
 * THE owner publish door. A human is applied directly (and handed a new token
 * once); an agent gets a proposal (ADMIN floor on `share.create`).
 */
export async function publishResource(
  actor: ShareActor,
  req: PublishRequest & { reasoning?: string }
): Promise<PublishResult> {
  const agentUserId = agentOf(actor);
  // ATTRIBUTION FLOOR — same as `shareResource`: an unattributed API key is
  // neither the signed-in owner nor an attributable agent.
  if (actor.keyType && !agentUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Publishing needs a signed-in person or an agent key (run `synap init`); this API key is not attributed to either.",
    });
  }
  const database = await getDb();
  const plan = await planPublish(database, actor.userId, req);

  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: agentUserId ?? undefined,
    workspaceId: plan.workspaceId,
    subjectType: "share",
    action: "create",
    source: actor.source ?? undefined,
    reasoning: actor.reasoning ?? req.reasoning,
    data: {
      id: randomUUID(),
      op: "publish",
      audience: "public",
      resourceType: req.resourceType,
      resourceId: req.resourceId,
      resolvedResourceType: "entity",
      resolvedResourceId: plan.entityId,
      workspaceId: plan.workspaceId,
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }
  return applyPublish(database, plan, {
    userId: actor.userId,
    agentUserId,
    // Belt and braces: an agent is never granted here (ADMIN floor); if it
    // ever were, it still gets no token.
    mintToken: agentUserId === null,
  });
}

/**
 * Write an authorized plan: snapshot, pin, `state = 'published'`. Reuses the
 * record's LIVE public row (so the URL survives unpublish → publish), or
 * inserts one. A missing token is minted only when `mintToken`.
 */
export async function applyPublish(
  database: Db,
  plan: PublishPlan,
  opts: {
    userId: string;
    agentUserId?: string | null;
    sourceProposalId?: string;
    mintToken: boolean;
  }
): Promise<Extract<PublishResult, { status: "published" | "republished" }>> {
  const snapshot = await buildPublishedSnapshot(database, plan);
  const pin = await latestCheckpointId(database, plan.documentId);
  const now = new Date();

  const [live] = await database
    .select({
      id: resourceShares.id,
      state: resourceShares.state,
      tokenHash: resourceShares.tokenHash,
      tokenPrefix: resourceShares.tokenPrefix,
      pin: resourceShares.publishedDocumentVersionId,
    })
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.resourceType, "entity"),
        eq(resourceShares.resourceId, plan.entityId),
        eq(resourceShares.audience, "public"),
        isNull(resourceShares.revokedAt)
      )
    )
    .limit(1);

  const minted =
    opts.mintToken && !live?.tokenHash ? generateShareToken() : undefined;
  let shareId: string;
  let rowsWritten = 0;
  let tokenPrefix: string | null;
  let hasToken: boolean;

  if (live) {
    tokenPrefix = minted ? minted.slice(0, 6) : live.tokenPrefix;
    hasToken = !!minted || !!live.tokenHash;
    const updated = await database
      .update(resourceShares)
      .set({
        state: "published",
        publishedAt: now,
        publishedBy: opts.userId,
        // A live publication never loses its pin (0276 trigger); keep the old
        // one if the document has no checkpoint now.
        publishedDocumentVersionId: pin ?? live.pin,
        publishedProperties: snapshot,
        ...(minted
          ? { tokenHash: hashToken(minted), tokenPrefix: minted.slice(0, 6) }
          : {}),
        updatedAt: now,
      })
      .where(
        and(eq(resourceShares.id, live.id), isNull(resourceShares.revokedAt))
      )
      .returning({ id: resourceShares.id });
    if (updated.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "This publication was revoked meanwhile; publish again.",
      });
    }
    shareId = live.id;
    rowsWritten = updated.length;
  } else {
    tokenPrefix = minted ? minted.slice(0, 6) : null;
    hasToken = !!minted;
    const [row] = await database
      .insert(resourceShares)
      .values({
        resourceType: "entity",
        resourceId: plan.entityId,
        workspaceId: plan.workspaceId,
        audience: "public",
        anchorProjectId: null,
        state: "published",
        publishedAt: now,
        publishedBy: opts.userId,
        publishedDocumentVersionId: pin,
        publishedProperties: snapshot,
        createdBy: opts.userId,
        permissions: { read: true },
        tokenHash: minted ? hashToken(minted) : null,
        tokenPrefix,
      })
      .returning({ id: resourceShares.id });
    shareId = row!.id;
    rowsWritten = row ? 1 : 0;
  }

  const status =
    live?.state === "published"
      ? ("republished" as const)
      : ("published" as const);
  auditLog({
    subjectType: "sharing",
    action: live ? "update" : "create",
    phase: "completed",
    subjectId: shareId,
    userId: opts.userId,
    agentUserId: opts.agentUserId ?? undefined,
    proposalId: opts.sourceProposalId,
    workspaceId: plan.workspaceId,
    // Keys only — never values, never the token.
    data: {
      op: "publish",
      shareId,
      resourceType: "entity",
      resourceId: plan.entityId,
      publishedFields: Object.keys(snapshot),
      pinned: !!(pin ?? live?.pin),
      outcome: status,
    },
  });

  return {
    status,
    shareId,
    ...(minted ? { token: minted } : {}),
    tokenPrefix,
    hasToken,
    publishedAt: now,
    publishedFields: Object.keys(snapshot),
    pinned: !!(pin ?? live?.pin),
    rowsWritten,
  };
}

/**
 * Take a record off the public web: its live publication goes back to
 * `draft` (uniform 404 from the public read). Direct for everyone — it only
 * narrows. Keeps the token (publish again = same URL). Never un-revokes.
 */
export async function unpublishResource(
  actor: ShareActor,
  req: PublishRequest
): Promise<{ status: "unpublished" | "none"; shareId?: string }> {
  const database = await getDb();
  const record = await loadRecord(database, req);
  await assertWorkspaceWrite(database, actor.userId, {
    workspaceId: record.workspaceId,
    ownerId: record.ownerId,
  });
  const updated = await database
    .update(resourceShares)
    .set({ state: "draft", updatedAt: new Date() })
    .where(
      and(
        eq(resourceShares.resourceType, "entity"),
        eq(resourceShares.resourceId, record.id),
        eq(resourceShares.audience, "public"),
        eq(resourceShares.state, "published"),
        isNull(resourceShares.revokedAt)
      )
    )
    .returning({ id: resourceShares.id });
  const shareId = updated[0]?.id;
  if (shareId) {
    auditLog({
      subjectType: "sharing",
      action: "update",
      phase: "completed",
      subjectId: shareId,
      userId: actor.userId,
      agentUserId: agentOf(actor) ?? undefined,
      workspaceId: record.workspaceId ?? undefined,
      data: {
        op: "unpublish",
        shareId,
        resourceType: "entity",
        resourceId: record.id,
      },
    });
    return { status: "unpublished", shareId };
  }
  return { status: "none" };
}
