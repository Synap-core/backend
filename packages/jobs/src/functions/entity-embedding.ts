import { inngest } from '../client.js';
import { r2 } from '@synap/storage';
import { vectorService } from '@synap/domain';
import { generateEmbedding } from '@synap/ai';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'entity-embedding-indexer' });

interface EntityCreatedEvent {
  entityId: string;
  userId: string;
  type: string;
  title?: string;
  preview?: string;
  fileUrl?: string;
  filePath?: string;
  content?: string;
}

const downloadContent = async (payload: EntityCreatedEvent): Promise<string | null> => {
  if (payload.content) {
    return payload.content;
  }

  if (!payload.filePath) {
    logger.warn({ entityId: payload.entityId }, 'Event payload missing content and file path');
    return null;
  }

  try {
    return await r2.download(payload.filePath);
  } catch (error) {
    logger.error({ err: error, entityId: payload.entityId }, 'Failed to download entity content from storage');
    return null;
  }
};

type StepRunner = {
  run<T>(name: string, handler: () => Promise<T> | T): Promise<unknown>;
};

export const processEntityCreatedEvent = async (
  payload: EntityCreatedEvent,
  step: StepRunner
): Promise<{ status: string; entityId?: string; reason?: string }> => {
  if (payload.type !== 'note') {
    logger.debug({ entityId: payload.entityId, type: payload.type }, 'Skipping non-note entity');
    return { status: 'ignored', reason: 'non-note-entity' };
  }

  const contentResult = await step.run('fetch-content', async () => downloadContent(payload));
  const content = contentResult as string | null;

  if (!content || content.trim().length === 0) {
    logger.warn({ entityId: payload.entityId }, 'Note content unavailable for embedding');
    return { status: 'skipped', reason: 'empty-content' };
  }

  const embeddingResult = await step.run('generate-embedding', async () => {
    const vector = await generateEmbedding(content);
    if (!Array.isArray(vector) || vector.length === 0) {
      logger.error({ entityId: payload.entityId }, 'Embedding provider returned empty vector');
      throw new Error('Embedding generation failed: empty vector');
    }
    return vector;
  });
  const embedding = embeddingResult as number[];

  await step.run('store-embedding', async () => {
    await vectorService.upsertEntityEmbedding({
      entityId: payload.entityId,
      userId: payload.userId,
      entityType: payload.type,
      title: payload.title,
      preview: payload.preview,
      fileUrl: payload.fileUrl,
      embedding,
      embeddingModel: process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small',
    });
  });

  logger.info({ entityId: payload.entityId, userId: payload.userId }, 'Indexed entity embedding');
  return { status: 'indexed', entityId: payload.entityId };
};

export const indexEntityEmbedding = inngest.createFunction(
  { id: 'entity-embedding-indexer', name: 'Index Entity Embedding' },
  { event: 'api/event.logged' },
  async ({ event, step }) => {
    const { type, data } = event.data;

    if (type !== 'entity.created') {
      return { status: 'ignored', reason: 'non-entity-created' };
    }

    const payload = data as EntityCreatedEvent;
    return processEntityCreatedEvent(payload, step);
  }
);


