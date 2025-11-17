import { Inngest } from 'inngest';
import { registerDomainEventPublisher } from '@synap/domain';
import { createLogger, config, ValidationError } from '@synap/core';

const eventLogger = createLogger({ module: 'event-publisher' });

const isProduction = config.server.nodeEnv === 'production';
const resolvedEventKey = config.inngest.eventKey ?? (isProduction ? undefined : 'dev-local-key');
const baseUrl = config.inngest.baseUrl ?? (isProduction ? undefined : 'http://127.0.0.1:8288');

if (!config.inngest.eventKey && !isProduction) {
  eventLogger.warn('INNGEST_EVENT_KEY not provided. Using default "dev-local-key" for local development.');
}

const inngest = new Inngest({
  id: 'synap-api-events',
  eventKey: resolvedEventKey,
  baseUrl,
});

const canPublish = Boolean(resolvedEventKey);
let hasLoggedMissingKey = false;

if (isProduction && !canPublish) {
  throw new ValidationError('INNGEST_EVENT_KEY must be configured in production environments', {
    environment: config.server.nodeEnv,
  });
}

registerDomainEventPublisher(async (event) => {
  if (!canPublish) {
    if (!hasLoggedMissingKey) {
      eventLogger.warn('INNGEST_EVENT_KEY is not set. Domain events will not be published.');
      hasLoggedMissingKey = true;
    }
    return;
  }

  try {
    await inngest.send({
      name: 'api/event.logged',
      data: {
        id: event.id,
        type: event.eventType,
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        userId: event.userId,
        version: event.version,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
        metadata: event.metadata ?? null,
      },
    });
    eventLogger.debug({ eventId: event.id, eventType: event.eventType }, 'Domain event published to Inngest');
  } catch (error) {
    eventLogger.error({ err: error, eventId: event.id }, 'Failed to publish domain event to Inngest');
  }
});


