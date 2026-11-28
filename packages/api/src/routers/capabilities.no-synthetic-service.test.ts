/**
 * The intelligence-service registry as it is: no synthetic "Synap
 * Intelligence" service.
 *
 * `capabilities.list` used to add a built-in `default` service whenever no
 * registered row had serviceId 'default' (so an empty registry was never
 * visible), `checkHealth('default')` answered healthy without pinging
 * anything, and `hasCapability` answered yes for chat / analysis / commands /
 * proposals / threads on any pod. Each is asserted on the router's output
 * with the registry empty, and with a real 'default' row to show that row is
 * still listed and pinged like any other.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  services: [] as Record<string, unknown>[],
  pings: [] as string[],
  pingOk: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        intelligenceServices: {
          findMany: vi.fn(async () => h.services),
          findFirst: vi.fn(async () => h.services[0]),
        },
      },
      update: vi.fn(() => ({
        set: () => ({ where: async () => [] }),
      })),
    },
  };
});
vi.mock("../utils/intelligence-service-url.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchIntelligenceService: vi.fn(async (url: string) => {
    h.pings.push(url);
    return new Response(null, { status: h.pingOk ? 200 : 503 });
  }),
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => {} }));

import { capabilitiesRouter } from "./capabilities.js";
import type { Context } from "../types/context.js";

const caller = () =>
  capabilitiesRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as unknown as Context);

const DEFAULT_ROW = {
  id: "svc-1",
  serviceId: "default",
  name: "Synap Intelligence (registered)",
  capabilities: ["chat"],
  pricing: "free",
  version: "2",
  webhookUrl: "http://is.internal:3001",
  lastHealthCheck: null,
  lastHealthStatus: null,
};

beforeEach(() => {
  h.services = [];
  h.pings.length = 0;
  h.pingOk = false;
});

describe("capabilities.list", () => {
  it("an empty registry lists no intelligence service", async () => {
    const result = await caller().list();
    expect(result.intelligenceServices).toEqual([]);
  });

  it("a registered 'default' row is listed as it is, once", async () => {
    h.services = [DEFAULT_ROW];
    const result = await caller().list();
    expect(result.intelligenceServices).toHaveLength(1);
    expect(result.intelligenceServices[0]).toMatchObject({
      id: "svc-1",
      serviceId: "default",
      name: "Synap Intelligence (registered)",
    });
  });
});

describe("capabilities.checkHealth('default')", () => {
  it("with no registered row: not healthy, and nothing was pinged", async () => {
    const result = await caller().checkHealth({ serviceId: "default" });
    expect(result.isHealthy).toBe(false);
    expect(h.pings).toEqual([]);
  });

  it("with a registered row: pinged like any service, its answer is the verdict", async () => {
    h.services = [DEFAULT_ROW];
    const down = await caller().checkHealth({ serviceId: "default" });
    expect(h.pings).toEqual(["http://is.internal:3001/health"]);
    expect(down.isHealthy).toBe(false);

    h.pingOk = true;
    const up = await caller().checkHealth({ serviceId: "default" });
    expect(up.isHealthy).toBe(true);
  });
});

describe("capabilities.hasCapability", () => {
  it("no registered service: chat is not available", async () => {
    expect(await caller().hasCapability({ capability: "chat" })).toEqual({
      available: false,
    });
  });

  it("a registered active service that declares it: available", async () => {
    h.services = [DEFAULT_ROW];
    expect(await caller().hasCapability({ capability: "chat" })).toEqual({
      available: true,
    });
    expect(await caller().hasCapability({ capability: "threads" })).toEqual({
      available: false,
    });
  });
});
