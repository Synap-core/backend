/**
 * The frame read door has a budget per caller and surface (security review
 * M4, code-quality S1, architecture S5, 27 Nov 2026): a frame in a loop is
 * answered 429 `FRAME_READ_RATE_LIMITED` past `FRAME_READ_LIMIT`, before
 * anything is loaded or logged.
 *
 * Driven through the REAL Hub route `POST /frame/read` and the REAL tRPC twin
 * `surfaces.frameRead`. Each call asks an op outside the ceiling, so the door
 * answers 400 right after the budget, with no read and no log row: the
 * budget is the only thing these rows measure.
 *
 * Rows, each ruling out a wrong outcome:
 *  - the budget's calls: 400 each (the door ran); the next one: 429 with its
 *    code (rules out "no limit");
 *  - another surface of the same person, and the same surface for another
 *    person: still answered (rules out "one budget for everything", which a
 *    busy bento would hit);
 *  - the tRPC twin past its budget: TOO_MANY_REQUESTS, reasonCode
 *    FRAME_READ_RATE_LIMITED (rules out "only the Hub door is limited").
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => randomUUID() }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerFrameReadRoutes } from "./frame-read.js";
import { surfaceFrameReadRouter } from "../../surface-frame-read.js";
import type { HubHono, HubVariables } from "./_shared.js";

/** `FRAME_READ_LIMIT.max` (stated here so a reverted door fails on 429, not on an import). */
const FRAME_READ_LIMIT = { max: 240 };

const A = randomUUID();
const B = randomUUID();

function read(body: unknown, asUser: string) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", asUser);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFrameReadRoutes(app);
  return app.request("/frame/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ask = (typeKey: string) => ({
  surface: { kind: "cell", typeKey },
  op: "nope.not-an-op",
});

beforeAll(async () => {
  await h.init();
}, 120_000);

describe("the frame read budget", () => {
  it("answers the budget, then 429 FRAME_READ_RATE_LIMITED", async () => {
    for (let i = 0; i < FRAME_READ_LIMIT.max; i += 1) {
      const res = await read(ask("cell:pkg:looping"), A);
      expect(res.status).toBe(400);
    }
    const res = await read(ask("cell:pkg:looping"), A);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "FRAME_READ_RATE_LIMITED" });
  });

  it("another surface of the same person, and the same surface for another person: still answered", async () => {
    expect((await read(ask("cell:pkg:other"), A)).status).toBe(400);
    expect((await read(ask("cell:pkg:looping"), B)).status).toBe(400);
  });

  it("the tRPC twin past its budget: TOO_MANY_REQUESTS, reasonCode FRAME_READ_RATE_LIMITED", async () => {
    const C = randomUUID();
    const caller = surfaceFrameReadRouter.createCaller({
      authenticated: true,
      userId: C,
      workspaceId: null,
    } as never);
    const input = {
      surface: { kind: "cell" as const, typeKey: "cell:pkg:trpc" },
      op: "nope.not-an-op",
    };
    for (let i = 0; i < FRAME_READ_LIMIT.max; i += 1) {
      await expect(caller.frameRead(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    await expect(caller.frameRead(input)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      cause: { reasonCode: "FRAME_READ_RATE_LIMITED" },
    });
  });
});
