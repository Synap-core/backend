/**
 * EntityUpsertService stamps WHICH connection produced an external link
 * (`nango_connection_id`). Places opens a link only from the caller's own
 * connection, so the stamp is an ownership fact:
 *   - a link the upsert creates carries the connection (else the sentinel);
 *   - a `direct-import` sentinel link is re-stamped when a connection upserts it;
 *   - a link another connection already owns is NEVER re-stamped.
 * DB-free: the service takes its db handle in the constructor, so a fake handle
 * records exactly what would be written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  link: null as null | {
    id: string;
    entityId: string;
    url: string | null;
    nangoConnectionId: string;
  },
  entity: { id: "e-1", type: "event" } as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  resolveIdentity: vi.fn(),
}));

vi.mock("./facet-resolution-service.js", () => ({
  resolveRolePayload: vi.fn(async () => null),
}));

vi.mock("./identity-resolution-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./identity-resolution-service.js")>();
  return {
    ...actual,
    resolveIdentity: h.resolveIdentity,
    registerIdentitySignals: vi.fn(async () => undefined),
  };
});

vi.mock("../utils/materialize-entity.js", () => ({
  materializeEntity: vi.fn(async () => ({ entity: { id: "new-1" } })),
}));

vi.mock("../repositories/facet-repository.js", () => ({
  FacetRepository: class {},
}));

import { EntityUpsertService } from "./entity-upsert-service.js";

const fakeDb = {
  query: {
    entityExternalLinks: { findMany: async () => (h.link ? [h.link] : []) },
    entities: {
      findFirst: async () => h.entity,
      findMany: async () => (h.entity ? [h.entity] : []),
    },
  },
  update: () => ({
    set: (patch: Record<string, unknown>) => ({
      where: async () => {
        h.updates.push(patch);
      },
    }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      onConflictDoNothing: async () => {
        h.inserts.push(v);
      },
    }),
  }),
};

function service() {
  return new EntityUpsertService(fakeDb as never, {} as never);
}

const BASE = {
  profileSlug: "event",
  title: "Acme sync",
  properties: {},
  source: "google",
  externalId: "ev1",
  url: "https://www.google.com/calendar/event?eid=ZXYx",
  signals: [],
  workspaceId: "ws-1",
  userId: "u1",
  provenance: { createdByKind: "system" as const },
};

beforeEach(() => {
  h.link = null;
  h.entity = { id: "e-1", type: "event", userId: "u1" };
  h.updates = [];
  h.inserts = [];
  h.resolveIdentity.mockResolvedValue({ match: null });
});

describe("EntityUpsertService — link connection stamp", () => {
  it("re-stamps a direct-import sentinel link with the upserting connection", async () => {
    h.link = {
      id: "l-1",
      entityId: "e-1",
      url: null,
      nangoConnectionId: "direct-import",
    };
    const res = await service().upsert({ ...BASE, connectionId: "conn-1" });
    expect(res.action).toBe("updated");
    expect(h.updates).toEqual([
      {
        url: "https://www.google.com/calendar/event?eid=ZXYx",
        nangoConnectionId: "conn-1",
      },
    ]);
  });

  it("never re-stamps a link another connection already owns", async () => {
    h.link = {
      id: "l-1",
      entityId: "e-1",
      url: "https://www.google.com/calendar/event?eid=ZXYx",
      nangoConnectionId: "conn-OTHER",
    };
    await service().upsert({ ...BASE, connectionId: "conn-1" });
    expect(h.updates).toEqual([]);
  });

  it("a link it creates carries the connection", async () => {
    const res = await service().upsert({ ...BASE, connectionId: "conn-1" });
    expect(res.action).toBe("created");
    expect(h.inserts).toEqual([
      expect.objectContaining({
        entityId: "new-1",
        provider: "google",
        externalId: "ev1",
        url: "https://www.google.com/calendar/event?eid=ZXYx",
        nangoConnectionId: "conn-1",
      }),
    ]);
  });

  it("a link held by ANOTHER member's entity (same shared event id) is never resolved onto", async () => {
    h.link = {
      id: "l-1",
      entityId: "e-1",
      url: "https://www.google.com/calendar/event?eid=ZXYx",
      nangoConnectionId: "conn-M1",
    };
    h.entity = { id: "e-1", type: "event", userId: "u-M1" };
    const res = await service().upsert({
      ...BASE,
      userId: "u-M2",
      connectionId: "conn-M2",
    });
    expect(res.action).toBe("created");
    expect(res.entity.id).toBe("new-1");
    expect(h.updates).toEqual([]);
  });

  it("a link THIS connection produced resolves even when another user owns the entity (approved import)", async () => {
    h.link = {
      id: "l-1",
      entityId: "e-1",
      url: null,
      nangoConnectionId: "conn-M2",
    };
    h.entity = { id: "e-1", type: "event", userId: "u-approver" };
    const res = await service().upsert({
      ...BASE,
      userId: "u-M2",
      connectionId: "conn-M2",
    });
    expect(res.action).toBe("updated");
    expect(res.entity.id).toBe("e-1");
  });

  it("an external-id identity signal on ANOTHER member's entity is never adopted", async () => {
    h.entity = { id: "e-1", type: "event", userId: "u-M1" };
    h.resolveIdentity.mockImplementation(
      async (
        _db: unknown,
        { signals }: { signals: Array<{ type: string }> }
      ) =>
        signals.some((s) => s.type === "external_id")
          ? { match: "strong", entity: { id: "e-1" } }
          : { match: null }
    );
    const res = await service().upsert({
      ...BASE,
      userId: "u-M2",
      connectionId: "conn-M2",
    });
    expect(res.action).toBe("created");
    expect(res.entity.id).toBe("new-1");
  });

  it("the same external-id signal on the caller's OWN entity is adopted", async () => {
    h.entity = { id: "e-1", type: "event", userId: "u1" };
    h.resolveIdentity.mockImplementation(
      async (
        _db: unknown,
        { signals }: { signals: Array<{ type: string }> }
      ) =>
        signals.some((s) => s.type === "external_id")
          ? { match: "strong", entity: { id: "e-1" } }
          : { match: null }
    );
    const res = await service().upsert({ ...BASE, connectionId: "conn-1" });
    expect(res.action).toBe("matched");
    expect(res.entity.id).toBe("e-1");
  });

  it("person identity (email) still resolves to the one pod-wide subject", async () => {
    h.entity = { id: "p-1", type: "person", userId: "u-M1" };
    h.resolveIdentity.mockImplementation(
      async (
        _db: unknown,
        { signals }: { signals: Array<{ type: string }> }
      ) =>
        signals.some((s) => s.type === "email")
          ? { match: "strong", entity: { id: "p-1" } }
          : { match: null }
    );
    const res = await service().upsert({
      ...BASE,
      profileSlug: "person",
      source: "email",
      externalId: "jelle@acme-corp.io",
      signals: [{ type: "email", value: "jelle@acme-corp.io" }],
      userId: "u-M2",
    });
    expect(res.action).toBe("matched");
    expect(res.entity.id).toBe("p-1");
  });

  it("a non-connection import keeps the direct-import sentinel", async () => {
    await service().upsert({ ...BASE });
    expect(h.inserts[0]).toMatchObject({ nangoConnectionId: "direct-import" });
  });
});
