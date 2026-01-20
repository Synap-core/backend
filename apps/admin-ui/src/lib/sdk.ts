/**
 * SDK Configuration
 *
 * Note: @synap/client package was removed. Admin UI needs refactoring to use tRPC client directly.
 * This file is temporarily disabled to allow builds to complete.
 */

// import { createSynapClient } from '@synap/client'; // Package removed

// const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'; // Unused

/**
 * Placeholder SDK - Admin UI needs refactoring
 * TODO: Implement tRPC client for admin UI
 */
export const sdk = {
  system: {
    getCapabilities: { query: async () => ({ workers: [] }) },
    getDashboardMetrics: { query: async () => ({}) },
    searchEvents: { query: async () => [] },
    getTrace: { query: async () => [] },
    getEventTrace: { query: async () => null },
    publishEvent: { mutate: async () => ({}) },
    getDatabaseTables: { query: async () => [] },
    getDatabaseTableRows: { query: async () => ({ rows: [], total: 0 }) },
  },
  webhooks: {
    list: { query: async () => [] },
    create: { mutate: async () => ({}) },
    delete: { mutate: async () => ({}) },
  },
} as any;

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

    getTrace: (correlationId: string) =>
      sdk.system.getTrace.query({ correlationId }),
    getDetails: (eventId: string) =>
      sdk.system.getEventTrace.query({ eventId }),

    publish: (params: {
      type: string;
      data: Record<string, unknown>;
      userId?: string;
      source?: "system" | "api" | "automation";
    }) =>
      sdk.system.publishEvent.mutate({
        ...params,
        userId: params.userId || "admin-ui",
      }),
  },

  /**
   * Worker Management
   */
  workers: {
    list: async () => {
      const caps = await sdk.system.getCapabilities.query();
      return caps.workers || [];
    },
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
  },
};
