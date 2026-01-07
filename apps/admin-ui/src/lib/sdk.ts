/**
 * Admin SDK - Wrapper around Synap Client
 * 
 * Provides authenticated access to Synap API for admin dashboard
 */

import { createSynapClient } from '@synap/client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * Singleton SDK instance for Admin UI
 * Gets token from localStorage
 */
export const sdk = createSynapClient({
  url: API_URL,
  headers: (): Record<string, string> => {
    const token = localStorage.getItem('synap_token');
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  },
});

/**
 * Admin SDK Helpers
 * 
 * Specialized helpers for Admin UI pages that wrap SDK calls
 */
export const AdminSDK = {
  /**
   * System Management
   */
  system: {
    getCapabilities: () => sdk.system.getCapabilities.query(),
    getMetrics: () => sdk.system.getDashboardMetrics.query(),
    // getInfo and health don't exist on system router - remove them
  },

  /**
   * Event Store Management
   */
  events: {
    search: (params: {
      limit?: number;
      offset?: number;
      eventType?: string;
      userId?: string;
      correlationId?: string;
      fromDate?: string;
      toDate?: string;
    }) => sdk.system.searchEvents.query(params),

    getTrace: (correlationId: string) => sdk.system.getTrace.query({ correlationId }),
    getDetails: (eventId: string) => sdk.system.getEventTrace.query({ eventId }),

    publish: (params: {
        type: string;
        data: Record<string, unknown>;
        userId?: string;
        source?: 'system' | 'api' | 'automation';
    }) => sdk.system.publishEvent.mutate({
        ...params,
        userId: params.userId || 'admin-ui',
    }),
  },

  /**
   * Worker Management
   */
  workers: {
    list: async () => {
       const caps = await sdk.system.getCapabilities.query();
       return caps.workers || [];
    }
  },

  /**
   * Database
   */
  database: {
     listTables: () => sdk.system.getDatabaseTables.query(),
     getTableData: (tableName: string, offset: number = 0) => 
       sdk.system.getDatabaseTableRows.query({ tableName, offset }),
  },

  /**
   * Webhook Subscriptions
   */
  webhooks: {
    list: () => sdk.webhooks.list.query(),
    create: (input: { name: string; url: string; eventTypes: string[] }) => 
      sdk.webhooks.create.mutate(input),
    delete: (id: string) => sdk.webhooks.delete.mutate({ id }),
  }
};
