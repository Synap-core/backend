
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventRepository } from '../event-repository.js';
import { ViewRepository } from '../view-repository.js';

const mockDb = {
  query: {
    views: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe('ViewRepository', () => {
  let viewRepo: ViewRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;
    
    // View repository logic often maps config -> metadata or similar. 
    // We assume standard insert/update mocking for now.
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'view-1', name: 'Test View' }])
      })
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'view-1', name: 'Updated View' }])
        })
      })
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'view-1' }])
      })
    });

    viewRepo = new ViewRepository(mockDb, mockEventRepo);
  });

  describe('create', () => {
    it('should create view and emit completed event', async () => {
      const view = await viewRepo.create({
        name: 'Test View',
        type: 'kanban',
        workspaceId: 'ws-1',
        config: {},
        userId: 'user-1',
      }, 'user-1');

      expect(view.name).toBe('Test View');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'views.create.completed',
        subjectId: 'view-1',
      }));
    });
  });

  describe('update', () => {
    it('should update view and emit completed event', async () => {
      const updated = await viewRepo.update('view-1', {
        name: 'Updated View',
      }, 'user-1');

      expect(updated.name).toBe('Updated View');
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'views.update.completed',
      }));
    });
  });

  describe('delete', () => {
    it('should delete view and emit completed event', async () => {
      await viewRepo.delete('view-1', 'user-1');
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'views.delete.completed',
      }));
    });
  });
});
