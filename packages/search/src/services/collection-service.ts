/**
 * Collection Management Service
 * Initialize and manage Typesense collections
 */

import { getTypesenseAdminClient } from "../client.js";
import {
  entitiesCollectionSchema,
  documentsCollectionSchema,
  viewsCollectionSchema,
  projectsCollectionSchema,
  chatThreadsCollectionSchema,
  agentsCollectionSchema,
} from "../collections/index.js";

export class CollectionService {
  private schemas = [
    entitiesCollectionSchema,
    documentsCollectionSchema,
    viewsCollectionSchema,
    projectsCollectionSchema,
    chatThreadsCollectionSchema,
    agentsCollectionSchema,
  ];

  /**
   * Initialize all collections
   */
  async initializeCollections(): Promise<void> {
    const client = getTypesenseAdminClient();

    for (const schema of this.schemas) {
      try {
        // Check if collection exists
        await client.collections(schema.name).retrieve();
        console.log(`Collection ${schema.name} already exists`);
      } catch (error) {
        // Collection doesn't exist, create it
        try {
          await client.collections().create(schema);
          console.log(`Created collection: ${schema.name}`);
        } catch (createError) {
          console.error(
            `Failed to create collection ${schema.name}:`,
            createError
          );
          throw createError;
        }
      }
    }
  }

  /**
   * Drop all collections (use with caution!)
   */
  async dropAllCollections(): Promise<void> {
    const client = getTypesenseAdminClient();

    for (const schema of this.schemas) {
      try {
        await client.collections(schema.name).delete();
        console.log(`Dropped collection: ${schema.name}`);
      } catch (error) {
        console.warn(`Failed to drop collection ${schema.name}:`, error);
      }
    }
  }

  /**
   * Get collection stats
   */
  async getCollectionStats(): Promise<Record<string, any>> {
    const client = getTypesenseAdminClient();
    const stats: Record<string, any> = {};

    for (const schema of this.schemas) {
      try {
        const collection = await client.collections(schema.name).retrieve();
        stats[schema.name] = {
          numDocuments: collection.num_documents,
          createdAt: collection.created_at,
        };
      } catch (error) {
        stats[schema.name] = { error: "Collection not found" };
      }
    }

    return stats;
  }
}

export const collectionService = new CollectionService();
