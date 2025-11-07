import { suggestionRepository } from '@synap/database';
import { z } from 'zod';
import {
  CreateProposeProjectSuggestionSchema,
  ProposeProjectPayloadSchema,
  SuggestionSchema,
  SuggestionStatusSchema,
  TagUsageCandidateSchema,
  RelatedEntitySummarySchema,
  type Suggestion,
  type SuggestionStatus,
  type CreateProposeProjectSuggestionInput,
  type TagUsageCandidate,
  type RelatedEntitySummary,
} from '../types.js';

const ListSuggestionsInputSchema = z.object({
  userId: z.string(),
  status: SuggestionStatusSchema.optional(),
});

const ChangeStatusInputSchema = z.object({
  userId: z.string(),
  suggestionId: z.string().uuid(),
});

const PendingProposeProjectLookupSchema = z.object({
  userId: z.string(),
  tagId: z.string(),
});

export class SuggestionService {
  constructor(private readonly repo = suggestionRepository) {}

  async listSuggestions(input: { userId: string; status?: SuggestionStatus }): Promise<Suggestion[]> {
    const parsed = ListSuggestionsInputSchema.parse(input);
    const records = await this.repo.listSuggestions(parsed.userId, parsed.status ?? 'pending');
    return records.map((record) => SuggestionSchema.parse(record));
  }

  async acceptSuggestion(input: { userId: string; suggestionId: string }): Promise<Suggestion> {
    const parsed = ChangeStatusInputSchema.parse(input);
    const record = await this.repo.updateStatus(parsed.userId, parsed.suggestionId, 'accepted');
    if (!record) {
      throw new Error('Suggestion not found');
    }
    return SuggestionSchema.parse(record);
  }

  async dismissSuggestion(input: { userId: string; suggestionId: string }): Promise<Suggestion> {
    const parsed = ChangeStatusInputSchema.parse(input);
    const record = await this.repo.updateStatus(parsed.userId, parsed.suggestionId, 'dismissed');
    if (!record) {
      throw new Error('Suggestion not found');
    }
    return SuggestionSchema.parse(record);
  }

  async createProposeProjectSuggestion(
    input: CreateProposeProjectSuggestionInput
  ): Promise<Suggestion> {
    const parsed = CreateProposeProjectSuggestionSchema.parse(input);
    const payload = ProposeProjectPayloadSchema.parse({
      tagId: parsed.tagId,
      tagName: parsed.tagName,
      usageCount: parsed.usageCount,
      timeRangeHours: parsed.timeRangeHours,
      relatedEntities: parsed.relatedEntities,
    });

    const suggestion = await this.repo.createSuggestion({
      userId: parsed.userId,
      type: 'propose_project',
      title: `Créer un projet autour de "${payload.tagName}"`,
      description: `Tu as utilisé le tag "${payload.tagName}" ${payload.usageCount} fois au cours des dernières ${payload.timeRangeHours} heures. Souhaites-tu en faire un projet dédié ?`,
      payload,
      confidence: parsed.confidence,
    });

    return SuggestionSchema.parse(suggestion);
  }

  async findPendingProposeProjectSuggestion(input: { userId: string; tagId: string }): Promise<Suggestion | null> {
    const parsed = PendingProposeProjectLookupSchema.parse(input);
    const record = await this.repo.findPendingByPayloadKey(
      parsed.userId,
      'propose_project',
      'tagId',
      parsed.tagId
    );

    return record ? SuggestionSchema.parse(record) : null;
  }

  async getRecentTagUsage(hours: number, minUsage: number): Promise<TagUsageCandidate[]> {
    const candidates = await this.repo.getRecentTagUsage(hours, minUsage);
    return candidates.map((candidate) => TagUsageCandidateSchema.parse(candidate));
  }

  async hasProjectForTag(tagId: string): Promise<boolean> {
    return this.repo.hasProjectForTag(tagId);
  }

  async getRelatedEntitiesForTag(tagId: string, limit: number): Promise<RelatedEntitySummary[]> {
    const entities = await this.repo.getRelatedEntitiesForTag(tagId, limit);
    return entities.map((entity) => RelatedEntitySummarySchema.parse(entity));
  }
}

export const suggestionService = new SuggestionService();




