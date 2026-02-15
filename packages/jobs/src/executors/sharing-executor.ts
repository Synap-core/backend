import { inngest } from "../client.js";
import {
  getDb,
  EventRepository,
  SharingRepository,
  sql,
} from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const sharingHandler = async ({
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
      `[sharingExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const sharingRepo = new SharingRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-sharing", async () => {
      await sharingRepo.create(
        {
          id: data.id as string,
          resourceType: data.resourceType as string,
          resourceId: data.resourceId as string,
          sharedByUserId: (data.sharedByUserId as string) || userId,
          sharedWithUserId: (data.sharedWithUserId as string) || undefined,
          sharedWithEmail: (data.sharedWithEmail as string) || undefined,
          permission: ((data.permission as string) || "view") as
            | "view"
            | "edit"
            | "admin",
          metadata: (data.metadata as Record<string, unknown>) || {},
          publicToken: data.publicToken as string | undefined,
          tokenHash: data.tokenHash as string | undefined,
          visibility: (data.visibility as string) || "private",
          expiresAt: data.expiresAt ? new Date(data.expiresAt as string) : null,
          access:
            (data.access as "workspace_only" | "anyone_with_link") ||
            "anyone_with_link",
          passwordHash: (data.passwordHash as string) || null,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "sharing.create.completed"
    });
  } else if (action === "update") {
    await step.run("update-sharing", async () => {
      await sharingRepo.update(
        data.id as string,
        {
          permission: data.permission
            ? (data.permission as "view" | "edit" | "admin")
            : undefined,
          metadata: (data.metadata as Record<string, unknown>) || undefined,
        },
        userId
      );
      // BaseRepository.emitCompleted() automatically emits "sharing.update.completed"
    });
  } else if (action === "delete") {
    await step.run("delete-sharing", async () => {
      await sharingRepo.delete(data.id as string, userId);
      // BaseRepository.emitCompleted() automatically emits "sharing.delete.completed"
    });
  }

  return { success: true, action };
};

export const sharingExecutor = inngest.createFunction(
  {
    id: "sharing-executor",
    name: "Execute Sharing Operations",
    concurrency: { limit: 30 },
  },
  { event: "sharing.*" },
  sharingHandler
);
