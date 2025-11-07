import { Inngest } from 'inngest';
import { registerDomainEventPublisher } from '@synap/domain';

const isProduction = process.env.NODE_ENV === 'production';
const resolvedEventKey = process.env.INNGEST_EVENT_KEY ?? (isProduction ? undefined : 'dev-local-key');
const baseUrl = process.env.INNGEST_BASE_URL ?? (isProduction ? undefined : 'http://127.0.0.1:8288');

if (!process.env.INNGEST_EVENT_KEY && !isProduction) {
  console.warn('INNGEST_EVENT_KEY not provided. Using default "dev-local-key" for local development.');
}

const inngest = new Inngest({
  id: 'synap-api-events',
  eventKey: resolvedEventKey,
  baseUrl,
});

const canPublish = Boolean(resolvedEventKey);
let hasLoggedMissingKey = false;

if (isProduction && !canPublish) {
  throw new Error('INNGEST_EVENT_KEY must be configured in production environments.');
}

registerDomainEventPublisher(async (event) => {
  if (!canPublish) {
    if (!hasLoggedMissingKey) {
      console.warn('INNGEST_EVENT_KEY is not set. Domain events will not be published.');
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
  } catch (error) {
    console.error('Failed to publish domain event to Inngest', error);
  }
});


