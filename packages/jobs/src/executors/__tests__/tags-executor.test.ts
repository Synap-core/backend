
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagsHandler } from '../tags-executor.js';

// Create singleton mock functions to track calls
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

// Mock dependencies
vi.mock('@synap/database', () => {
  return {
    getDb: vi.fn().mockResolvedValue({}),
    EventRepository: vi.fn(),
    TagRepository: vi.fn().mockImplementation(() => ({
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    })),
  };
});

describe('TagsExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle create action', async () => {
    const event = {
      name: 'tags.create.validated',
      data: { name: 'Test', color: '#blue' },
      user: { userId: 'user-1' },
    };

    const result = await tagsHandler({ event } as any);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Test',
        color: '#blue',
        userId: 'user-1',
      }),
      'user-1'
    );
    expect(result).toEqual({ success: true, action: 'create' });
  });

  it('should handle update action', async () => {
    const event = {
      name: 'tags.update.validated',
      data: { id: 'tag-1', name: 'Updated' },
      user: { userId: 'user-1' },
    };

    const result = await tagsHandler({ event } as any);

    expect(mockUpdate).toHaveBeenCalledWith(
      'tag-1',
      expect.objectContaining({ name: 'Updated' }),
      'user-1'
    );
    expect(result).toEqual({ success: true, action: 'update' });
  });

  it('should handle delete action', async () => {
    const event = {
      name: 'tags.delete.validated',
      data: { id: 'tag-1' },
      user: { userId: 'user-1' },
    };

    const result = await tagsHandler({ event } as any);

    expect(mockDelete).toHaveBeenCalledWith('tag-1', 'user-1');
    expect(result).toEqual({ success: true, action: 'delete' });
  });
});
