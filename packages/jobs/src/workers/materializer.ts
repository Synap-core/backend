/**
 * Materializer Worker
 *
 * Handles proposal-approved materializations where the router is not in
 * the call path. When a proposal is approved, the approval flow emits a
 * ".validated" event → the materialization hook enqueues a pg-boss job →
 * this worker does the actual DB write → emits ".completed" event →
 * triggers side-effects.
 *
 * Inline auto-approved mutations are handled directly by the router and
 * do NOT go through this worker.
 *
 * Supported subject types:
 * - entity: create, update, delete
 * - profile: create, update, delete
 * - view: create, update, delete
 */

import type PgBoss from "pg-boss";
import { execFileSync } from "child_process";
import { realpathSync, existsSync } from "fs";
import { resolve as resolvePath } from "path";
import {
  getDb,
  EntityRepository,
  DocumentRepository,
  EventRepository,
  ViewRepository,
  ProfileRepository,
  type ProfileScope,
  sql,
  db as sharedDb,
  eq,
  and,
  storedVersionValues,
  uploadDocumentVersionSnapshot,
  normalizeDocumentType,
  links,
  type LinkEndpointType,
  type LinkType,
  linkEntityToProject,
} from "@synap/database";
import {
  entities,
  profiles,
  views,
  documents,
  documentVersions,
  cellInstances,
  workspaceMembers,
  users,
  proposals,
  focusSessions,
} from "@synap/database/schema";
import {
  createUnifiedEvent,
  type EventAction,
  type EventPhase,
} from "../types/unified-events.js";
import type { SynapEvent } from "@synap-core/core";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";

const logger = createLogger({ module: "materializer" });

export interface MaterializePayload {
  /** The event ID that triggered this materialization */
  eventId: string;
  /** Event type e.g. "entity.create.validated" */
  eventType: string;
  /** Subject type */
  subjectType: string;
  /** Action */
  action: string;
  /** Subject ID (entity ID, profile ID, etc.) */
  subjectId: string;
  /** User who triggered the action */
  userId: string;
  /** Workspace ID */
  workspaceId?: string;
  /** Correlation ID for event chain tracing */
  correlationId?: string;
  /** Full event data payload */
  data: Record<string, unknown>;
}

/**
 * Handle materialization of a proposal-approved validated event.
 */
