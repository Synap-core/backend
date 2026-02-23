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
import {
  getDb,
  EntityRepository,
  DocumentRepository,
  EventRepository,
  ViewRepository,
  ProfileRepository,
  ProfileScope,
  sql,
  db as sharedDb,
  eq,
} from "@synap/database";
import {
  entities,
  profiles,
  views,
  documents,
  documentVersions,
} from "@synap/database/schema";
import { createUnifiedEvent } from "../types/unified-events.js";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "../emit-side-effects.js";

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
      default:
        logger.warn(
          { subjectType },
          "Unknown subject type for materialization"
        );
        return;
    }

    // Emit .completed event
    const eventRepo = new EventRepository(sql);
    const completedEvent = createUnifiedEvent({
      subjectType: subjectType as any,
      action: action as any,
      phase: "completed" as any,
      subjectId,
      userId,
      data: { ...data, workspaceId, materializedBy: "worker" },
      source: "materializer" as any,
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
      source: completedEvent.source as any,
      timestamp: completedEvent.timestamp,
      correlationId: completedEvent.correlationId,
    });

    // Emit side-effects (search indexing, embedding, webhooks)
    await emitSideEffects({
      subjectType,
      action,
      subjectId,
      userId,
      workspaceId,
      data,
    });

    logger.info(
      { eventType, subjectId, correlationId },
      "Materialization completed"
    );
  } catch (error) {
    logger.error(
      { err: error, eventType, subjectId },
      "Materialization failed"
    );
    throw error; // Let pg-boss retry
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

    if (data.content) {
      const { storage } = await import("@synap/storage");
      const content = data.content as string;
      const key = storage.buildPath(userId, "entity", subjectId, "md");
      const metadata = await storage.upload(key, content, {
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
          workspaceId: workspaceId || "",
        },
        userId
      );

      const createdEntity = await entityRepo.create(
        {
          workspaceId: entityWorkspaceId!,
          userId,
          title: (data.title as string) || undefined,
          preview: (data.description as string) || undefined,
          documentId: createdDocument.id,
          properties: (data.properties as Record<string, unknown>) || undefined,
          profileSlug,
        },
        userId
      );

      await docRepo.update(
        createdDocument.id,
        { entityId: createdEntity.id },
        userId
      );
    } else {
      await entityRepo.create(
        {
          workspaceId: entityWorkspaceId!,
          userId,
          title: (data.title as string) || undefined,
          preview:
            (data.description as string) ||
            (data.preview as string) ||
            undefined,
          documentId: (data.documentId as string) || undefined,
          properties: (data.properties as Record<string, unknown>) || undefined,
          profileSlug,
        },
        userId
      );
    }
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
      const { randomUUID } = await import("crypto");

      const docId = randomUUID();
      const contentStr = JSON.stringify(data.initialContent);
      const contentBuffer = Buffer.from(contentStr, "utf-8");
      const ext = viewType === "whiteboard" ? "json" : "json";
      const storageKey = storage.buildPath(userId, viewType, docId, ext);
      const uploadResult = await storage.upload(storageKey, contentBuffer, {
        contentType: "application/json",
      });

      await sharedDb.insert(documents).values({
        id: docId,
        userId,
        type: viewType,
        title: (data.name as string) || "Untitled",
        storageUrl: uploadResult.url,
        storageKey: uploadResult.path,
        size: uploadResult.size,
        mimeType: "application/json",
        currentVersion: 1,
      } as any);

      await sharedDb.insert(documentVersions).values({
        documentId: docId,
        version: 1,
        content: contentStr,
        author: "user",
        authorId: userId,
        message: "Initial version",
      });

      documentId = docId;
    }

    await viewRepo.create(
      {
        id: subjectId,
        type: viewType as any,
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
