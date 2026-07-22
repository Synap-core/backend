/**
 * createGovernedFileEntityFromBuffer — the GOVERNED store→entity core of the
 * `POST /files` multipart door, extracted so it is callable WITHOUT HTTP.
 *
 * Given a decoded `Buffer` + mime/filename it:
 *   1. stores the blob → `documents` row + immutable v1 version snapshot
 *      (`storeDocumentFromBuffer`, NO entity yet),
 *   2. resolves the `file` kind's pod-vs-workspace scope so a pod-scope kind
 *      lands pod-wide (caller lens = null) while a workspace-scoped one stays in
 *      its lens,
 *   3. mints the `file` entity through the GOVERNED `entities.create` procedure
 *      (same permission membrane as every other write) — auto-applied when
 *      `entity.create ∈ DEFAULT_AUTO_APPROVE`, or returned as a `proposed`
 *      handle under a stricter workspace policy.
 *
 * This is a straight extraction of the Hono `/files` multipart branch body; that
 * branch now calls this, and the `synap_store_file` MCP tool reuses it as a
 * non-HTTP governed entry point. Never analyzes the bytes — deterministic store.
 */

import { db, ProfileResolutionService } from "@synap/database";
import { storeDocumentFromBuffer } from "./file-upload.js";
import { entitiesRouter as regularEntitiesRouter } from "./entities.js";
import { createHubProtocolCallerContext } from "./hub-protocol/utils.js";

export interface CreateGovernedFileEntityParams {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  /** Human-facing entity title. Defaults to `filename`. */
  title?: string;
  userId: string;
  /** Workspace context (storage path + membership/governance lens). */
  workspaceId: string;
  /**
   * The agent that authored this upload (when a machine/agent key is calling).
   * Threaded so provenance is `ai_agent` and the governance check routes the
   * write through the proposal membrane — never falsified as human.
   */
  agentUserId?: string;
  /** Caller's key scopes (translated to hub scopes by the ctx factory). */
  scopes: string[];
  /** Active focus-session handle, for proposal/entity grouping. */
  sessionId?: string | null;
  /** Service-key confinement (bound key → pinned workspace). */
  keyType?: string | null;
  keyWorkspaceId?: string | null;
}

/** Auto-approved outcome. */
export interface GovernedFileEntityCreated {
  status: "created";
  fileEntityId: string;
  documentId: string;
}

/** Proposal-gated outcome (stricter workspace policy). */
export interface GovernedFileEntityProposed {
  status: "proposed";
  proposalId?: string;
  reviewUrl?: string;
  documentId: string;
}

export type GovernedFileEntityResult =
  GovernedFileEntityCreated | GovernedFileEntityProposed;

export async function createGovernedFileEntityFromBuffer(
  params: CreateGovernedFileEntityParams
): Promise<GovernedFileEntityResult> {
  const {
    buffer,
    mimeType,
    filename,
    userId,
    workspaceId,
    agentUserId,
    scopes,
  } = params;

  // 1. Store the blob → documents row + immutable v1 version (NO entity yet).
  //    Honest provenance: an agent-key upload is stamped `ai_agent`.
  const stored = await storeDocumentFromBuffer({
    userId,
    workspaceId,
    buffer,
    mimeType,
    filename,
    title: params.title,
    actorAgentUserId: agentUserId,
  });

  // 2. Resolve pod-wide vs workspace scope for the `file` kind — a pod-scope
  //    kind governs pod-wide (caller lens = null); a workspace-scoped one stays
  //    in its lens. `entities.create` still runs its own placement resolver;
  //    this only fixes the caller/governance lens.
  const profileService = new ProfileResolutionService(db);
  const entityScope = await profileService.getEntityScope("file", workspaceId);
  const callerWorkspaceId = entityScope === "pod" ? null : workspaceId;

  // 3. Build the governed caller ctx (threads agent identity, session, and
  //    service-key confinement) and mint the `file` entity through the SAME
  //    permission membrane as every other create.
  const callerCtx = await createHubProtocolCallerContext(
    userId,
    scopes,
    callerWorkspaceId,
    undefined,
    params.sessionId ?? null,
    agentUserId ?? null,
    params.keyType,
    params.keyWorkspaceId
  );
  const entityCaller = regularEntitiesRouter.createCaller(
    callerCtx as Parameters<typeof regularEntitiesRouter.createCaller>[0]
  );

  // `agentUserId` is threaded as INPUT (entities.create reads it from input, not
  // ctx) so the permission check attributes provenance.
  const created = (await entityCaller.create({
    profileSlug: "file",
    title: params.title ?? filename,
    documentId: stored.documentId,
    properties: { mimeType, fileSize: buffer.length },
    ...(agentUserId ? { agentUserId } : {}),
    source: "agent",
  })) as {
    status?: string;
    id?: string;
    proposalId?: string;
    reviewUrl?: string;
  };

  // Proposed (stricter policy): the document row is stored now; the entity is
  // created WITH its documentId on approval. A proposed-then-REJECTED upload
  // leaves an unlinked documents row (sweepable orphan).
  if (created.status === "proposed" || created.proposalId) {
    return {
      status: "proposed",
      proposalId: created.proposalId,
      reviewUrl: created.reviewUrl,
      documentId: stored.documentId,
    };
  }

  return {
    status: "created",
    fileEntityId: created.id as string,
    documentId: stored.documentId,
  };
}
