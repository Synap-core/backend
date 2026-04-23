/**
 * Knowledge Keys Repository - Pod-wide procedural knowledge management
 *
 * CRUD for knowledge_keys table using Drizzle ORM + raw sql for full-text search.
 * Workspace-aware scope resolution:
 *   - workspaceId === undefined → unfiltered (admin/introspection)
 *   - workspaceId === null      → pod-wide only (WHERE workspace_id IS NULL)
 *   - workspaceId === string    → that workspace's lens (base + its own overlay)
 */

import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db } from "../client-pg.js";
import { knowledgeKeys } from "../schema/knowledge-keys.js";

// ─── Types ─────────────────────────────────────────────────────────────

export interface SaveKnowledgeKeyInput {
  key: string;
  value: string;
  workspaceId?: string | null;
  status?: string;
  author?: string;
}

export interface UpdateKnowledgeKeyInput {
  value?: string;
  status?: string;
  author?: string;
}

export interface ListInput {
  namespace?: string;
  status?: string;
  workspaceId?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeKeyRow {
  id: string;
  key: string;
  namespace: string;
  slug: string;
  value: string;
  workspaceId: string | null;
  version: number;
  status: string;
  author: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Split "namespace:slug" → [namespace, slug].
 * No colon → all namespace, empty slug.
 */
function splitKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return idx === -1 ? [key, ""] : [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * Build workspace_id condition from three-state workspaceId.
 */
function wsCondition(workspaceId?: string): ReturnType<typeof and> | undefined {
  if (workspaceId === undefined) return undefined;
  if (workspaceId === null) return isNull(knowledgeKeys.workspaceId);
  return or(
    eq(knowledgeKeys.workspaceId, workspaceId),
    isNull(knowledgeKeys.workspaceId)
  );
}

/**
 * Parse a row from the database into our typed record.
 * Handles both raw SQL rows and Drizzle query results.
 */
function parseRow(row: any): KnowledgeKeyRow {
  const createdAt = row.created_at ?? row.createdAt;
  const updatedAt = row.updated_at ?? row.updatedAt;

  return {
    id: row.id as string,
    key: row.key as string,
    namespace: row.namespace as string,
    slug: row.slug as string,
    value: row.value as string,
    workspaceId: (row.workspace_id ?? row.workspaceId) as string | null,
    version: Number(row.version ?? 1),
    status: row.status as string,
    author: row.author as string | null,
    createdAt:
      createdAt instanceof Date ? createdAt : new Date(createdAt as string),
    updatedAt:
      updatedAt instanceof Date ? updatedAt : new Date(updatedAt as string),
  };
}

export class KnowledgeKeysRepository {
  private readonly db: PostgresJsDatabase<any>;

  constructor(dbInstance: PostgresJsDatabase<any> = db) {
    this.db = dbInstance;
  }

  // ─── Get ───────────────────────────────────────────────────────────

  /**
   * Get a knowledge entry by its key string (e.g. "deploy:backend").
   */
  async getByKey(
    key: string,
    workspaceId?: string
  ): Promise<KnowledgeKeyRow | null> {
    const conditions = [eq(knowledgeKeys.key, key)];
    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .select()
      .from(knowledgeKeys)
      .where(and(...conditions))
      .orderBy(desc(knowledgeKeys.version), desc(knowledgeKeys.updatedAt))
      .limit(1);

    if (rows.length === 0) return null;
    return parseRow(rows[0]);
  }

  /**
   * Get by namespace + slug directly (bypasses colon parsing).
   */
  async getByNameAndSlug(
    namespace: string,
    slug: string,
    workspaceId?: string
  ): Promise<KnowledgeKeyRow | null> {
    const conditions = [
      eq(knowledgeKeys.namespace, namespace),
      eq(knowledgeKeys.slug, slug),
    ];
    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .select()
      .from(knowledgeKeys)
      .where(and(...conditions))
      .orderBy(desc(knowledgeKeys.updatedAt))
      .limit(1);

    if (rows.length === 0) return null;
    return parseRow(rows[0]);
  }

  // ─── Create ────────────────────────────────────────────────────────

  async create(input: SaveKnowledgeKeyInput): Promise<KnowledgeKeyRow> {
    const [ns, s] = splitKey(input.key);
    const wsId = input.workspaceId || null;

    const rows = await this.db
      .insert(knowledgeKeys)
      .values({
        key: input.key,
        namespace: ns,
        slug: s,
        value: input.value,
        workspaceId: wsId,
        status: input.status || "active",
        author: input.author || null,
      })
      .onConflictDoNothing()
      .returning();

    // Should not happen if caller checks existence first
    if (rows.length === 0) {
      // Fall back to getByKey
      const existing = await this.getByKey(input.key);
      if (existing) return existing;
      throw new Error(`Failed to create knowledge key: ${input.key}`);
    }

    return parseRow(rows[0]);
  }

  // ─── Update ────────────────────────────────────────────────────────

  /**
   * Update a knowledge entry. Sets version increment and updated_at.
   */
  async update(
    key: string,
    input: UpdateKnowledgeKeyInput,
    workspaceId?: string
  ): Promise<KnowledgeKeyRow | null> {
    const setFields: Record<string, unknown> = {};

    if (input.value !== undefined) setFields.value = input.value;
    if (input.status !== undefined) setFields.status = input.status;
    if (input.author !== undefined) setFields.author = input.author;

    if (Object.keys(setFields).length === 0) return null;

    // Add version bump and timestamp
    setFields.version = sql`${knowledgeKeys.version} + 1`;
    setFields.updatedAt = sql`now()`;

    const conditions = [eq(knowledgeKeys.key, key)];
    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .update(knowledgeKeys)
      .set(setFields)
      .where(and(...conditions))
      .returning();

    if (rows.length === 0) return null;
    return parseRow(rows[0]);
  }

  // ─── Upsert ────────────────────────────────────────────────────────

  /**
   * Insert or update. Creates new namespace/slug if key doesn't exist.
   * Always bumps version on update.
   */
  async upsert(
    key: string,
    input: SaveKnowledgeKeyInput
  ): Promise<KnowledgeKeyRow> {
    const existing = await this.getByKey(key);

    if (existing) {
      // Update existing
      const setFields: Record<string, unknown> = {
        value: input.value,
        workspaceId: input.workspaceId || null,
        status: input.status || "active",
        author: input.author || null,
        version: sql`${knowledgeKeys.version} + 1`,
        updatedAt: sql`now()`,
      };

      const rows = await this.db
        .update(knowledgeKeys)
        .set(setFields)
        .where(eq(knowledgeKeys.key, key))
        .returning();

      return parseRow(rows[0]);
    }

    // Create new
    return this.create(input);
  }

  // ─── List ──────────────────────────────────────────────────────────

  async list(input: ListInput): Promise<KnowledgeKeyRow[]> {
    const { namespace, status, workspaceId, limit = 50, offset = 0 } = input;

    const conditions: ReturnType<typeof and>[] = [];

    if (namespace !== undefined) {
      conditions.push(eq(knowledgeKeys.namespace, namespace));
    }
    if (status !== undefined) {
      conditions.push(eq(knowledgeKeys.status, status));
    }

    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .select()
      .from(knowledgeKeys)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(knowledgeKeys.namespace, knowledgeKeys.slug)
      .limit(limit)
      .offset(offset);

    return rows.map(parseRow);
  }

  /**
   * Count entries matching the filters.
   */
  async count(input?: ListInput): Promise<number> {
    const { namespace, status, workspaceId } = input ?? {};
    const conditions: ReturnType<typeof and>[] = [];

    if (namespace !== undefined) {
      conditions.push(eq(knowledgeKeys.namespace, namespace));
    }
    if (status !== undefined) {
      conditions.push(eq(knowledgeKeys.status, status));
    }
    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(knowledgeKeys)
      .where(conditions.length ? and(...conditions) : undefined);

    return Number(rows[0]?.count ?? 0);
  }

  // ─── Full-Text Search ─────────────────────────────────────────────

  /**
   * Postgres full-text search against knowledge key values.
   * Uses to_tsvector/to_tsquery with GIN index on value column.
   */
  async searchFullText(
    query: string,
    workspaceId?: string,
    limit: number = 10
  ): Promise<KnowledgeKeyRow[]> {
    // Build safe tsquery from terms (strip anything that could be SQL injection)
    const safeTerms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/[^a-zA-Z0-9àâçéèêëîïôûùüÿñæœÁÉÍÓÚáéíóú]/g, ""))
      .filter(Boolean);

    if (safeTerms.length === 0) return [];

    const tsqueryStr = safeTerms.map((t) => `${t}:*`).join(" & ");
    const tsquery = sql.raw(`to_tsquery('simple', '${tsqueryStr}'::text)`);

    const conditions: ReturnType<typeof and>[] = [
      sql`${sql.raw("to_tsvector('simple', value)")} @@ ${tsquery}`,
    ];

    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .select({
        ...knowledgeKeys,
        rank: sql<number>`ts_rank(to_tsvector('simple', value), ${tsquery})`,
      })
      .from(knowledgeKeys)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy((r: any) => desc(r.rank))
      .limit(limit);

    return rows.map((r: any) => parseRow(r));
  }

  /**
   * Simple keyword search (case-insensitive) as fallback when full-text search fails.
   */
  async searchKeyword(
    query: string,
    workspaceId?: string,
    limit: number = 10
  ): Promise<KnowledgeKeyRow[]> {
    const conditions: ReturnType<typeof and>[] = [
      ilike(knowledgeKeys.value, `%${query}%`),
    ];
    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const rows = await this.db
      .select()
      .from(knowledgeKeys)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(knowledgeKeys.updatedAt))
      .limit(limit);

    return rows.map(parseRow);
  }

