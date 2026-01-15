
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { viewsHandler } from '../views-executor.js';

// Mock dependencies
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@synap/database', () => {
  return {
    getDb: vi.fn(),
    EventRepository: vi.fn(),
    ViewRepository: vi.fn().mockImplementation(() => ({
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    })),
  };
});

describe('ViewsExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle create action', async () => {
    const event = {
      name: 'views.create.validated',
      data: {
        name: 'Test View',
        type: 'kanban',
      },
      user: { userId: 'user-1' },
    };

    const result = await viewsHandler({ event } as any);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test View',
        userId: 'user-1',
      }),
      'user-1'
    );
    expect(result).toEqual({ success: true, action: 'create' });
  });

  it('should handle update action', async () => {
    const event = {
      name: 'views.update.validated',
      data: { id: 'view-1', name: 'Updated' },
      user: { userId: 'user-1' },
    };

    await viewsHandler({ event } as any);

    expect(mockUpdate).toHaveBeenCalledWith(
      'view-1',
      expect.objectContaining({ name: 'Updated' }),
      'user-1'
    );
  });

  it('should handle delete action', async () => {
    const event = {
      name: 'views.delete.validated',
      data: { id: 'view-1' },
      user: { userId: 'user-1' },
    };

    await viewsHandler({ event } as any);

    expect(mockDelete).toHaveBeenCalledWith('view-1', 'user-1');
  });
});
