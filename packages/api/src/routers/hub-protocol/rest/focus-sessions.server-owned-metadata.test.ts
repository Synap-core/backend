/**
 * Hub `PATCH /focus-sessions/:id` never lets a caller write a server-owned
 * metadata key (`SERVER_OWNED_SESSION_METADATA_KEYS`). An agent key (the
 * update is auto-approved) used to shallow-merge `metadata.provideConnect`
 * into the row: a forged connect intent then answered the person's ask with
 * the next connection they made. Driven through the real route; the gate
 * grants, and the row write is the observed seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { PgDialect } from "drizzle-orm/pg-core";
import { db, type SQL } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  gated: [] as Array<Record<string, unknown>>,
  written: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkPermissionOrPropose: async (p: Record<string, unknown>) => {
    h.gated.push(p);
    return { granted: true };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("agentUserId", AGENT_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const patch = (body: unknown) =>
  app().request(`/focus-sessions/${SESSION_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** The JSON merged into the row's metadata by the write, parsed. */
function mergedMetadata(): Record<string, unknown> | undefined {
  const set = h.written.at(-1);
  if (!set || set.metadata === undefined) return undefined;
  const { params } = new PgDialect().sqlToQuery(set.metadata as SQL);
  const json = params.find(
    (p): p is string => typeof p === "string" && p.startsWith("{")
  );
  return json ? (JSON.parse(json) as Record<string, unknown>) : undefined;
}

const FORGED_INTENT = {
  "stripe key": {
    label: "Stripe key",
    provider: "stripe",
    askFingerprint: "abc",
    startedAt: "2099-01-01T00:00:00.000Z",
  },
};

describe("Hub PATCH — server-owned session metadata is never the caller's", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.gated = [];
    h.written = [];
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        goal: "g",
        status: "active",
        criteria: [],
        expectedOutputs: [],
        metadata: {},
      } as never);
    updateSpy = vi.spyOn(db, "update").mockImplementation((() => ({
      set: (set: Record<string, unknown>) => {
        h.written.push(set);
        return {
          where: () => ({
            returning: async () => {
              throw new Error("stop after the write");
            },
          }),
        };
      },
    })) as never);
  });
  afterEach(() => {
    findFirstSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it("an agent's provideConnect is dropped from the gate data and the write", async () => {
    await patch({
      metadata: { provideConnect: FORGED_INTENT, note: "kept" },
    });
    expect(h.gated).toHaveLength(1);
    expect((h.gated[0]!.data as Record<string, unknown>).metadata).toEqual({
      note: "kept",
    });
    expect(mergedMetadata()).toEqual({ note: "kept" });
  });

  it("every server-owned key is dropped; a bag of only those writes nothing", async () => {
    await patch({
      progress: 10,
      metadata: {
        provideConnect: FORGED_INTENT,
        provideGrants: [],
        governance: { forceProposeWrites: false },
        clientKey: "key:someone-else",
        automationChainContext: { depth: 0 },
      },
    });
    expect(
      (h.gated[0]!.data as Record<string, unknown>).metadata
    ).toBeUndefined();
    expect(h.written.at(-1)).toMatchObject({ progress: 10 });
    expect(h.written.at(-1)!.metadata).toBeUndefined();
  });

  it("the merge happens in SQL, over the row's current metadata", async () => {
    await patch({ metadata: { note: "kept" }, title: "Renamed" });
    const { sql } = new PgDialect().sqlToQuery(
      h.written.at(-1)!.metadata as SQL
    );
    expect(sql).toContain("COALESCE");
    expect(mergedMetadata()).toEqual({ note: "kept", titleSource: "agent" });
  });
});
