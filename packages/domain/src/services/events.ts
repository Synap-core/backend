import {
  eventRepository,
  AggregateType as RepoAggregateType,
  EventSource as RepoEventSource,
} from '@synap/database';
import {
  AppendEventInputSchema,
  AppendEventBatchInputSchema,
  EventRecordSchema,
  GetAggregateStreamOptionsSchema,
  GetUserStreamOptionsSchema,
  type AppendEventInput,
  type AppendEventBatchInput,
  type EventRecord,
  type GetAggregateStreamOptions,
  type GetUserStreamOptions,
  type AggregateType,
  type EventSource,
} from '../types.js';
import { createSynapEvent } from '@synap/types';
import { publishDomainEvent } from './event-publisher.js';

const aggregateTypeMap: Record<AggregateType, RepoAggregateType> = {
  entity: RepoAggregateType.ENTITY,
  relation: RepoAggregateType.RELATION,
  user: RepoAggregateType.USER,
  system: RepoAggregateType.SYSTEM,
};

const eventSourceMap: Record<EventSource, RepoEventSource> = {
  api: RepoEventSource.API,
  automation: RepoEventSource.AUTOMATION,
  sync: RepoEventSource.SYNC,
  migration: RepoEventSource.MIGRATION,
  system: RepoEventSource.SYSTEM,
};

const mapEventSource = (source?: EventSource): 'api' | 'automation' | 'sync' | 'migration' | 'system' => {
  if (!source) return 'api';
  const mapped = eventSourceMap[source];
  return mapped === RepoEventSource.API ? 'api' :
         mapped === RepoEventSource.AUTOMATION ? 'automation' :
         mapped === RepoEventSource.SYNC ? 'sync' :
         mapped === RepoEventSource.MIGRATION ? 'migration' : 'system';
};

/**
 * EventService - DEPRECATED (V0.6)
 * 
 * ⚠️ **THIS SERVICE IS DEPRECATED AND SHOULD NOT BE USED**
 * 
 * V0.6: All references to eventService have been removed from the codebase.
 * This class is kept for backward compatibility only and will be removed in a future version.
 * 
 * **Migration Guide**:
 * - Instead of `eventService.append()`, use:
 *   1. `createSynapEvent()` to create the event
 *   2. `getEventRepository().append()` to store it
 *   3. `publishEvent()` to publish to Inngest
 * 
 * - Instead of `eventService.getUserStream()`, use:
 *   `getEventRepository().getUserStream()`
 * 
 * @deprecated V0.6 - Use direct event publishing instead
 */
export class EventService {
  constructor(private readonly repo = eventRepository) {}

  /**
   * @deprecated Use createSynapEvent() and publish to Inngest directly
   */
  async append(input: AppendEventInput): Promise<EventRecord> {
    const parsed = AppendEventInputSchema.parse(input);
    
    // Convert AppendEventInput to SynapEvent
    const synapEvent = createSynapEvent({
      type: parsed.eventType as any, // Type assertion for Phase 1 compatibility
      data: parsed.data,
      userId: parsed.userId,
      aggregateId: parsed.aggregateId,
      source: mapEventSource(parsed.source),
      causationId: parsed.causationId,
      correlationId: parsed.correlationId,
      // Note: requestId not in AppendEventInput, will be undefined
    });
    
    const record = await this.repo.append(synapEvent);
    const eventRecord = EventRecordSchema.parse(record);
    await publishDomainEvent(eventRecord);
    return eventRecord;
  }

  /**
   * @deprecated Use createSynapEvent() and publish to Inngest directly
   */
  async appendBatch(inputs: AppendEventBatchInput): Promise<EventRecord[]> {
    const parsedInputs = AppendEventBatchInputSchema.parse(inputs);
    
    // Convert AppendEventInput[] to SynapEvent[]
    const synapEvents = parsedInputs.map((parsed) => createSynapEvent({
      type: parsed.eventType as any,
      data: parsed.data,
      userId: parsed.userId,
      aggregateId: parsed.aggregateId,
      source: mapEventSource(parsed.source),
      causationId: parsed.causationId,
      correlationId: parsed.correlationId,
    }));
    
    const records = await this.repo.appendBatch(synapEvents);
    const parsedRecords = records.map((record) => EventRecordSchema.parse(record));
    await Promise.all(parsedRecords.map((record) => publishDomainEvent(record)));
    return parsedRecords;
  }

  async getAggregateVersion(aggregateId: string): Promise<number | null> {
    return this.repo.getAggregateVersion(aggregateId);
  }

  async getAggregateStream(
    aggregateId: string,
    options: GetAggregateStreamOptions = {}
  ): Promise<EventRecord[]> {
    const parsedOptions = GetAggregateStreamOptionsSchema.parse(options);
    const stream = await this.repo.getAggregateStream(aggregateId, {
      fromVersion: parsedOptions.fromVersion,
      toVersion: parsedOptions.toVersion,
      eventTypes: parsedOptions.eventTypes,
    });
    return stream.map((record) => EventRecordSchema.parse(record));
  }

  async getUserStream(
    userId: string,
    options: GetUserStreamOptions = {}
  ): Promise<EventRecord[]> {
    const parsed = GetUserStreamOptionsSchema.parse(options);
    const stream = await this.repo.getUserStream(userId, {
      days: parsed.days,
      limit: parsed.limit,
      eventTypes: parsed.eventTypes,
      aggregateTypes: parsed.aggregateTypes?.map((type) => aggregateTypeMap[type]),
    });
    return stream.map((record) => EventRecordSchema.parse(record));
  }

  async getCorrelatedEvents(correlationId: string): Promise<EventRecord[]> {
    const records = await this.repo.getCorrelatedEvents(correlationId);
    return records.map((record) => EventRecordSchema.parse(record));
  }
}

export const eventService = new EventService();


