/**
 * Tags Executor
 *
 * Handles all tag operations after validation.
 * Fast execution with high concurrency.
 */

import { inngest } from "../client.js";
import { getDb, EventRepository, TagRepository } from "@synap/database";

export const tagsHandler = async ({
  event,
  step,
}: {
  event: any;
  step: any;
}) => {
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const tagRepo = new TagRepository(db, eventRepo);

  // Extract action from event name (tags.create.validated → create)
  const action = event.name.split(".")[1] as
    | "create"
    | "update"
    | "delete"
    | "attach"
    | "detach";
  const { userId } = event.user;
  const data = event.data;

  if (action === "create") {
    await step.run("create-tag", async () => {
      await tagRepo.create(
        {
          name: data.name,
          color: data.color,
          userId,
        },
        userId
      );
    });
  } else if (action === "update") {
    await step.run("update-tag", async () => {
      await tagRepo.update(
        data.id,
        {
          name: data.name,
          color: data.color,
        },
        userId
      );
    });
  } else if (action === "delete") {
    await step.run("delete-tag", async () => {
      await tagRepo.delete(data.id, userId);
    });
  } else if (action === "attach") {
    await step.run("attach-tag", async () => {
      const { entityTags } = await import("@synap/database/schema");
      await db
        .insert(entityTags)
        .values({
          userId,
          tagId: data.tagId,
          entityId: data.entityId,
        } as any)
        .onConflictDoNothing();
    });
  } else if (action === "detach") {
    await step.run("detach-tag", async () => {
      const { entityTags, eq, and } = await import("@synap/database");
      await db
        .delete(entityTags)
        .where(
          and(
            eq(entityTags.tagId, data.tagId),
            eq(entityTags.entityId, data.entityId)
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
