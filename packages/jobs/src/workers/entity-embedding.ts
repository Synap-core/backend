/**
 * Entity Embedding Worker
 *
 * Generates and stores embeddings for entities.
 * Ported from Inngest function: entity-embedding.ts
 */

import type PgBoss from "pg-boss";
import { sql, loadDocumentBodyTexts } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { markdownToPlainText } from "@synap-core/markdown-core/plain-text";
import {
  buildEntityEmbeddingText,
  type EntityEmbeddingFacet,
} from "@synap/ai-embeddings";
import { generateEmbedding } from "./is-embeddings.js";

const logger = createLogger({ module: "entity-embedding-worker" });

export async function handleEntityEmbedding(
  job: PgBoss.Job<{
    entityId: string;
    userId: string;
    workspaceId?: string;
    entityType?: string;
    title?: string;
    preview?: string;
  }>
): Promise<void> {
  const { entityId, userId, entityType, title, preview } = job.data;

  let entityTitle = title;
  let entityPreview = preview;
  let type = entityType;
  let entityProperties: Record<string, unknown> | null = null;
  let entityFacets: EntityEmbeddingFacet[] = [];
  let documentText: string | null = null;

  // Always load the row for `properties` (and as fallback for title/type/preview)
  // so the embedding includes typed properties — not just title+preview — which
  // is what lets semantic recall match type/role/property queries.
  {
    const { entities, documentVersions, eq, desc, db, getEffectiveFacets } =
      await import("@synap/database");
    const [entity] = await db
      .select({
        title: entities.title,
        type: entities.type,
        preview: entities.preview,
        properties: entities.properties,
        documentId: entities.documentId,
      })
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    if (entity) {
      entityTitle = entityTitle || entity.title || "";
      entityPreview = entityPreview || entity.preview || "";
      type = type || entity.type;
      entityProperties =
        (entity.properties as Record<string, unknown> | null) ?? null;
    }

    // Linked document body — feed the attached document's text into the
    // embedding so semantic recall can match an entity by its document
    // contents, not just its title/properties. The STORED body (what the
    // document says now), never the last checkpoint row: a person's saves cut
    // no checkpoint, so the version row held text from before every edit
    // (recall plan A-W2). A body that cannot be read throws (pg-boss retries)
    // rather than overwrite the vector with one that lost the body.
    if (entity?.documentId) {
      const bodies = await loadDocumentBodyTexts(db, [entity.documentId], {
        markdownText: (markdown) => markdownToPlainText(markdown),
      });
      const failure = bodies.failed.get(entity.documentId);
      if (failure !== undefined) {
        throw new Error(
          `Could not read the body of document ${entity.documentId}: ${failure}`
        );
      }
      documentText = bodies.texts.get(entity.documentId) ?? null;
      // A body with no text of its own (an uploaded PDF, image or audio) has
      // its EXTRACTED text only on the version row (`extractedText`, see
      // `document-version-storage.ts`): read it there, as before.
      if (documentText === null) {
        const [docVersion] = await db
          .select({ content: documentVersions.content })
          .from(documentVersions)
          .where(eq(documentVersions.documentId, entity.documentId))
          .orderBy(desc(documentVersions.version))
          .limit(1);
        if (docVersion?.content) {
          documentText = docVersion.content;
        }
      }
    }

    // Live facets (Kind+Facets) — unfiltered lens, all workspaces, so the
    // embedding reflects every role attached to the entity regardless of scope.
    const effectiveFacets = await getEffectiveFacets(db, entityId, {
      userId,
      workspaceId: undefined,
    });
    entityFacets = effectiveFacets.map((ef) => ({
      slug: ef.profile.slug,
      status: ef.facet.status,
      properties: ef.facet.properties as Record<string, unknown> | null,
    }));
  }

  if (!entityTitle) {
    logger.warn(
      { entityId },
      "Entity not found or has no title, skipping embedding"
    );
    return;
  }

  const textToEmbed = buildEntityEmbeddingText({
    type,
    title: entityTitle,
    preview: entityPreview,
    documentText,
    properties: entityProperties,
    facets: entityFacets,
  });
  const embedding = await generateEmbedding(textToEmbed);
  const embeddingStr = `[${embedding.join(",")}]`;

  await sql`
    INSERT INTO entity_vectors (entity_id, user_id, embedding, entity_type, title, preview)
    VALUES (${entityId}, ${userId}, ${embeddingStr}::vector, ${type || "entity"}, ${entityTitle}, ${entityPreview || null})
    ON CONFLICT (entity_id) DO UPDATE SET
      embedding = ${embeddingStr}::vector,
      title = ${entityTitle},
      preview = ${entityPreview || null},
      updated_at = NOW()
  `;

  logger.info({ entityId }, "Entity embedding generated");
}
