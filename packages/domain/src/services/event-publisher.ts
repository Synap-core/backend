import type { EventRecord } from '../types.js';

export interface DomainEventPublisher {
  (event: EventRecord): Promise<void> | void;
}

let publisher: DomainEventPublisher | null = null;

export const registerDomainEventPublisher = (handler: DomainEventPublisher): void => {
  if (publisher) {
    console.warn('Domain event publisher already registered. Overwriting existing handler.');
  }
  publisher = handler;
};

export const publishDomainEvent = async (event: EventRecord): Promise<void> => {
  if (!publisher) {
    return;
  }

  await publisher(event);
};


