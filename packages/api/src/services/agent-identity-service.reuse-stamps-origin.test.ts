/**
 * `findOrCreateServiceAgentUser` REUSE branch — the going-forward half of 0287.
 *
 * The IS roster sync (`POST /agents/sync`) resolves each persona through this
 * door with `createdVia: "intelligence-service"`. When the (creator × agentType)
 * singleton already existed with NULL `created_via` (a pre-0225 row), reuse
 * returned it untouched — so the pod's own persona kept NULL and read as
 * `external`. The door now stamps a NULL row with the caller's provenance, and
 * never overwrites a recorded one.
 *
 * `@synap/database` is stubbed: we capture the `update(users).set(...)` the
 * reuse branch issues. The guarded WHERE (`created_via IS NULL`) is the DB-side
 * belt; this test pins the application-side decision.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  existing: null as null | Record<string, unknown>,
  sets: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", () => ({
  db: {
    query: { users: { findFirst: vi.fn(async () => h.existing) } },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        h.sets.push(values);
        return { where: async () => undefined };
      },
    }),
    insert: () => {
      throw new Error("reuse branch must not insert");
    },
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
  apiKeys: {},
  proposals: {},
  EventRepository: class {},
  ApiKeyRepository: class {},
  drizzleSql: vi.fn(),
  getRequestClientKey: vi.fn(),
  clientKeyScope: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({ agents: {}, users: {} }));

import { findOrCreateServiceAgentUser } from "./agent-identity-service.js";

const call = (createdVia?: "intelligence-service" | "cli") =>
  findOrCreateServiceAgentUser({
    creatorId: "owner-1",
    agentType: "planner",
    label: "Planner",
    ...(createdVia ? { createdVia } : {}),
  });

beforeEach(() => {
  h.sets = [];
});

describe("findOrCreateServiceAgentUser reuse stamps a NULL origin", () => {
  it("stamps the caller's provenance on a reused NULL row", async () => {
    h.existing = { id: "u-1", email: "e", createdVia: null };
    const res = await call("intelligence-service");
    expect(res.agentUserId).toBe("u-1");
    expect(h.sets).toEqual([{ createdVia: "intelligence-service" }]);
  });

  it("never overwrites a recorded origin", async () => {
    h.existing = { id: "u-2", email: "e", createdVia: "cli" };
    await call("intelligence-service");
    expect(h.sets).toEqual([]);
  });

  it("a caller that names no provenance writes nothing", async () => {
    h.existing = { id: "u-3", email: "e", createdVia: null };
    await call();
    expect(h.sets).toEqual([]);
  });
});
