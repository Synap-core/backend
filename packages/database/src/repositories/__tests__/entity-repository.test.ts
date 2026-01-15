
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventRepository } from '../event-repository.js';
import { EntityRepository } from '../entity-repository.js';

const mockDb = {
  query: {
    entities: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe('EntityRepository', () => {
  let entityRepo: EntityRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;
    
    // Setup chainable mocks
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'entity-1', title: 'Test Entity' }])
      })
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'entity-1', title: 'Updated Entity' }])
        })
      })
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'entity-1' }])
      })
    });

    entityRepo = new EntityRepository(mockDb, mockEventRepo);
  });

  describe('create', () => {
    it('should create entity and emit completed event', async () => {
      const result = await entityRepo.create(
        {
          title: 'Test Entity',
          entityType: 'note',
          userId: 'user-1',
        },
        'user-1',
      );

      expect(result.title).toBe('Test Entity');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'entities.create.completed',
        subjectId: 'entity-1',
        data: expect.objectContaining({
          title: 'Test Entity',
          id: 'entity-1'
        }),
      }));
    });
  });

  describe('update', () => {
    it('should update entity and emit completed event', async () => {
      const updated = await entityRepo.update('entity-1', {
        title: 'Updated Entity',
      }, 'user-1');

      expect(updated.title).toBe('Updated Entity');
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'entities.update.completed',
        subjectId: 'entity-1',
        data: expect.objectContaining({
          title: 'Updated Entity',
          id: 'entity-1'
        }),
      }));
    });
  });

  describe('delete', () => {
    it('should delete entity and emit completed event', async () => {
      await entityRepo.delete('entity-1', 'user-1');

      expect(mockDb.delete).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'entities.delete.completed',
        subjectId: 'entity-1',
        data: expect.objectContaining({
          id: 'entity-1'
        }),
      }));
    });
  });
});
