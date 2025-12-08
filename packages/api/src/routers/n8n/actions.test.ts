import { describe, it, expect, vi, beforeEach } from 'vitest';
import { n8nActionsRouter } from './actions.js';

// Mock dependencies
vi.mock('@synap/database', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
  },
  events: {},
  searchEntityVectorsRaw: vi.fn(),
}));

vi.mock('@synap/ai-embeddings', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

describe('n8n Actions Router', () => {
  let mockCtx: any;

  beforeEach(() => {
    mockCtx = {
      userId: 'user-123',
      apiKeyName: 'Test Key',
      scopes: ['write:entities', 'read:entities', 'ai:analyze'],
    };
    vi.clearAllMocks();
  });

  describe('createEntity', () => {
    it('should create an entity event', async () => {
      const caller = n8nActionsRouter.createCaller(mockCtx);
      
      const result = await caller.createEntity({
        type: 'note',
        content: 'Test content',
        title: 'Test Title',
      });

      expect(result.success).toBe(true);
      expect(result.entityId).toBeDefined();
      
      const { db } = await import('@synap/database');
      expect(db.insert).toHaveBeenCalled();
    });

    it('should require write:entities scope', async () => {
      mockCtx.scopes = ['read:entities']; // Missing write scope
      const caller = n8nActionsRouter.createCaller(mockCtx);
      
      await expect(caller.createEntity({
        type: 'note',
        content: 'Test',
      })).rejects.toThrow('Insufficient permissions');
    });
  });

  describe('searchEntities', () => {
    it('should return search results', async () => {
      const { searchEntityVectorsRaw } = await import('@synap/database');
      vi.mocked(searchEntityVectorsRaw).mockResolvedValue([
        {
          entityId: 'ent-1',
          userId: 'user-123',
          entityType: 'note',
          title: 'Result 1',
          preview: 'Preview',
          fileUrl: null,
          relevanceScore: 0.9,
        }
      ]);

      const caller = n8nActionsRouter.createCaller(mockCtx);
      
      const result = await caller.searchEntities({
        query: 'test query',
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].entityId).toBe('ent-1');
      expect(result.count).toBe(1);
    });

    it('should filter by type', async () => {
      const { searchEntityVectorsRaw } = await import('@synap/database');
      vi.mocked(searchEntityVectorsRaw).mockResolvedValue([
        { entityId: '1', entityType: 'note', relevanceScore: 0.9 } as any,
        { entityId: '2', entityType: 'task', relevanceScore: 0.8 } as any,
      ]);

      const caller = n8nActionsRouter.createCaller(mockCtx);
      
      const result = await caller.searchEntities({
        query: 'test',
        type: 'note',
      });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].type).toBe('note');
    });
  });

  describe('analyzeContent', () => {
    it('should perform requested analysis', async () => {
      const caller = n8nActionsRouter.createCaller(mockCtx);
      
      const result = await caller.analyzeContent({
        content: 'This is a great test content with #tag and - task item',
        analysisTypes: ['sentiment', 'tags', 'tasks'],
      });

      expect(result.success).toBe(true);
      expect(result.sentiment).toBe('positive');
      expect(result.tags).toContain('tag');
      expect(result.tasks).toHaveLength(1);
    });
  });
});
