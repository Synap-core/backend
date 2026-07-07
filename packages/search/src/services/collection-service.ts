/**
 * Collection Management Service
 * Initialize and manage Typesense collections
 */

import { getTypesenseAdminClient } from "../client.js";
import {
  entitiesCollectionSchema,
  documentsCollectionSchema,
  viewsCollectionSchema,
  channelsCollectionSchema,
  agentsCollectionSchema,
} from "../collections/index.js";

export class CollectionService {
  private schemas = [
    entitiesCollectionSchema,
    documentsCollectionSchema,
    viewsCollectionSchema,
    channelsCollectionSchema,
    agentsCollectionSchema,
  ];

  /**
   * Initialize all collections
   */
  async initializeCollections(): Promise<void> {
    const client = getTypesenseAdminClient();

    for (const schema of this.schemas) {
      let live: Awaited<
        ReturnType<ReturnType<typeof client.collections>["retrieve"]>
      > | null = null;
      try {
        live = await client.collections(schema.name).retrieve();
      } catch {
        live = null;
      }

      if (!live) {
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
        continue;
      }

      // Collection exists — reconcile any NEW fields the schema gained since it
      // was created. Typesense will NOT index a field the live collection has
      // never heard of, so a schema field added in code (e.g. `searchAliases`)
      // stays silently inert on an existing pod until we add it here. We only
      // ADD missing fields (forced optional so it's safe on a populated
      // collection); we never drop or retype. A backfill of existing docs still
      // needs a reindex, but new/updated docs pick up the field immediately.
      await this.reconcileNewFields(schema, live);
    }
  }

  /** Add schema fields absent from the live collection. Additive only. */
  private async reconcileNewFields(
    schema: (typeof this.schemas)[number],
    live: { fields?: Array<{ name: string }> }
  ): Promise<void> {
    const client = getTypesenseAdminClient();
    const liveNames = new Set((live.fields ?? []).map((f) => f.name));
    const missing = (schema.fields ?? []).filter(
      (f) =>
        f.name !== ".*" &&
        // `id` is Typesense's special document key: it is NOT echoed in the
        // retrieved `fields` list and is un-alterable, so it must never be
        // treated as "missing" — including it makes the whole update 400.
        f.name !== "id" &&
        !liveNames.has(f.name)
    );
    if (missing.length === 0) return;

    try {
      await client.collections(schema.name).update({
        // Optional forced: adding a required field to a populated collection is
        // rejected by Typesense; every reconciled field must tolerate absence.
        fields: missing.map((f) => ({ ...f, optional: true })),
      });
      console.log(
        `Reconciled collection ${schema.name}: added [${missing
          .map((f) => f.name)
          .join(", ")}]`
      );
    } catch (updateError) {
      // Non-fatal: a failed alter must not block startup. Log loudly so the
      // missing field (and its inert search recall) is visible in boot logs.
      console.warn(
        `Failed to reconcile fields on ${schema.name}:`,
        updateError
      );
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
      } catch {
        stats[schema.name] = { error: "Collection not found" };
      }
    }

    return stats;
  }
}

export const collectionService = new CollectionService();
