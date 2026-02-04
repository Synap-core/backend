import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  RelationRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const relationsHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { action, phase } = eventInfo;

  if (phase !== "validated") {
    console.warn(
      `[relationsExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const relationRepo = new RelationRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-relation", async () => {
      await relationRepo.create(
        {
          id: data.id as string,
          sourceEntityId: data.sourceEntityId as string,
          targetEntityId: data.targetEntityId as string,
          type: data.type as string,
          userId,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "relations.create.completed"
    });
  } else if (action === "update") {
    await step.run("update-relation", async () => {
      await relationRepo.update(
        data.id as string,
        {
          type: data.type as string,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "relations.update.completed"
    });
  } else if (action === "delete") {
    await step.run("delete-relation", async () => {
      await relationRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "relations.delete.completed"
    });
  }

  return { success: true, action };
};

export const relationsExecutor = inngest.createFunction(
  {
    id: "relations-executor",
    name: "Execute Relation Operations",
    concurrency: { limit: 50 },
  },
  { event: "relations.*.validated" },
  relationsHandler
);