export async function handleMaterialize(
  job: PgBoss.Job<MaterializePayload>
): Promise<void> {
  const {
    eventType,
    subjectType,
    action,
    subjectId,
    userId,
    workspaceId,
    correlationId,
    data,
  } = job.data;

  logger.info(
    { eventType, subjectType, action, subjectId, correlationId },
    "Materializing proposal-approved event"
  );

  try {
    switch (subjectType) {
      case "entity":
        await materializeEntity(action, subjectId, userId, workspaceId, data);
        break;
      case "profile":
        await materializeProfile(action, subjectId, userId, workspaceId, data);
        break;
      case "view":
        await materializeView(action, subjectId, userId, workspaceId, data);
        break;
      case "command":
        await materializeCommand(
          action,
          subjectId,
          userId,
          workspaceId,
          data,
          correlationId
        );
        break;
      case "cell":
        await materializeCell(action, subjectId, userId, workspaceId, data);
        break;
      case "workspace":
        await materializeWorkspace(action, subjectId, workspaceId, data);
        break;
      case "link":
        await materializeLink(action, workspaceId, data);
        break;
      case "whiteboard":
        // Whiteboard proposals are handled inline by their own REST route;
        // the materializer path is not yet implemented. Log and skip rather
        // than hard-fail so the job does not fill the retry queue.
        logger.warn(
          { subjectType, action, subjectId },
          "Whiteboard materialization via worker is not yet supported; skipping"
        );
        return;
      default:
        logger.warn(
          { subjectType },
          "Unknown subject type for materialization"
        );
        return;
    }
  } catch (error) {
    logger.error(
      { err: error, eventType, subjectId },
      "Materialization failed"
    );
    throw error; // Let pg-boss retry the WRITE (idempotency-guarded above)
  }

  // Post-write (the DB write already committed above). Emit the `.completed`
  // event + side-effects as a BEST-EFFORT block: their failure must NOT replay
  // the write, because some writes are not safely re-runnable on a pg-boss retry
  // (notably command execution). The repositories also emit their own
  // `.completed` during the write, so a miss here is recoverable. Logged, never
  // rethrown.
  try {
    const eventRepo = new EventRepository(sql);
    const completedEvent = createUnifiedEvent({
      subjectType,
      action: action as EventAction,
      phase: "completed" as EventPhase,
      subjectId,
      userId,
      data: { ...data, workspaceId, materializedBy: "worker" },
      source: "system",
      correlationId,
    });
    await eventRepo.append({
      id: completedEvent.id,
      version: completedEvent.version,
      type: completedEvent.type,
      subjectId: completedEvent.subjectId,
      subjectType: completedEvent.subjectType,
      data: completedEvent.data as Record<string, unknown>,
      metadata: completedEvent.metadata as Record<string, unknown>,
      userId: completedEvent.userId,
      source: completedEvent.source as SynapEvent["source"],
      timestamp: completedEvent.timestamp,
      correlationId: completedEvent.correlationId,
    });

    // Resolve the session that produced this entity (when applicable) so the
    // side-effect chain carries `sessionId` → the automation matcher can select
    // playbook-scoped automations. Best-effort: a miss keeps the bare workspace
    // event (workspace-wide automations still fire).
    let resolvedSessionId: string | null = null;
    if (subjectType === "entity" && data.sourceProposalId) {
      try {
        const p = await sharedDb.query.proposals.findFirst({
          where: eq(proposals.id, data.sourceProposalId as string),
          columns: { sessionId: true },
        });
        resolvedSessionId = p?.sessionId ?? null;
      } catch {
        // Non-fatal — side-effects fire without session scope.
      }
    }

    // Emit side-effects (search indexing, embedding, webhooks)
    await emitSideEffects({
      subjectType,
      action,
      subjectId,
      userId,
      workspaceId,
      data,
      sessionId: resolvedSessionId,
    });

    logger.info(
      { eventType, subjectId, correlationId },
      "Materialization completed"
    );
  } catch (postErr) {
    logger.error(
      { err: postErr, eventType, subjectId, correlationId },
      "Post-materialize .completed/side-effects failed (write already applied; NOT retrying the write)"
    );
  }
}

/**
 * Materialize an entity operation from a proposal-approved event.
 */
