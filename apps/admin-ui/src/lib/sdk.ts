/**
 * Admin UI SDK
 * 
 * Centralized access to the Synap Backend via @synap/client.
 * This ensures the Admin UI uses the exact same SDK as other clients.
 */

import { SynapClient } from '@synap/client';

// Get API URL from environment
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * Singleton instance of SynapClient
 */
export const sdk = new SynapClient({
  url: API_URL,
  getToken: () => {
    // Current auth implementation for Admin UI
    // In future, this might integrate with an AuthProvider context
    return localStorage.getItem('synap_token');
  },
});

/**
 * Admin SDK Helpers
 * 
 * Specialized helpers for Admin UI pages that wrap SDK calls
 * to provide a cleaner API for UI components.
 */
export const AdminSDK = {
  /**
   * System Management
   */
  system: {
    getCapabilities: () => sdk.rpc.system.getCapabilities.query(),
    getMetrics: () => sdk.rpc.system.getDashboardMetrics.query(),
    getInfo: () => sdk.system.info(),
    health: () => sdk.system.health(),
  },

  /**
   * Event Store Management
   */
  events: {
    // Advanced search for EventsPage (V2)
    search: (params: {
      limit?: number;
      offset?: number;
      eventType?: string;
      userId?: string;
      correlationId?: string;
      fromDate?: string;
      toDate?: string;
    }) => sdk.rpc.system.searchEvents.query(params),

    // Get specific trace for debugging
    getTrace: (correlationId: string) => sdk.rpc.system.getTrace.query({ correlationId }),

    // Get event details + trace by Event ID
    getDetails: (eventId: string) => sdk.rpc.system.getEventTrace.query({ eventId }),

    // Publish event manually (for testing/replay)
    publish: (params: {
        type: string;
        data: Record<string, unknown>;
        userId?: string;
        source?: 'system' | 'api' | 'automation';
    }) => sdk.rpc.system.publishEvent.mutate({
        ...params,
        userId: params.userId || 'admin-ui',
    }),
  },

  /**
   * Worker Management
   * (Currently placeholders until generic worker API is exposed)
   */
  workers: {
    list: async () => {
       // Placeholder: In future phase this will fetch from Inngest API proxy
       const caps = await sdk.rpc.system.getCapabilities.query();
       return caps.workers || [];
    }
  },

  /**
   * Database Logic (via generic entities endpoint if needed)
   * For now, admin can use direct queries if exposed, otherwise this is limited.
   */
  database: {
     listTables: () => sdk.rpc.system.getDatabaseTables.query(),
     getTableData: (tableName: string, offset: number = 0) => sdk.rpc.system.getDatabaseTableRows.query({ tableName, offset }),
     // Placeholder kept for compatibility if used elsewhere, though likely to be removed
     getEntities: (type: string) => sdk.notes.list({ type: type as any }),
  },

  /**
   * Webhook Subscriptions
   */
  webhooks: {
    list: () => sdk.rpc.webhooks.list.query(),
    create: (input: { name: string; url: string; eventTypes: string[] }) => sdk.rpc.webhooks.create.mutate(input),
    delete: (id: string) => sdk.rpc.webhooks.delete.mutate({ id }),
  }
};
