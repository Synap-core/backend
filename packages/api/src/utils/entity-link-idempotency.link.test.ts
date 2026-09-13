/**
 * The external-link door writes a mirrored record's source-app url and the
 * connection that produced it (`nango_connection_id` = secrets row id). Places
 * opens a link only from the caller's own connection, so these values are an
 * ownership fact. An op-keyed idempotency key (no link) keeps the sentinel.
 * DB-free: the door takes its database handle as an argument.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as Array<{
    values: Record<string, unknown>;
    conflict: { set: Record<string, unknown> };
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, registerIdentitySignals: vi.fn(async () => undefined) };
});

import { makeExternalLinkIdempotency } from "./entity-link-idempotency.js";

const fakeDb = {
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: async (conflict: {
        set: Record<string, unknown>;
      }) => {
        h.writes.push({ values, conflict });
      },
    }),
  }),
};

function door() {
  return makeExternalLinkIdempotency(fakeDb as never, {
    namespace: "u1:prop-1",
    provider: "import",
    userId: "u1",
  });
}

beforeEach(() => {
  h.writes = [];
});

describe("external-link door — mirrored record link fields", () => {
  it("writes the url and the producing connection for a mirrored record", async () => {
    await door().register("e-1", "google", "ev1", {
      url: "https://www.google.com/calendar/event?eid=ZXYx",
      connectionId: "conn-1",
    });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.values).toMatchObject({
      entityId: "e-1",
      provider: "google",
      externalId: "ev1",
      url: "https://www.google.com/calendar/event?eid=ZXYx",
      nangoConnectionId: "conn-1",
      status: "active",
    });
    // Re-pointing a soft-deleted holder carries the same ownership fields.
    expect(h.writes[0]!.conflict.set).toEqual({
      entityId: "e-1",
      url: "https://www.google.com/calendar/event?eid=ZXYx",
      nangoConnectionId: "conn-1",
    });
  });

  it("an op-keyed idempotency key (no link) keeps the direct-import sentinel and no url", async () => {
    await door().register("e-1", "import", "u1:prop-1:event:ev1");
    expect(h.writes[0]!.values).toMatchObject({
      nangoConnectionId: "direct-import",
    });
    expect(h.writes[0]!.values).not.toHaveProperty("url");
    expect(h.writes[0]!.conflict.set).toEqual({ entityId: "e-1" });
  });

  it("a link without a connection still records the url, with the sentinel owner", async () => {
    await door().register("e-1", "email", "jelle@acme-corp.io", { url: null });
    expect(h.writes[0]!.values).toMatchObject({
      nangoConnectionId: "direct-import",
    });
    expect(h.writes[0]!.values).not.toHaveProperty("url");
  });
});