async function materializeEntity(
  action: string,
  subjectId: string,
  userId: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>
): Promise<void> {
  const database = await getDb();
  const eventRepo = new EventRepository(sql);
  const entityRepo = new EntityRepository(database, eventRepo);
  const docRepo = new DocumentRepository(database, eventRepo);

  if (action === "create") {
    // Idempotency: check if entity already exists
    const existing = await sharedDb.query.entities.findFirst({
      where: eq(entities.id, subjectId),
      columns: { id: true },
    });
    if (existing) {
      logger.warn(
        { subjectId },
        "Entity already exists, skipping materialization"
      );
      return;
    }

    const entityWorkspaceId = data.global ? null : workspaceId;
    const profileSlug = data.profileSlug as string;
    const rawContent = (data.content as string | undefined) || undefined;
    const baseProperties =
      (data.properties as Record<string, unknown>) || undefined;

    // Content routing — same heuristic decision (shouldMaterializeAsDocument)
    // every other writer uses: long-form → a versioned document (storage row +
    // v1 snapshot, linked via documentId); short → inline properties.content.
    // (This worker can't import @synap/api, so it materializes inline but shares
    // the heuristic via @synap-core/types and passes `content` so the document
    // repository writes the v1 snapshot.)
    let documentId: string | undefined =
      (data.documentId as string) || undefined;
    let properties = baseProperties;

    if (rawContent && shouldMaterializeAsDocument(rawContent)) {
      const { storage } = await import("@synap/storage");
      const key = storage.buildPath(userId, "entity", subjectId, "md");
      const metadata = await storage.upload(key, rawContent, {
        contentType: "text/markdown",
      });
      const createdDocument = await docRepo.create(
        {
          title: (data.title as string) || "Untitled",
          type: "markdown",
          storageUrl: metadata.url,
          storageKey: metadata.path,
          size: metadata.size,
          mimeType: "text/markdown",
          userId,
          // Scope the document to the entity's workspace so a workspace purge
          // reclaims both.
          workspaceId: entityWorkspaceId ?? undefined,
          content: rawContent, // → writes the document_versions v1 snapshot
          // Provenance (Wave B3): proposal-materialized document.
          createdByKind: (data.agentUserId as string) ? "ai_agent" : "human",
          createdByUserId: userId,
          agentUserId: (data.agentUserId as string) || undefined,
          sourceProposalId: (data.sourceProposalId as string) || undefined,
          correlationId: (data.correlationId as string) || undefined,
        },
        userId
      );
      documentId = createdDocument.id;
    } else if (rawContent) {
      // Short content stays inline on the entity.
      properties = { ...(baseProperties ?? {}), content: rawContent };
    }

    // The entity→document link is one-directional (entity.documentId →
    // documents.id); documents has no entityId column.
    await entityRepo.create(
      {
        // Pin the row id to the event subject so (a) revert can delete it by
        // proposal.targetId and (b) the idempotency guard above (findFirst by
        // subjectId) matches on a pg-boss retry. Without this the DB mints a
        // fresh uuid and both break — orphan-on-revert + duplicate-on-retry.
        id: subjectId,
        workspaceId: entityWorkspaceId!,
        userId,
        title: (data.title as string) || undefined,
        preview:
          (data.description as string) || (data.preview as string) || undefined,
        documentId,
        properties,
        profileSlug,
        // Provenance (Wave B3): proposal-materialized write — stamp who/what
        // authored it from the proposal envelope (carried on the .validated event:
        // agentUserId/correlationId/sourceProposalId). sourceProposalId is set
        // here (materialized-from-proposal path) per the C2 decision.
        createdByKind: (data.agentUserId as string) ? "ai_agent" : "human",
        createdByUserId: userId,
        agentUserId: (data.agentUserId as string) || undefined,
        sourceProposalId: (data.sourceProposalId as string) || undefined,
        correlationId: (data.correlationId as string) || undefined,
      },
      userId
    );

    // Provenance: if this entity was produced inside a focus session, record
    // `session --produced--> entity`. The proposal carries `session_id` (set by
    // the channel when an active focus session owns the message); we resolve it
    // here — the single chokepoint every approve path flows through — so the
    // session room's Deliverable surface populates BY CONSTRUCTION, not only
    // when a BYOA agent explicitly calls POST /runs/:runId/capture.
    await linkSessionProduced(
      database,
      data.sourceProposalId as string | undefined,
      subjectId,
      entityWorkspaceId,
      userId
    );
  } else if (action === "update") {
    const entityId = (data.id as string) || subjectId;
    await entityRepo.update(
      entityId,
      {
        title: (data.title as string) || undefined,
        preview:
          (data.description as string) || (data.preview as string) || undefined,
        documentId: data.documentId as string | undefined,
        properties: (data.properties as Record<string, unknown>) || undefined,
        // Thread the materializing workspace's lens for validation/indexing.
        // Materialization runs from the workspace that emitted the event.
        workspaceId: workspaceId ?? null,
      },
      userId
    );
  } else if (action === "delete") {
    const entityId = (data.id as string) || subjectId;
    await entityRepo.delete(entityId, userId);
  }
}

