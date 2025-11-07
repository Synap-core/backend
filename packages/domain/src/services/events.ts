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

const mapEventSource = (source?: EventSource) => (source ? eventSourceMap[source] : undefined);

export class EventService {
  constructor(private readonly repo = eventRepository) {}

  async append(input: AppendEventInput): Promise<EventRecord> {
    const parsed = AppendEventInputSchema.parse(input);
    const record = await this.repo.append({
      aggregateId: parsed.aggregateId,
      aggregateType: aggregateTypeMap[parsed.aggregateType],
      eventType: parsed.eventType,
      userId: parsed.userId,
      data: parsed.data,
      metadata: parsed.metadata,
      version: parsed.version,
      causationId: parsed.causationId,
      correlationId: parsed.correlationId,
      source: mapEventSource(parsed.source),
    });
    const eventRecord = EventRecordSchema.parse(record);
    await publishDomainEvent(eventRecord);
    return eventRecord;
  }

  async appendBatch(inputs: AppendEventBatchInput): Promise<EventRecord[]> {
    const parsedInputs = AppendEventBatchInputSchema.parse(inputs);
    const records = await this.repo.appendBatch(
      parsedInputs.map((parsed) => ({
        aggregateId: parsed.aggregateId,
        aggregateType: aggregateTypeMap[parsed.aggregateType],
        eventType: parsed.eventType,
        userId: parsed.userId,
        data: parsed.data,
        metadata: parsed.metadata,
        version: parsed.version,
        causationId: parsed.causationId,
        correlationId: parsed.correlationId,
        source: mapEventSource(parsed.source),
      }))
    );
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


