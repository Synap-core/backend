/**
 * Tags Executor
 *
 * Handles all tag operations after validation.
 * Fast execution with high concurrency.
 */

import { inngest } from "../client.js";
import { getDb, EventRepository, TagRepository, sql } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const tagsHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { phase } = eventInfo;
  // Extract custom action (tags have attach/detach which aren't in EventAction)
  const action = event.name.split(".")[1] as
    | "create"
    | "update"
    | "delete"
    | "attach"
    | "detach";

  if (phase !== "validated") {
    console.warn(`[tagsExecutor] Received non-validated event: ${event.name}`);
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const tagRepo = new TagRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-tag", async () => {
      await tagRepo.create(
        {
          name: (data.name as string) || "Untitled",
          color: (data.color as string) || "#808080",
          userId,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "tags.create.completed"
    });
  } else if (action === "update") {
    await step.run("update-tag", async () => {
      await tagRepo.update(
        data.id as string,
        {
          name: (data.name as string) || undefined,
          color: (data.color as string) || undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "tags.update.completed"
    });
  } else if (action === "delete") {
    await step.run("delete-tag", async () => {
      await tagRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "tags.delete.completed"
    });
  } else if (action === "attach") {
    await step.run("attach-tag", async () => {
      const { entityTags } = await import("@synap/database/schema");
      await db
        .insert(entityTags)
        .values({
          userId,
          tagId: data.tagId as string,
          entityId: data.entityId as string,
        })
        .onConflictDoNothing();
    });
  } else if (action === "detach") {
    await step.run("detach-tag", async () => {
      const { entityTags, eq, and } = await import("@synap/database");
      await db
        .delete(entityTags)
        .where(
          and(
            eq(entityTags.tagId, data.tagId as string),
            eq(entityTags.entityId, data.entityId as string)
          )
        );
    });
  }

  return { success: true, action };
};

export const tagsExecutor = inngest.createFunction(
  {
    id: "tags-executor",
    name: "Execute Tag Operations",
    concurrency: { limit: 100 },
  },
  { event: "tags.*.validated" },
  tagsHandler
);
