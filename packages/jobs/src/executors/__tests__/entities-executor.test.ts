
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { entitiesHandler } from '../entities-executor.js';

// Mock dependencies
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('@synap/database', () => {
  return {
    getDb: vi.fn(),
    EventRepository: vi.fn(),
    EntityRepository: vi.fn().mockImplementation(() => ({
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
    })),
  };
});

describe('EntitiesExecutor', () => {
  let mockStep: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStep = {
      run: vi.fn((_name, fn) => fn()),
    };
  });

  it('should handle create action', async () => {
    const event = {
      name: 'entities.create.validated',
      data: {
        entityType: 'note',
        title: 'Test Entity',
        fileUrl: 's3://',
        filePath: '/path',
        fileSize: 100
      },
      user: { userId: 'user-1' },
    };

    const result = await entitiesHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith("process-entity", expect.any(Function));
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'note',
        title: 'Test Entity',
        userId: 'user-1',
      }),
      'user-1'
    );
    expect(result).toEqual({ success: true, action: 'create' });
  });

  it('should handle update action', async () => {
    const event = {
      name: 'entities.update.validated',
      data: { id: 'entity-1', title: 'Updated' },
      user: { userId: 'user-1' },
    };

    await entitiesHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith("process-entity", expect.any(Function));
    expect(mockUpdate).toHaveBeenCalledWith(
      'entity-1',
      expect.objectContaining({ title: 'Updated' }),
      'user-1'
    );
  });

  it('should handle delete action', async () => {
    const event = {
      name: 'entities.delete.validated',
      data: { id: 'entity-1' },
      user: { userId: 'user-1' },
    };

    await entitiesHandler({ event, step: mockStep } as any);

    expect(mockStep.run).toHaveBeenCalledWith("process-entity", expect.any(Function));
    expect(mockDelete).toHaveBeenCalledWith('entity-1', 'user-1');
  });
});
