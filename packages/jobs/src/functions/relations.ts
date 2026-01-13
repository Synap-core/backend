/**
 * Relations Worker - Relationship Management
 *
 * Handles relationship creation and deletion through event sourcing:
 * - relations.create.requested
 * - relations.delete.requested
 *
 * Ensures both entities belong to the user before creating relationships.
 */

import { inngest } from "../client.js";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "relations-worker" });

// ============================================================================
// TYPES
// ============================================================================

interface RelationsCreateRequestedData {
  id?: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

interface RelationsDeleteRequestedData {
  relationId: string;
  requestId?: string;
}

// ============================================================================
// WORKER
// ============================================================================

export const relationsWorker = inngest.createFunction(
  {
    id: "relations-handler",
    name: "Relations Handler",
    retries: 3,
  },
  [
    { event: "relations.create.validated" },
    { event: "relations.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const action = eventName.split(".")[1] as "create" | "delete";
    const userId = event.user?.id as string;

    if (!userId) {
      throw new Error("userId is required for relations operations");
    }

    logger.info({ eventName, action, userId }, "Processing relations event");

    // ========================================================================
    // CREATE
    // ========================================================================
    if (action === "create") {
      const data = event.data as RelationsCreateRequestedData;
      const relationId = data.id || randomUUID();

      // Step 1: Verify both entities belong to user
      await step.run("verify-entity-ownership", async () => {
        const { getDb, entities, eq, or, and } =
          await import("@synap/database");
        const db = await getDb();

        const userEntities = await db.query.entities.findMany({
          where: and(
            or(
              eq(entities.id, data.sourceEntityId),
              eq(entities.id, data.targetEntityId),
            ),
            eq(entities.userId, userId),
          ),
        });

        if (userEntities.length !== 2) {
          throw new Error(
            "One or both entities not found or do not belong to user",
          );
        }

        logger.debug(
          {
            sourceEntityId: data.sourceEntityId,
            targetEntityId: data.targetEntityId,
            userId,
          },
          "Entity ownership verified",
        );
      });

      // Step 2: Create relationship in database
      await step.run("insert-relation", async () => {
        const { getDb, relations } = await import("@synap/database");
        const db = await getDb();

        await db.insert(relations).values({
          id: relationId,
          userId,
          sourceEntityId: data.sourceEntityId,
          targetEntityId: data.targetEntityId,
          type: data.type,
          createdAt: new Date(),
        } as any);

        logger.info(
          {
            relationId,
            sourceEntityId: data.sourceEntityId,
            targetEntityId: data.targetEntityId,
            type: data.type,
          },
          "✅ Relation created",
        );
      });

      // Step 3: Emit validation event
      await step.run("emit-validation", async () => {
        await inngest.send({
          name: "relations.create.validated",
          data: {
            relationId,
            sourceEntityId: data.sourceEntityId,
            targetEntityId: data.targetEntityId,
            type: data.type,
          },
          user: { id: userId },
        });

        logger.info({ relationId }, "Published relations.create.validated");
      });

      // Step 4: Broadcast to SSE clients
      await step.run("broadcast-notification", async () => {
        const { broadcastNotification } =
          await import("../utils/realtime-broadcast.js");
        await broadcastNotification({
          userId,
          requestId: data.requestId,
          message: {
            type: "relations.create.validated",
            data: {
              relationId,
              sourceEntityId: data.sourceEntityId,
              targetEntityId: data.targetEntityId,
              type: data.type,
            },
            requestId: data.requestId,
            status: "success",
            timestamp: new Date().toISOString(),
          },
        });
      });

      return {
        success: true,
        action: "create",
        relationId,
        sourceEntityId: data.sourceEntityId,
        targetEntityId: data.targetEntityId,
        type: data.type,
      };
    }

    // ========================================================================
    // DELETE
    // ========================================================================
    if (action === "delete") {
      const data = event.data as RelationsDeleteRequestedData;

      // Step 1: Verify relation belongs to user
      await step.run("verify-relation-ownership", async () => {
        const { getDb, relations, eq, and } = await import("@synap/database");
        const db = await getDb();

        const relation = await db.query.relations.findFirst({
          where: and(
            eq(relations.id, data.relationId),
            eq(relations.userId, userId),
          ),
        });

        if (!relation) {
          throw new Error("Relation not found or does not belong to user");
        }

        logger.debug(
          { relationId: data.relationId, userId },
          "Relation ownership verified",
        );
      });

      // Step 2: Delete relationship
      await step.run("delete-relation", async () => {
        const { getDb, relations, eq, and } = await import("@synap/database");
        const db = await getDb();

        await db
          .delete(relations)
          .where(
            and(
              eq(relations.id, data.relationId),
              eq(relations.userId, userId),
            ),
          );

        logger.info({ relationId: data.relationId }, "✅ Relation deleted");
      });

      // Step 3: Emit validation event
      await step.run("emit-delete-validation", async () => {
        await inngest.send({
          name: "relations.delete.validated",
          data: { relationId: data.relationId },
          user: { id: userId },
        });

        logger.info(
          { relationId: data.relationId },
          "Published relations.delete.validated",
        );
      });

      // Step 4: Broadcast to SSE clients
      await step.run("broadcast-delete-notification", async () => {
        const { broadcastNotification } =
          await import("../utils/realtime-broadcast.js");
        await broadcastNotification({
          userId,
          requestId: data.requestId,
          message: {
            type: "relations.delete.validated",
            data: { relationId: data.relationId },
            requestId: data.requestId,
            status: "success",
            timestamp: new Date().toISOString(),
          },
        });
      });

      return {
        success: true,
        action: "delete",
        relationId: data.relationId,
      };
    }

    throw new Error(`Unknown action: ${action}`);
  },
);
