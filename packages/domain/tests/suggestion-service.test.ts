import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { SuggestionService } from '../src/services/suggestions.js';
import type { Suggestion, TagUsageCandidate, RelatedEntitySummary } from '../src/types.js';

vi.mock('@synap/database', () => ({
  suggestionRepository: {
    createSuggestion: () => {
      throw new Error('suggestionRepository mock should not be called in unit tests');
    },
    listSuggestions: () => {
      throw new Error('suggestionRepository mock should not be called in unit tests');
    },
    updateStatus: () => {
      throw new Error('suggestionRepository mock should not be called in unit tests');
    },
    findPendingByPayloadKey: () => {
      throw new Error('suggestionRepository mock should not be called in unit tests');
    },
    getRecentTagUsage: () => [],
    hasProjectForTag: () => false,
    getRelatedEntitiesForTag: () => [],
  },
}));

class InMemorySuggestionRepo {
  private readonly suggestions = new Map<string, Suggestion[]>();

  async createSuggestion(input: {
    userId: string;
    type: string;
    title: string;
    description: string;
    payload?: Record<string, unknown>;
    confidence: number;
  }): Promise<Suggestion> {
    const suggestion: Suggestion = {
      id: randomUUID(),
      userId: input.userId,
      type: input.type as Suggestion['type'],
      status: 'pending',
      title: input.title,
      description: input.description,
      payload: input.payload,
      confidence: input.confidence,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const list = this.suggestions.get(input.userId) ?? [];
    list.unshift(suggestion);
    this.suggestions.set(input.userId, list);

    return suggestion;
  }

  async listSuggestions(userId: string, status: Suggestion['status'] = 'pending'): Promise<Suggestion[]> {
    const collection = this.suggestions.get(userId) ?? [];
    return collection.filter((suggestion) => suggestion.status === status);
  }

  async updateStatus(
    userId: string,
    suggestionId: string,
    status: Suggestion['status']
  ): Promise<Suggestion | null> {
    const collection = this.suggestions.get(userId);
    if (!collection) {
      return null;
    }
    const item = collection.find((suggestion) => suggestion.id === suggestionId);
    if (!item) {
      return null;
    }
    item.status = status;
    item.updatedAt = new Date();
    return item;
  }

  async findPendingByPayloadKey(
    userId: string,
    type: string,
    payloadKey: string,
    payloadValue: string
  ): Promise<Suggestion | null> {
    const collection = this.suggestions.get(userId) ?? [];
    return (
      collection.find(
        (suggestion) =>
          suggestion.type === type &&
          suggestion.status === 'pending' &&
          (suggestion.payload as Record<string, unknown> | undefined)?.[payloadKey] === payloadValue
      ) ?? null
    );
  }

  async getRecentTagUsage(): Promise<TagUsageCandidate[]> {
    return [];
  }

  async hasProjectForTag(): Promise<boolean> {
    return false;
  }

  async getRelatedEntitiesForTag(): Promise<RelatedEntitySummary[]> {
    return [];
  }
}

describe('SuggestionService', () => {
  it('creates, lists, accepts and dismisses project suggestions', async () => {
    const service = new SuggestionService(new InMemorySuggestionRepo() as any);

    // No suggestions initially
    const initial = await service.listSuggestions({ userId: 'user-tag' });
    expect(initial).toHaveLength(0);

    // Create suggestion
    const created = await service.createProposeProjectSuggestion({
      userId: 'user-tag',
      tagId: 'tag-123',
      tagName: 'LangGraph',
      usageCount: 4,
      timeRangeHours: 24,
      confidence: 0.7,
      relatedEntities: [
        { entityId: 'entity-1', title: 'Prototype LangGraph' },
        { entityId: 'entity-2', title: 'Notes de réunion' },
      ],
    });

    expect(created.type).toBe('propose_project');
    expect(created.status).toBe('pending');
    expect(created.payload?.tagName).toBe('LangGraph');

    // Listing returns the pending suggestion
    const pending = await service.listSuggestions({ userId: 'user-tag', status: 'pending' });
    expect(pending).toHaveLength(1);

    // Accept moves it to accepted status
    const accepted = await service.acceptSuggestion({
      userId: 'user-tag',
      suggestionId: created.id,
    });
    expect(accepted.status).toBe('accepted');

    const pendingAfterAccept = await service.listSuggestions({ userId: 'user-tag' });
    expect(pendingAfterAccept).toHaveLength(0);

    const acceptedList = await service.listSuggestions({ userId: 'user-tag', status: 'accepted' });
    expect(acceptedList).toHaveLength(1);

    // Dismiss example
    const dismissed = await service.dismissSuggestion({
      userId: 'user-tag',
      suggestionId: created.id,
    });
    expect(dismissed.status).toBe('dismissed');
  });

  it('detects existing pending suggestion for the same tag', async () => {
    const service = new SuggestionService(new InMemorySuggestionRepo() as any);

    await service.createProposeProjectSuggestion({
      userId: 'user-pending',
      tagId: 'tag-duplicate',
      tagName: 'Timescale',
      usageCount: 5,
      timeRangeHours: 24,
      confidence: 0.6,
      relatedEntities: [],
    });

    const pending = await service.findPendingProposeProjectSuggestion({
      userId: 'user-pending',
      tagId: 'tag-duplicate',
    });

    expect(pending).not.toBeNull();
    expect(pending?.payload).toMatchObject({ tagName: 'Timescale' });
  });
});


