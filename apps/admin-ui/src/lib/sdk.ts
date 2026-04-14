/**
 * Legacy admin SDK shim — used by a few pages until fully migrated to tRPC hooks.
 */

type QueryFn = (...args: unknown[]) => Promise<unknown>;
type MutateFn = (...args: unknown[]) => Promise<unknown>;

const noopQuery: QueryFn = async () => ({});
const noopListQuery: QueryFn = async () => [];
const noopTableRowsQuery: QueryFn = async () => ({ rows: [], total: 0 });
const noopMutate: MutateFn = async () => ({});

export const sdk = {
  system: {
    getCapabilities: { query: noopQuery },
    getDashboardMetrics: { query: noopQuery },
    searchEvents: { query: noopListQuery },
    getTrace: { query: noopListQuery },
    getEventTrace: { query: noopQuery },
    publishEvent: { mutate: noopMutate },
    getDatabaseTables: { query: noopListQuery },
    getDatabaseTableRows: { query: noopTableRowsQuery },
  },
  webhooks: {
    list: { query: noopListQuery },
    create: { mutate: noopMutate },
    delete: { mutate: noopMutate },
  },
};

export const AdminSDK = {
  system: {
    getCapabilities: () => sdk.system.getCapabilities.query(),
    getMetrics: () => sdk.system.getDashboardMetrics.query(),
  },

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

  workers: {
    list: async () => {
      const caps = (await sdk.system.getCapabilities.query()) as {
        workers?: unknown[];
      };
      return caps.workers ?? [];
    },
  },

  database: {
    listTables: () => sdk.system.getDatabaseTables.query(),
    getTableData: async (tableName: string, offset: number = 0) => {
      const res = (await sdk.system.getDatabaseTableRows.query({
        tableName,
        offset,
      })) as { rows: Record<string, unknown>[]; total: number };
      return res.rows;
    },
  },

  webhooks: {
    list: () => sdk.webhooks.list.query(),
    create: (input: { name: string; url: string; eventTypes: string[] }) =>
      sdk.webhooks.create.mutate(input),
    delete: (id: string) => sdk.webhooks.delete.mutate({ id }),
  },
};
