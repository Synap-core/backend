/**
 * Batch Index Existing Entities
 *
 * One-time script to generate embeddings for all existing entities.
 *
 * Usage:
 *   pnpm --filter @synap/jobs index-entities
 */

import { db, isNull, sql } from "@synap/database";
import { entities } from "@synap/database/schema";

// Intelligence Hub client configuration
const INTELLIGENCE_HUB_URL =
  process.env.INTELLIGENCE_HUB_URL || "http://localhost:3001";

/**
 * Generate embedding using Intelligence Hub
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    `${INTELLIGENCE_HUB_URL}/api/embeddings/generate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to generate embedding: ${response.statusText}`);
  }

  const data = await response.json();
  return (data as { embedding: number[] }).embedding;
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
  const textToEmbed = `${title} ${description || ""}`.trim();

  const embedding = await generateEmbedding(textToEmbed);
  const embeddingStr = `[${embedding.join(",")}]`;

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

async function indexExistingEntities() {
  console.log("🚀 Starting batch entity indexing...");

  // Get all entities without embeddings
  const allEntities = await db.query.entities.findMany({
    where: isNull(entities.deletedAt),
  });

  console.log(`📊 Found ${allEntities.length} entities to index`);

  let indexed = 0;
  let failed = 0;
  const startTime = Date.now();

  for (const entity of allEntities) {
    try {
      await generateAndStoreEmbedding(
        entity.id,
        entity.userId,
        entity.type,
        entity.title || "",
        entity.preview || undefined
      );

      indexed++;

      if (indexed % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = ((indexed / (Date.now() - startTime)) * 1000).toFixed(1);
        console.log(
          `✅ Indexed ${indexed}/${allEntities.length} entities (${rate} entities/sec, ${elapsed}s elapsed)`
        );
      }

      // Rate limit (OpenAI: 3000 RPM for tier 1 = 50 req/sec)
      // Use 20ms delay for 50 req/sec
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch (error) {
      console.error(
        `❌ Failed to index ${entity.id} (${entity.title}):`,
        error
      );
      failed++;
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgRate = ((indexed / (Date.now() - startTime)) * 1000).toFixed(1);

  console.log(`\n🎉 Batch indexing complete!`);
  console.log(`✅ Indexed: ${indexed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`⏱️  Total time: ${totalTime}s`);
  console.log(`📈 Average rate: ${avgRate} entities/sec`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  indexExistingEntities()
    .then(() => {
      console.log("\n✨ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

export { indexExistingEntities };
