
import { inngest } from "../client.js";
import { getDb, EventRepository, ApiKeyRepository } from "@synap/database";
import { randomBytes } from "crypto";

export const apiKeysHandler = async ({ event, step }: { event: any, step: any }) => {
  const action = event.name.split('.')[1] as 'create' | 'update' | 'revoke' | 'rotate';
  const { userId } = event.user;
  const data = event.data;
  
  const db = await getDb();
  const eventRepo = new EventRepository(db.$client);
  const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
  
  if (action === 'create') {
    await step.run('create-api-key', async () => {
      return apiKeyRepo.create({
        keyName: data.keyName,
        keyPrefix: data.keyPrefix,
        key: data.key, // Will be hashed in repository
        hubId: data.hubId,
        scope: data.scope,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        userId: data.userId,
      }, userId);
    });
  } else if (action === 'update') {
    await step.run('update-api-key', async () => {
      return apiKeyRepo.update(data.id, {
        keyName: data.keyName,
        scope: data.scope,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        isActive: data.isActive,
      }, userId);
    });
  } else if (action === 'revoke') {
    await step.run('revoke-api-key', async () => {
      return apiKeyRepo.revoke(data.id, userId, data.reason);
    });
  } else if (action === 'rotate') {
    await step.run('rotate-api-key', async () => {
      // Generate new key
      const newKey = `${data.keyPrefix}${randomBytes(32).toString('hex')}`;
      return apiKeyRepo.rotate(data.id, newKey, userId);
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
  { event: "api_keys.*.validated" },
  apiKeysHandler
);
