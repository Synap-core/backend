import { inngest } from "../client.js";
import { getDb, EventRepository, ViewRepository } from "@synap/database";

export const viewsHandler = async ({ event }: { event: any }) => {
  const db = await getDb();
  const eventRepo = new EventRepository(db as any);
  const viewRepo = new ViewRepository(db, eventRepo);

  const action = event.name.split(".")[1] as "create" | "update" | "delete";
  const { userId } = event.user;
  const data = event.data;

  switch (action) {
    case "create":
      await viewRepo.create(
        {
          id: data.id,
          type: data.type,
          name: data.name,
          documentId: data.documentId,
          workspaceId: data.workspaceId,
          config: data.config,
          userId,
        },
        userId
      );
      break;

    case "update":
      await viewRepo.update(
        data.id,
        {
          name: data.name,
          config: data.config,
        },
        userId
      );
      break;

    case "delete":
      await viewRepo.delete(data.id, userId);
      break;
  }

  return { success: true, action };
};

export const viewsExecutor = inngest.createFunction(
  {
    id: "views-executor",
    name: "Execute View Operations",
    concurrency: { limit: 100 }, // High concurrency for fast operations
  },
  { event: "views.*.validated" },
  viewsHandler
);