/**
 * Materialize a profile operation from a proposal-approved event.
 */
async function materializeProfile(
  action: string,
  subjectId: string,
  userId: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>
): Promise<void> {
  const database = await getDb();
  const profileRepo = new ProfileRepository(database);

  if (action === "create") {
    // Idempotency: check if profile already exists
    const existing = await sharedDb.query.profiles.findFirst({
      where: eq(profiles.id, subjectId),
      columns: { id: true },
    });
    if (existing) {
      logger.warn(
        { subjectId },
        "Profile already exists, skipping materialization"
      );
      return;
    }

    const scope = (data.scope as string) || "workspace";
    let profileUserId: string | undefined;
    let profileWorkspaceId: string | undefined;

    if (scope === "system") {
      profileUserId = undefined;
      profileWorkspaceId = undefined;
    } else if (scope === "workspace") {
      profileWorkspaceId = workspaceId;
    } else if (scope === "user") {
      profileUserId = userId;
    }

    await profileRepo.create({
      slug: data.slug as string,
      displayName: (data.displayName as string) || (data.slug as string),
      parentProfileId: (data.parentProfileId as string) || undefined,
      uiHints: (data.uiHints as Record<string, unknown>) || undefined,
      scope: scope as ProfileScope,
      userId: profileUserId,
      workspaceId: profileWorkspaceId,
    });
  } else if (action === "update") {
    await profileRepo.update(subjectId, {
      displayName: (data.displayName as string) || undefined,
      parentProfileId: data.parentProfileId as string | undefined,
      uiHints: (data.uiHints as Record<string, unknown>) || undefined,
    });
  } else if (action === "delete") {
    await profileRepo.delete(subjectId);
  }
}

/**
 * Materialize a view operation from a proposal-approved event.
 */