  // ─── Delete ────────────────────────────────────────────────────────

  /**
   * Archive a knowledge entry (soft delete). Sets status to 'archived'.
   */
  async archive(key: string, workspaceId?: string): Promise<boolean> {
    const result = await this.update(key, { status: "archived" }, workspaceId);
    return result !== null;
  }

  /**
   * Hard delete a knowledge entry.
   */
  async delete(key: string, workspaceId?: string): Promise<boolean> {
    const conditions = [eq(knowledgeKeys.key, key)];
    const ws = wsCondition(workspaceId);
    if (ws) conditions.push(ws);

    const result = await this.db
      .delete(knowledgeKeys)
      .where(and(...conditions))
      .returning();

    return result.length > 0;
  }

  // ─── Admin helpers ─────────────────────────────────────────────────

  /**
   * Count entries by status (useful for dashboard stats).
   */
  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        status: knowledgeKeys.status,
        count: sql<number>`count(*)`,
      })
      .from(knowledgeKeys)
      .groupBy(knowledgeKeys.status);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = Number(row.count);
    }
    return result;
  }
}

// ─── Singleton ─────────────────────────────────────────────────────

let _knowledgeKeysRepository: KnowledgeKeysRepository | null = null;

export function getKnowledgeKeysRepository(): KnowledgeKeysRepository {
  if (!_knowledgeKeysRepository) {
    _knowledgeKeysRepository = new KnowledgeKeysRepository();
  }
  return _knowledgeKeysRepository;
}

export const knowledgeKeysRepository = getKnowledgeKeysRepository();
