/**
 * Entity Embedding Worker
 * 
 * Generates and stores embeddings for entities when they are created or updated.
 */

import { inngest } from '../client.js';
import { sql } from '@synap/database';

// Intelligence Hub client configuration
const INTELLIGENCE_HUB_URL = process.env.INTELLIGENCE_HUB_URL || 'http://localhost:3001';

/**
 * Generate embedding using Intelligence Hub
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${INTELLIGENCE_HUB_URL}/api/embeddings/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  
  if (!response.ok) {
    throw new Error(`Failed to generate embedding: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.embedding;
}

/**
 * Generate and store embedding for entity
 */
async function generateAndStoreEmbedding(
  entityId: string,
  userId: string,
  entityType: string,
  title: string,
  description?: string
): Promise<void> {
  const textToEmbed = `${title} ${description || ''}`.trim();
  
  const embedding = await generateEmbedding(textToEmbed);
  const embeddingStr = `[${embedding.join(',')}]`;
  
  // Upsert into entity_vectors
  await sql`
    INSERT INTO entity_vectors (entity_id, user_id, embedding, entity_type, title, preview)
    VALUES (${entityId}, ${userId}, ${embeddingStr}::vector, ${entityType}, ${title}, ${description || null})
    ON CONFLICT (entity_id) DO UPDATE SET
      embedding = ${embeddingStr}::vector,
      title = ${title},
      preview = ${description || null},
      updated_at = NOW()
  `;
}

/**
 * Handle entity created/updated events
 */
export const entityEmbeddingWorker = inngest.createFunction(
  {
    id: 'entity-embedding-worker',
    name: 'Generate Entity Embeddings',
    retries: 3,
  },
  [
    { event: 'entities.create.approved' },
    { event: 'entities.update.approved' },
  ],
  async ({ event, step }) => {
    const { entityId, userId, entityType, title, preview } = event.data;
    
    await step.run('generate-embedding', async () => {
      try {
        await generateAndStoreEmbedding(
          entityId,
          userId,
          entityType,
          title,
          preview
        );
        
        console.log(`✅ Generated embedding for entity ${entityId}`);
        
        return { success: true, entityId };
      } catch (error) {
        console.error(`❌ Failed to generate embedding for ${entityId}:`, error);
        throw error; // Inngest will retry
      }
    });
  }
);