async function materializeView(
  action: string,
  subjectId: string,
  userId: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>
): Promise<void> {
  const database = await getDb();
  const eventRepo = new EventRepository(sql);
  const viewRepo = new ViewRepository(database, eventRepo);

  if (action === "create") {
    // Idempotency: check if view already exists
    const existing = await sharedDb.query.views.findFirst({
      where: eq(views.id, subjectId),
      columns: { id: true },
    });
    if (existing) {
      logger.warn(
        { subjectId },
        "View already exists, skipping materialization"
      );
      return;
    }

    const viewType = (data.type as string) || "list";

    // Create document + storage if content is provided
    let documentId = data.documentId as string | undefined;
    if (!documentId && data.initialContent) {
      const { storage } = await import("@synap/storage");
      const { createHash } = await import("crypto");
      // IDEMPOTENCY: derive DETERMINISTIC doc + version ids from the view id so a
      // retry (e.g. crash after the doc insert but before the view insert) reuses
      // the same ids — onConflictDoNothing then no-ops instead of orphaning a
      // second document + storage object. (documents.id is a uuid column; Postgres
      // accepts any 32-hex value, so a hash-derived id is valid even if not RFC v4.)
      const deterministicId = (seed: string) => {
        const h = createHash("sha256").update(seed).digest("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      };

      const docId = deterministicId(`view-doc:${subjectId}`);
      const contentStr = JSON.stringify(data.initialContent);
      const contentBuffer = Buffer.from(contentStr, "utf-8");
      const ext = viewType === "whiteboard" ? "json" : "json";
      const storageKey = storage.buildPath(userId, viewType, docId, ext);
      // Re-uploading the same deterministic key on retry overwrites in place.
      const uploadResult = await storage.upload(storageKey, contentBuffer, {
        contentType: "application/json",
      });

      const versionId = deterministicId(`view-docver:${subjectId}`);
      const snapshot = await uploadDocumentVersionSnapshot({
        userId,
        documentId: docId,
        versionId,
        documentType: viewType,
        mimeType: "application/json",
        content: contentStr,
      });

      await sharedDb
        .insert(documents)
        .values({
          id: docId,
          userId,
          workspaceId: workspaceId ?? "",
          type: viewType,
          title: (data.name as string) || "Untitled",
          storageUrl: uploadResult.url,
          storageKey: uploadResult.path,
          size: uploadResult.size,
          mimeType: "application/json",
          currentVersion: 1,
          lastSavedVersion: 1,
        })
        .onConflictDoNothing();

      await sharedDb
        .insert(documentVersions)
        .values({
          id: versionId,
          documentId: docId,
          version: 1,
          ...storedVersionValues(snapshot),
          author: "user",
          authorId: userId,
          message: "Initial version",
        })
        .onConflictDoNothing();

      documentId = docId;
    }

    await viewRepo.create(
      {
        id: subjectId,
        type: viewType,
        name: (data.name as string) || "Untitled",
        description: (data.description as string) || undefined,
        documentId,
        workspaceId: workspaceId || "",
        userId,
        scopeProfileIds: (data.scopeProfileIds as string[]) || undefined,
        scopeMode: (data.scopeMode as "explicit" | "observed") || "explicit",
        query: (data.query as Record<string, unknown>) || {},
        config: (data.config as Record<string, unknown>) || {},
        embeddedViewIds: (data.embeddedViewIds as string[]) || [],
        metadata: {
          entityCount: 0,
          createdBy: userId,
          ...((data.metadata as Record<string, unknown>) || {}),
        },
      },
      userId
    );
  } else if (action === "update") {
    await viewRepo.update(
      subjectId,
      {
        name: (data.name as string) || undefined,
        description: (data.description as string) || undefined,
        config: (data.config as Record<string, unknown>) || undefined,
        query: (data.query as Record<string, unknown>) || undefined,
      },
      userId
    );
  } else if (action === "delete") {
    await viewRepo.delete(subjectId, userId);
  }
}

/**
 * Materialize a cell operation from a proposal-approved event.
 *
 * The proposal data payload carries everything written by the REST route into
 * checkPermissionOrPropose({ data: { cellType, name, html?, userId, workspaceId, ... } }).
 * For html-embed cells the `html` field is present and a backing document is
 * created in MinIO + document_versions (mirroring the inline path in
 * rest/cell-instances.ts POST /cell-instances/html). For generic cells only a
 * cell_instances row is inserted.
 */
async function materializeCell(
  action: string,
  subjectId: string,
  userId: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>
): Promise<void> {
  if (action !== "create") {
    logger.warn(
      { action },
      "Cell materialization only supports 'create' action"
    );
    return;
  }

  // Idempotency: skip if the cell already exists (pg-boss may retry the job)
  const existing = await sharedDb.query.cellInstances.findFirst({
    where: eq(cellInstances.id, subjectId),
    columns: { id: true },
  });
  if (existing) {
    logger.warn(
      { subjectId },
      "Cell instance already exists, skipping materialization"
    );
    return;
  }

  const cellType = (data.cellType as string) || "html-embed";
  const name = data.name as string | undefined;
  const effectiveUserId = (data.userId as string) || userId;
  const effectiveWorkspaceId =
    (data.workspaceId as string) || workspaceId || "";
  const agentUserId = data.agentUserId as string | undefined;
  const html = data.html as string | undefined;

  // For html-embed cells: create a backing document in MinIO + document_versions,
  // then create the cell_instances row referencing it. Mirrors the inline path in
  // rest/cell-instances.ts POST /cell-instances/html.
  let sourceDocumentId: string | undefined =
    (data.sourceDocumentId as string) || undefined;

  if (cellType === "html-embed" && html && !sourceDocumentId) {
    const { randomUUID } = await import("crypto");
    const { storage } = await import("@synap/storage");

    const title = name ?? "HTML Cell";
    const documentId = randomUUID();
    const docType = normalizeDocumentType("text", "text");
    const storageKey = storage.buildPath(
      effectiveUserId,
      "document",
      documentId,
      "html"
    );

    const metadata = await storage.upload(storageKey, html, {
      contentType: "text/html",
    });

    const versionId = randomUUID();
    const snapshot = await uploadDocumentVersionSnapshot({
      userId: effectiveUserId,
      documentId,
      versionId,
      documentType: "html",
      mimeType: "text/html",
      content: html,
    });

    await sharedDb
      .insert(documents)
      .values({
        id: documentId,
        userId: effectiveUserId,
        workspaceId: effectiveWorkspaceId,
        title,
        type: docType as "text" | "markdown" | "code" | "pdf" | "docx",
        storageUrl: metadata.url,
        storageKey: metadata.path,
        size: metadata.size,
        mimeType: "text/html",
        currentVersion: 1,
        lastSavedVersion: 1,
      })
      .onConflictDoNothing();

    await sharedDb
      .insert(documentVersions)
      .values({
        id: versionId,
        documentId,
        version: 1,
        ...storedVersionValues(snapshot),
        author: "user",
        authorId: effectiveUserId,
        message: "Initial version",
      })
      .onConflictDoNothing();

    sourceDocumentId = documentId;
  }

  await sharedDb
    .insert(cellInstances)
    .values({
      id: subjectId,
      workspaceId: effectiveWorkspaceId,
      userId: effectiveUserId,
      cellType,
      config: (data.config as Record<string, unknown>) ?? {},
      name,
      isTemplate: (data.isTemplate as boolean) ?? false,
      sourceDocumentId,
      createdByKind: agentUserId ? "agent" : "user",
      trustLevel: agentUserId ? "generated" : "trusted",
    })
    .onConflictDoNothing();

  logger.info(
    { subjectId, cellType, sourceDocumentId },
    "Cell instance materialized"
  );
}

/**
 * Materialize a workspace-membership join from a proposal-approved event
 * (PRODUCT DECISION "agent asks to join").
 *
 * The proposal was filed by `checkPermissionOrPropose` when an agent actor was
 * not a member of the workspace; on approval the proposals router emits
 * `workspace.join.validated`, which the materialization hook routes here. This
 * inserts the `workspace_members` row idempotently (onConflictDoNothing), so a
 * pg-boss retry — or an agent that already gained membership another way — is a
 * no-op rather than a duplicate/error.
 *
 * subjectId is the workspaceId (the proposal's targetId). The agent to add comes
 * from `data.agentUserId`; the role from `data.role` (default editor).
 */
/**
 * Materialize an approved `link.create` proposal — insert the edge into the
 * `links` config/runtime graph. Closes the loop for the bridge write path
 * (`POST /api/hub/links`): in agent workspaces `link.create` routes to a
 * proposal, and without this case the approval would flip APPROVED while the
 * edge was silently never written. Idempotent (the unique-edge index +
 * onConflictDoNothing) so a retried job can't error or duplicate.
 */
/**
 * Stamp the two scope facts a materialized entity inherits from its proposal:
 *
 *  1. PROVENANCE — `session --produced--> entity` (links table) when the proposal
 *     belongs to a focus session. Powers the session room's Deliverable surface.
 *  2. MEMBERSHIP — `entity --belongs_to_project--> project` (relations table) so
 *     the project lens (`projectLensWhere`) is not hollow. The project is resolved
 *     with the same priority the lens-context is written: the proposal's explicit
 *     `project_id` (active lens / surface override) first, then the producing
 *     session's `projectId` (provenance fallback).
 *
 * This is the WRITE seam that mirrors how `workspace_id` is stamped on the entity
 * row — membership is a graph edge, so it is stamped here instead of as a column.
 * No-op when neither a session nor a project is present (the common case).
 * Idempotent (links unique-edge index + relations_belongs_to_project_unique +
 * onConflictDoNothing), so a pg-boss retry can neither error nor duplicate.
 */
async function linkSessionProduced(
  db: Awaited<ReturnType<typeof getDb>>,
  sourceProposalId: string | undefined,
  entityId: string,
  workspaceId: string | null | undefined,
  userId: string
): Promise<void> {
  if (!sourceProposalId) return;
  const proposal = await sharedDb.query.proposals.findFirst({
    where: eq(proposals.id, sourceProposalId),
    columns: { sessionId: true, projectId: true },
  });
  if (!proposal) return;

  // 1. Provenance link (session → produced → entity).
  if (proposal.sessionId) {
    await db
      .insert(links)
      .values({
        workspaceId: workspaceId ?? null,
        fromType: "session" as LinkEndpointType,
        fromId: proposal.sessionId,
        toType: "entity" as LinkEndpointType,
        toId: entityId,
        linkType: "produced" as LinkType,
        metadata: {},
      })
      .onConflictDoNothing();
    logger.info(
      { sessionId: proposal.sessionId, entityId },
      "Linked session --produced--> entity"
    );
  }

  // 2. Project membership (entity → belongs_to_project → project). Priority:
  //    explicit proposal.projectId (lens-context) > producing session's project.
  let projectId = proposal.projectId ?? null;
  if (!projectId && proposal.sessionId) {
    const session = await sharedDb.query.focusSessions.findFirst({
      where: eq(focusSessions.id, proposal.sessionId),
      columns: { projectId: true },
    });
    projectId = session?.projectId ?? null;
  }
  if (projectId) {
    await linkEntityToProject(db, {
      entityId,
      projectId,
      userId,
      workspaceId: workspaceId ?? null,
    });
    logger.info(
      { projectId, entityId },
      "Linked entity --belongs_to_project--> project"
    );
  }
}

async function materializeLink(
  action: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>
): Promise<void> {
  if (action !== "create") {
    logger.warn({ action }, "Link materialization only supports 'create'");
    return;
  }
  const fromType = data.fromType as LinkEndpointType | undefined;
  const fromId = data.fromId as string | undefined;
  const toType = data.toType as LinkEndpointType | undefined;
  const toId = data.toId as string | undefined;
  const linkType = data.linkType as LinkType | undefined;
  if (!fromType || !fromId || !toType || !toId || !linkType) {
    logger.error(
      { fromType, fromId, toType, toId, linkType },
      "Link materialization missing required fields; skipping"
    );
    return;
  }
  const db = await getDb();
  await db
    .insert(links)
    .values({
      workspaceId: workspaceId ?? null,
      fromType,
      fromId,
      toType,
      toId,
      linkType,
      metadata: (data.metadata as Record<string, unknown>) ?? {},
    })
    .onConflictDoNothing();
  logger.info(
    { fromType, fromId, toType, toId, linkType },
    "Link materialized"
  );
}

async function materializeWorkspace(
  action: string,
  subjectId: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>
): Promise<void> {
  if (action !== "join") {
    logger.warn(
      { action },
      "Workspace materialization only supports 'join' action"
    );
    return;
  }

  const targetWorkspaceId =
    (data.workspaceId as string) || workspaceId || subjectId;
  const agentUserId = data.agentUserId as string | undefined;
  if (!targetWorkspaceId || !agentUserId) {
    logger.error(
      { subjectId, targetWorkspaceId, agentUserId },
      "Workspace join missing workspaceId or agentUserId; skipping"
    );
    return;
  }

  const role = (data.role as string) || "editor";

  // Idempotency: skip if the agent is already a member.
  const existing = await sharedDb.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, targetWorkspaceId),
      eq(workspaceMembers.userId, agentUserId)
    ),
    columns: { id: true },
  });
  if (existing) {
    logger.warn(
      { targetWorkspaceId, agentUserId },
      "Agent already a workspace member, skipping join materialization"
    );
    return;
  }

  // Defence-in-depth: only ever materialize a join for an actual agent user row.
  const agentUser = await sharedDb.query.users.findFirst({
    where: eq(users.id, agentUserId),
    columns: { userType: true },
  });
  if (agentUser?.userType !== "agent") {
    logger.warn(
      { agentUserId },
      "Workspace join target is not an agent user; skipping"
    );
    return;
  }

  await sharedDb
    .insert(workspaceMembers)
    .values({
      workspaceId: targetWorkspaceId,
      userId: agentUserId,
      role,
    })
    .onConflictDoNothing();

  logger.info(
    { targetWorkspaceId, agentUserId, role },
    "Agent workspace membership materialized"
  );
}

