/**
 * Suggestion Repository - AI Suggestions Management
 *
 * Uses shared postgres.js client from client-pg.ts
 */

import { sql } from "../client-pg.js";
import { randomUUID } from "crypto";
import type { AISuggestionRow } from "../schema/ai-suggestions.js";

export type AISuggestionStatus = "pending" | "accepted" | "dismissed";

export interface CreateSuggestionInput {
  userId: string;
  type: string;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
  confidence: number;
}

export interface SuggestionRecord {
  id: string;
  userId: string;
  type: string;
  status: AISuggestionStatus;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

type MemorySuggestionStore = Map<string, SuggestionRecord[]>;

export interface TagUsageCandidate {
  userId: string;
  tagId: string;
  tagName: string;
  usageCount: number;
}

export interface RelatedEntitySummary {
  entityId: string;
  title: string | null;
}

export class SuggestionRepository {
  private readonly useDatabase: boolean;
  private readonly memoryStore?: MemorySuggestionStore;

  constructor(useDatabase: boolean = true) {
    this.useDatabase = useDatabase;
    if (!useDatabase) {
      this.memoryStore = new Map();
    }
  }

  async createSuggestion(
    input: CreateSuggestionInput,
  ): Promise<SuggestionRecord> {
    if (this.useDatabase) {
      const result = await sql`
        INSERT INTO ai_suggestions (
          user_id,
          type,
          status,
          title,
          description,
          payload,
          confidence
        ) VALUES (
          ${input.userId},
          ${input.type},
          'pending',
          ${input.title},
          ${input.description},
          ${input.payload ? JSON.stringify(input.payload) : null},
          ${input.confidence}
        )
        RETURNING *
      `;

      return this.mapRow(result[0]);
    }

    if (!this.memoryStore) {
      throw new Error("Suggestion repository not initialised.");
    }

    const record: SuggestionRecord = {
      id: randomUUID(),
      userId: input.userId,
      type: input.type,
      status: "pending",
      title: input.title,
      description: input.description,
      payload: input.payload,
      confidence: input.confidence,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const suggestions = this.memoryStore.get(input.userId) ?? [];
    suggestions.unshift(record);
    this.memoryStore.set(input.userId, suggestions);

    return record;
  }

  async listSuggestions(
    userId: string,
    status: AISuggestionStatus = "pending",
  ): Promise<SuggestionRecord[]> {
    const records = await this.fetchSuggestions(userId);
    return records.filter((suggestion) => suggestion.status === status);
  }

  async findPendingByPayloadKey(
    userId: string,
    type: string,
    payloadKey: string,
    payloadValue: string,
  ): Promise<SuggestionRecord | null> {
    if (this.useDatabase) {
      const result = await sql`
        SELECT * FROM ai_suggestions
        WHERE user_id = ${userId}
          AND type = ${type}
          AND status = 'pending'
          AND payload ->> ${payloadKey} = ${payloadValue}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      return result.length > 0 ? this.mapRow(result[0]) : null;
    }

    if (!this.memoryStore) {
      return null;
    }

    const suggestions = this.memoryStore.get(userId) ?? [];
    return (
      suggestions.find(
        (suggestion) =>
          suggestion.status === "pending" &&
          suggestion.type === type &&
          suggestion.payload?.[payloadKey] === payloadValue,
      ) ?? null
    );
  }

  async updateStatus(
    userId: string,
    suggestionId: string,
    status: AISuggestionStatus,
  ): Promise<SuggestionRecord | null> {
    if (this.useDatabase) {
      const result = await sql`
        UPDATE ai_suggestions
        SET status = ${status},
            updated_at = NOW()
        WHERE id = ${suggestionId} AND user_id = ${userId}
        RETURNING *
      `;

      return result.length > 0 ? this.mapRow(result[0]) : null;
    }

    if (!this.memoryStore) {
      return null;
    }

    const suggestions = this.memoryStore.get(userId) ?? [];
    const suggestion = suggestions.find((item) => item.id === suggestionId);

    if (!suggestion) {
      return null;
    }

    suggestion.status = status;
    suggestion.updatedAt = new Date();
    return suggestion;
  }

  async getRecentTagUsage(
    hours: number,
    minUsage: number,
  ): Promise<TagUsageCandidate[]> {
    if (!this.useDatabase) {
      return [];
    }

    const result = await sql`
      SELECT t.user_id, t.id AS tag_id, t.name AS tag_name, COUNT(*)::int AS usage_count
      FROM tags t
      JOIN entity_tags et ON et.tag_id = t.id
      JOIN entities e ON e.id = et.entity_id
      WHERE e.deleted_at IS NULL
        AND e.created_at >= NOW() - (${hours} || ' hours')::INTERVAL
      GROUP BY t.user_id, t.id, t.name
      HAVING COUNT(*) >= ${minUsage}
    `;

    return result.map((row) => ({
      userId: row.user_id as string,
      tagId: row.tag_id as string,
      tagName: row.tag_name as string,
      usageCount: Number(row.usage_count),
    }));
  }

  async hasProjectForTag(tagId: string): Promise<boolean> {
    if (!this.useDatabase) {
      return false;
    }

    const result = await sql`
      SELECT COUNT(*)::int AS count
      FROM entity_tags et
      JOIN entities e ON e.id = et.entity_id
      WHERE et.tag_id = ${tagId} AND e.type = 'project' AND e.deleted_at IS NULL
    `;

    return Number(result[0]?.count ?? 0) > 0;
  }

  async getRelatedEntitiesForTag(
    tagId: string,
    limit: number,
  ): Promise<RelatedEntitySummary[]> {
    if (!this.useDatabase) {
      return [];
    }

    const result = await sql`
      SELECT e.id, e.title
      FROM entity_tags et
      JOIN entities e ON e.id = et.entity_id
      WHERE et.tag_id = ${tagId} AND e.deleted_at IS NULL
      ORDER BY e.created_at DESC
      LIMIT ${limit}
    `;

    return result.map((row) => ({
      entityId: row.id as string,
      title: (row.title as string | null) ?? null,
    }));
  }

  private async fetchSuggestions(userId: string): Promise<SuggestionRecord[]> {
    if (this.useDatabase) {
      const result = await sql`
        SELECT * FROM ai_suggestions
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
      `;

      return result.map((row) => this.mapRow(row));
    }

    if (!this.memoryStore) {
      return [];
    }

    return [...(this.memoryStore.get(userId) ?? [])];
  }

  private mapRow(
    row: AISuggestionRow | Record<string, unknown>,
  ): SuggestionRecord {
    const raw = row as Record<string, unknown>;

    const id = (raw.id ?? raw["id"]) as string;
    const userId = (raw.userId ?? raw["user_id"]) as string;
    const type = (raw.type ?? raw["type"]) as string;
    const statusRaw = raw.status ?? raw["status"];
    const status = statusRaw as string as AISuggestionStatus;
    const title = (raw.title ?? raw["title"]) as string;
    const description = (raw.description ?? raw["description"]) as string;
    const payloadRaw = raw.payload ?? raw["payload"];
    const payload =
      typeof payloadRaw === "string"
        ? JSON.parse(payloadRaw)
        : (payloadRaw as Record<string, unknown> | undefined);
    const confidenceValue = raw.confidence ?? raw["confidence"];
    const confidence =
      typeof confidenceValue === "number"
        ? confidenceValue
        : Number(confidenceValue ?? 0);
    const createdAtRaw = raw.createdAt ?? raw["created_at"];
    const updatedAtRaw = raw.updatedAt ?? raw["updated_at"];
    const createdAt =
      createdAtRaw instanceof Date
        ? createdAtRaw
        : new Date(createdAtRaw as string | number | Date);
    const updatedAt =
      updatedAtRaw instanceof Date
        ? updatedAtRaw
        : new Date(updatedAtRaw as string | number | Date);

    return {
      id,
      userId,
      type,
      status,
      title,
      description,
      payload,
      confidence,
      createdAt,
      updatedAt,
    };
  }
}

let _suggestionRepository: SuggestionRepository | null = null;

export function getSuggestionRepository(): SuggestionRepository {
  if (!_suggestionRepository) {
    const isPostgres = process.env.DB_DIALECT === "postgres";
    const connectionString = process.env.DATABASE_URL;

    if (isPostgres && connectionString) {
      _suggestionRepository = new SuggestionRepository(true);
    } else {
      _suggestionRepository = new SuggestionRepository(false);
    }
  }

  return _suggestionRepository;
}

export const suggestionRepository = getSuggestionRepository();
