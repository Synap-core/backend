
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventRepository } from '../event-repository.js';
import { WorkspaceRepository } from '../workspace-repository.js';

const mockDb = {
  query: {
    workspaces: {
      findFirst: vi.fn(),
    },
  },
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
} as any;

describe('WorkspaceRepository', () => {
  let workspaceRepo: WorkspaceRepository;
  let mockEventRepo: EventRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEventRepo = {
      append: vi.fn(),
    } as any;
    
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'ws-1', name: 'Test WS' }])
      })
    });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'ws-1', name: 'Updated WS' }])
        })
      })
    });

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'ws-1' }])
      })
    });

    workspaceRepo = new WorkspaceRepository(mockDb, mockEventRepo);
  });

  describe('create', () => {
    it('should create workspace and emit completed event', async () => {
      const ws = await workspaceRepo.create({
        name: 'Test WS',
        slug: 'test-ws',
        ownerId: 'user-1',
      }, 'user-1');

      expect(ws.name).toBe('Test WS');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'workspaces.create.completed',
        subjectId: 'ws-1',
      }));
    });
  });

  describe('update', () => {
    it('should update workspace and emit completed event', async () => {
      const updated = await workspaceRepo.update('ws-1', {
        name: 'Updated WS',
      }, 'user-1');

      expect(updated.name).toBe('Updated WS');
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'workspaces.update.completed',
      }));
    });
  });

  describe('delete', () => {
    it('should delete workspace and emit completed event', async () => {
      await workspaceRepo.delete('ws-1', 'user-1');
      expect(mockEventRepo.append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'workspaces.delete.completed',
      }));
    });
  });
});
