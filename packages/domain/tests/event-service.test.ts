import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AppendEventInput, EventRecord } from '../src/types.js';

const defaultEventRepoMock = {
  append: vi.fn(),
  appendBatch: vi.fn(),
  getAggregateStream: vi.fn(),
  getAggregateVersion: vi.fn(),
  getUserStream: vi.fn(),
};

vi.mock('@synap/database', () => ({
  eventRepository: defaultEventRepoMock,
  AggregateType: {
    ENTITY: 'entity',
    RELATION: 'relation',
    USER: 'user',
    SYSTEM: 'system',
  },
  EventSource: {
    API: 'api',
    AUTOMATION: 'automation',
    SYNC: 'sync',
    MIGRATION: 'migration',
    SYSTEM: 'system',
  },
}));

const { EventService } = await import('../src/services/events.js');

class InMemoryEventRepo {
  private readonly events = new Map<string, EventRecord[]>();

  async append(input: any): Promise<EventRecord> {
    const record: EventRecord = {
      id: input.id || randomUUID(),
      timestamp: input.timestamp || new Date(),
      aggregateId: input.aggregateId,
      aggregateType: 'entity', // Default for tests since SynapEvent doesn't carry it
      eventType: input.type, // SynapEvent uses 'type', EventRecord uses 'eventType'
      userId: input.userId,
      data: input.data,
      metadata: input.metadata,
      version: typeof input.version === 'number' ? input.version : 1,
      causationId: input.causationId,
      correlationId: input.correlationId,
      source: input.source ?? 'api',
    };

    const stream = this.events.get(input.aggregateId) ?? [];
    stream.push(record);
    this.events.set(input.aggregateId, stream);

    return record;
  }

  async appendBatch(inputs: AppendEventInput[]): Promise<EventRecord[]> {
    const records = await Promise.all(inputs.map((input) => this.append(input)));
    return records;
  }

  async getAggregateStream(aggregateId: string): Promise<EventRecord[]> {
    return [...(this.events.get(aggregateId) ?? [])];
  }

  async getAggregateVersion(aggregateId: string): Promise<number | null> {
    const stream = this.events.get(aggregateId) ?? [];
    return stream.length === 0 ? null : stream.at(-1)!.version;
  }

  async getUserStream(userId: string): Promise<EventRecord[]> {
    return [...this.events.values()].flat().filter((event) => event.userId === userId);
  }
}

describe('EventService', () => {
  const repo = new InMemoryEventRepo() as any;
  const service = new EventService(repo);

  it('appends events with domain types', async () => {
    const aggregateId = randomUUID();
    const event = await service.append({
      aggregateId,
      aggregateType: 'entity',
      eventType: 'entity.created',
      userId: 'user-events',
      data: { title: 'Test' },
      version: 1,
      source: 'api',
    });

    expect(event.aggregateId).toBe(aggregateId);
    expect(event.data).toMatchObject({ title: 'Test' });
    expect(event.version).toBe(1);
  });

  it('returns aggregate stream and version', async () => {
    const aggregateId = randomUUID();

    await service.append({
      aggregateId,
      aggregateType: 'entity',
      eventType: 'entity.created',
      userId: 'user-stream',
      data: { title: 'Stream Event' },
      version: 1,
      source: 'api',
    });

    const stream = await service.getAggregateStream(aggregateId);
    expect(stream).toHaveLength(1);

    const version = await service.getAggregateVersion(aggregateId);
    expect(version).toBe(1);
  });
});