// ── CLI Command Execution (proposal-approved) ────────────────────────────────

/** Allowlisted environment variables — mirrors hub-protocol-rest.ts */
const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_ENV",
  "NODE_PATH",
  "NPM_CONFIG_PREFIX",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function validateWorkingDir(dir: string | undefined): string {
  if (!dir) return process.cwd();
  const resolved = resolvePath(dir);
  if (!existsSync(resolved)) return process.cwd();
  try {
    const real = realpathSync(resolved);
    const BLOCKED = [
      "/etc",
      "/var",
      "/usr",
      "/bin",
      "/sbin",
      "/boot",
      "/sys",
      "/proc",
      "/dev",
      "/root",
    ];
    for (const b of BLOCKED) {
      if (real === b || real.startsWith(b + "/")) return process.cwd();
    }
    return real;
  } catch {
    return process.cwd();
  }
}

/**
 * Execute a CLI command that was previously proposed and now approved.
 * Re-applies the same security controls as the original REST endpoint.
 */
async function materializeCommand(
  action: string,
  subjectId: string,
  userId: string,
  workspaceId: string | undefined,
  data: Record<string, unknown>,
  correlationId?: string
): Promise<void> {
  if (action !== "execute") {
    logger.warn({ action }, "Unknown command action for materialization");
    return;
  }

  const command = data.command as string;
  if (!command) {
    logger.error({ subjectId }, "No command in materialization payload");
    return;
  }

  const workingDir = validateWorkingDir(data.workingDir as string | undefined);
  const timeoutMs = Math.min(Number(data.timeoutMs) || 30_000, 300_000);

  logger.info(
    { command, workingDir, userId, correlationId },
    "Executing approved command"
  );

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const result = execFileSync("/bin/sh", ["-c", command], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      cwd: workingDir,
      encoding: "utf-8",
      env: buildSafeEnv(),
    });
    stdout = String(result ?? "");
  } catch (execErr: unknown) {
    const err = execErr as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message?: string;
    };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message ?? "";
    exitCode = err.status ?? 1;
  }

  // Truncate
  const MAX = 50_000;
  if (stdout.length > MAX) stdout = stdout.slice(0, MAX) + "\n... (truncated)";
  if (stderr.length > MAX) stderr = stderr.slice(0, MAX) + "\n... (truncated)";

  logger.info(
    { command, exitCode, stdoutLen: stdout.length, correlationId },
    "Approved command executed"
  );

  // Emit side effects so automations can fire. BEST-EFFORT: the command has
  // ALREADY executed, so a side-effect failure must NOT throw — that would make
  // pg-boss retry the whole job and DOUBLE-EXECUTE the shell command. (The exec
  // error itself is caught above; with this also non-throwing, materializeCommand
  // does not trigger a retry → effectively once-only. A persisted run-marker for
  // strict once-only is a future hardening.)
  if (workspaceId) {
    try {
      await emitSideEffects({
        subjectType: "command",
        action: "execute",
        subjectId,
        userId,
        workspaceId,
        data: {
          command,
          workingDir,
          exitCode,
          reason: data.reason as string | undefined,
          stdoutPreview: stdout.slice(0, 500),
          approvedExecution: true,
        },
      });
    } catch (sideErr) {
      logger.error(
        { err: sideErr, subjectId, correlationId },
        "Command side-effects failed (command already executed; not retrying)"
      );
    }
  }
}
