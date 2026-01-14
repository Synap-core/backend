/**
 * Event Waiter Utility
 * 
 * Polls the events table to wait for specific events to be emitted.
 * Used for testing async validation flows.
 */

import { db, events, eq, and, gte, desc } from "@synap/database";

export interface WaitForEventOptions {
  timeout?: number;
  pollInterval?: number;
  filter?: (event: any) => boolean;
  sinceTimestamp?: Date;
}

export interface WaitForEventsOptions extends WaitForEventOptions {
  count?: number;
}

/**
 * Wait for a single event of a specific type
 */
export async function waitForEvent(
  eventType: string,
  options: WaitForEventOptions = {}
): Promise<any> {
  const {
    timeout = 10000,
    pollInterval = 500,
    filter,
    sinceTimestamp = new Date(Date.now() - 5000), // Look back 5s by default
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Query events table
    const foundEvents = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.type, eventType),
          gte(events.timestamp, sinceTimestamp)
        )
      )
      .orderBy(desc(events.timestamp))
      .limit(10);

    // Apply custom filter if provided
    const matchingEvent = filter
      ? foundEvents.find(filter)
      : foundEvents[0];

    if (matchingEvent) {
      return matchingEvent;
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for event: ${eventType} (waited ${timeout}ms)`
  );
}

/**
 * Wait for multiple events of specific types
 */
export async function waitForEvents(
  eventTypes: string[],
  options: WaitForEventsOptions = {}
): Promise<any[]> {
  const {
    timeout = 10000,
    pollInterval = 500,
    count,
    sinceTimestamp = new Date(Date.now() - 5000),
  } = options;

  const startTime = Date.now();
  const foundEvents: any[] = [];
  const expectedCount = count || eventTypes.length;

  while (Date.now() - startTime < timeout) {
    // Query for all event types
    const allEvents = await db
      .select()
      .from(events)
      .where(gte(events.timestamp, sinceTimestamp))
      .orderBy(desc(events.timestamp))
      .limit(50);

    // Filter to requested types
    const matchingEvents = allEvents.filter((event) =>
      eventTypes.includes(event.type)
    );

    // Check if we have enough
    if (matchingEvents.length >= expectedCount) {
      return matchingEvents.slice(0, expectedCount);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for ${expectedCount} events from types: ${eventTypes.join(", ")} (found ${foundEvents.length}, waited ${timeout}ms)`
  );
}

/**
 * Wait for validation event (either .validated or .denied)
 */
export async function waitForValidation(
  baseEventType: string,
  options: WaitForEventOptions = {}
): Promise<{ status: "validated" | "denied"; event: any }> {
  const validatedType = `${baseEventType}.validated`;
  const deniedType = `${baseEventType}.denied`;

  const startTime = Date.now();
  const timeout = options.timeout || 10000;
  const pollInterval = options.pollInterval || 500;
  const sinceTimestamp = options.sinceTimestamp || new Date(Date.now() - 5000);

  while (Date.now() - startTime < timeout) {
    // Check for both validated and denied
    const foundEvents = await db
      .select()
      .from(events)
      .where(gte(events.timestamp, sinceTimestamp))
      .orderBy(desc(events.timestamp))
      .limit(20);

    const validated = foundEvents.find((e) => e.type === validatedType);
    const denied = foundEvents.find((e) => e.type === deniedType);

    if (validated) {
      return { status: "validated", event: validated };
    }

    if (denied) {
      return { status: "denied", event: denied };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(
    `Timeout waiting for validation of ${baseEventType} (waited ${timeout}ms)`
  );
}

/**
 * Clear old test events (cleanup utility)
 */
export async function clearTestEvents(olderThan: Date = new Date(Date.now() - 60000)) {
  // Note: In production, events are immutable. This is ONLY for tests.
  // Consider using a separate test database or marking test events differently.
  console.warn("clearTestEvents is for testing only - events should be immutable in production");
}
