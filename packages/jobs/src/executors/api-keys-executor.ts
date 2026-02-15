import { inngest } from "../client.js";
import { getDb, EventRepository, ApiKeyRepository, sql } from "@synap/database";
import { randomBytes } from "crypto";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const apiKeysHandler = async ({
  event,
  step,
}: {
  event: { name: string; data: UnifiedEventData; user: { id: string } };
  step: any;
}) => {
  const eventInfo = extractEventInfo(event.name);
  const { phase } = eventInfo;
  // Extract custom action (api-keys has revoke/rotate which aren't in EventAction)
  const action = event.name.split(".")[1] as
    | "create"
    | "update"
    | "revoke"
    | "rotate";

  if (phase !== "validated") {
    console.warn(
      `[apiKeysExecutor] Received non-validated event: ${event.name}`
    );
    return { success: false, reason: "Not a validated event" };
  }

  const db = await getDb();
  const eventRepo = new EventRepository(sql);
  const apiKeyRepo = new ApiKeyRepository(db, eventRepo);

  const userId = event.user.id;
  const data = event.data;

  if (action === "create") {
    await step.run("create-api-key", async () => {
      // BaseRepository.emitCompleted() automatically emits "apiKeys.create.completed"
      return apiKeyRepo.create(
        {
          keyName: (data.keyName as string) || "Untitled",
          keyPrefix: (data.keyPrefix as string) || "sk_",
          key: data.key as string, // Will be hashed in repository
          hubId: (data.hubId as string) || undefined,
          scope: (data.scope as string[]) || [],
          expiresAt: data.expiresAt
            ? new Date(data.expiresAt as string)
            : undefined,
          userId: (data.userId as string) || userId,
        },
        userId
      );
    });
  } else if (action === "update") {
    await step.run("update-api-key", async () => {
      // BaseRepository.emitCompleted() automatically emits "apiKeys.update.completed"
      return apiKeyRepo.update(
        data.id as string,
        {
          keyName: (data.keyName as string) || undefined,
          scope: (data.scope as string[]) || undefined,
          expiresAt: data.expiresAt
            ? new Date(data.expiresAt as string)
            : undefined,
          isActive:
            (data.isActive as boolean) !== undefined
              ? (data.isActive as boolean)
              : undefined,
        },
        userId
      );
    });
  } else if (action === "revoke") {
    await step.run("revoke-api-key", async () => {
      // BaseRepository.emitCompleted() automatically emits "apiKeys.revoke.completed"
      return apiKeyRepo.revoke(
        data.id as string,
        userId,
        (data.reason as string) || undefined
      );
    });
  } else if (action === "rotate") {
    await step.run("rotate-api-key", async () => {
      // Generate new key
      const newKey = `${(data.keyPrefix as string) || "sk_"}${randomBytes(32).toString("hex")}`;
      // BaseRepository.emitCompleted() automatically emits "apiKeys.rotate.completed"
      return apiKeyRepo.rotate(data.id as string, newKey, userId);
    });
  }

  return { success: true, action };
};

export const apiKeysExecutor = inngest.createFunction(
  {
    id: "api-keys-executor",
    name: "Execute API Key Operations",
    concurrency: { limit: 20 },
  },
  { event: "apiKey.*" },
  apiKeysHandler
);
