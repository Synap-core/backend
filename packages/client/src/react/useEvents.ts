/**
 * useEvents Hook
 * 
 * Fetches events from Data Pod via tRPC
 */

import { useSynap } from './provider.js';

export interface UseEventsOptions {
  days?: number;
  limit?: number;
  eventTypes?: string[];
}

/**
 * Fetch user's event stream
 */
export function useEvents(options: UseEventsOptions = {}): any {
  const { api } = useSynap();
  return api.events.list.useQuery({
    limit: options.limit || 100,
    type: options.eventTypes ? options.eventTypes[0] : undefined,
  });
}

/**
 * Fetch events for specific aggregate
 */
export function useAggregateEvents(_aggregateId: string, _options: { fromVersion?: number; toVersion?: number } = {}): any {
  const { api } = useSynap();
  // V1.0 API adjustment: aggregateStream not currently exposed in events router
  // Falling back to simple list filtered by type if provided, or empty for now
  // TODO: Implement aggregate stream in API
  return api.events.list.useQuery({
    limit: 100,
  }, {
    enabled: false, // Disabled until API support
  });
}
