/**
 * 5xx error-egress sanitizer — regression proofs for the production leak where
 * `GET /api/hub/entities/<truncated-id>` returned a 500 whose body was the
 * whole Drizzle `Failed query: <sql>\nparams: <params>` string: the entities
 * column list, the full access-control predicate, and the caller's user UUID.
 *
 * No Postgres and no app bootstrap needed — the middleware is pure Hono.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// The fault row (`server_faults`), stubbed at the database boundary so this
// stays a pure Hono test: what `insertServerFault` receives is what the table
// stores (the table itself: database `server-faults.pglite.test.ts`).
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {},
  SERVER_FAULT_RETENTION_DAYS: 30,
  insertServerFault: async (_db: unknown, row: Record<string, unknown>) => {
    h.rows.push(row);
  },
  deleteExpiredServerFaults: async () => 0,
}));

const { sanitizeErrorEgress } = await import("./error-egress.js");
const { resetServerFaultBudget } =
  await import("../services/server-faults/record.js");

// The literal shape DrizzleQueryError produces (drizzle-orm/errors.ts):
//   super(`Failed query: ${query}\nparams: ${params}`)
const DRIZZLE_LEAK =
  'Failed query: select "id", "user_id", "workspace_id" from "entities" ' +
  'where ("entities"."id" = $1 and exists (select 1 from "workspace_members" ' +
  'where "user_id" = $2))\nparams: c074e8ac,11111111-2222-3333-4444-555555555555';

const noopLog = { error: () => {} };

function app(isDev: boolean) {
  const a = new Hono();
  a.use("*", sanitizeErrorEgress({ isDev, log: noopLog }));
  // The ~265 hub-REST shape: a RETURNED 500, never thrown, so `app.onError`
  // never sees it.
  a.get("/returned", (c) => c.json({ error: DRIZZLE_LEAK }, 500));
  // The thrown shape, converted by an onError that mimics apps/api's.
  a.get("/thrown", () => {
    throw new Error(DRIZZLE_LEAK);
  });
  a.onError((err, c) =>
    c.json(
      {
        error: "InternalServerError",
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
        context: { originalError: err.message, stack: err.stack },
      },
      500
    )
  );
  a.get("/bad-request", (c) =>
    c.json({ error: "id: must be a full 36-character UUID" }, 400)
  );
  a.get("/validation", (c) =>
    c.json({ error: "ValidationError", context: { field: "email" } }, 400)
  );
  a.get("/sse", (c) =>
    c.body("data: boom\n\n", 500, { "content-type": "text/event-stream" })
  );
  a.get("/trpc/entities.get", (c) =>
    c.json([{ error: { json: { message: DRIZZLE_LEAK } } }], 500)
  );
  a.get("/ok", (c) => c.json({ fine: true }));
  return a;
}

describe("sanitizeErrorEgress (production)", () => {
  const prod = app(false);

  it("redacts a RETURNED 500 carrying the raw Drizzle query + params", async () => {
    const res = await prod.request("/returned");
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).not.toContain("Failed query");
    expect(body).not.toContain("params:");
    expect(body).not.toContain("workspace_members");
    expect(body).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(JSON.parse(body)).toMatchObject({
      error: "ServerError",
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(typeof JSON.parse(body).errorId).toBe("string");
  });

  it("redacts a THROWN 500 whose onError body leaks originalError + stack via context", async () => {
    const res = await prod.request("/thrown");
    const body = await res.text();
    expect(res.status).toBe(500);
    expect(body).not.toContain("Failed query");
    expect(body).not.toContain("context");
    expect(body).not.toContain("stack");
    // The machine-readable code survives — clients branch on it.
    expect(JSON.parse(body).code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("returns an errorId so a user report is traceable to the server log", async () => {
    const a = await prod.request("/returned");
    const b = await prod.request("/returned");
    const [ja, jb] = await Promise.all([a.json(), b.json()]);
    expect(ja.errorId).toBeTruthy();
    expect(ja.errorId).not.toBe(jb.errorId);
  });

  it("leaves 4xx alone — actionable messages and field context must survive", async () => {
    const res = await prod.request("/bad-request");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("must be a full 36-character UUID");

    const v = await prod.request("/validation");
    expect(await v.json()).toMatchObject({ context: { field: "email" } });
  });

  it("leaves non-JSON 5xx bodies alone (SSE streams must not be consumed)", async () => {
    const res = await prod.request("/sse");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("data: boom\n\n");
  });

  it("leaves tRPC 5xx alone — tRPC owns its envelope and masks its own message", async () => {
    const res = await prod.request("/trpc/entities.get");
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("leaves 2xx untouched", async () => {
    expect(await (await prod.request("/ok")).json()).toEqual({ fine: true });
  });
});

describe("sanitizeErrorEgress (development)", () => {
  it("keeps full detail so local debugging is unaffected", async () => {
    const res = await app(true).request("/returned");
    expect(await res.text()).toContain("Failed query");
  });
});

/**
 * The cause is KEPT (founder ask 2026-11-02, errorId a74f6adc): the 5xx log
 * line and the stored fault carry the ORIGINAL error, never the wrapper an
 * `onError` made, under the errorId the client got; the client body still
 * carries no cause, only where a pod admin reads it.
 */
describe("sanitizeErrorEgress keeps the exact cause", () => {
  const ORIGINAL = "Cannot read properties of undefined (reading 'stages')";
  const DRIZZLE =
    'Failed query: insert into "skills" ("name") values ($1)\nparams: sk-live-SECRET';
  const USER = "11111111-1111-4111-8111-111111111111";

  function build(isDev = false) {
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = {
      error: (obj: unknown, msg: string) =>
        lines.push({ obj: obj as Record<string, unknown>, msg }),
    };
    const a = new Hono();
    a.use("*", sanitizeErrorEgress({ isDev, log }));
    a.use("*", async (c, next) => {
      (c.set as (k: string, v: unknown) => void)("userId", USER);
      await next();
    });
    a.post("/api/hub/packages/apply", () => {
      const template = undefined as unknown as { stages: unknown };
      // A real TypeError, thrown the way a handler bug throws it.
      return (template.stages as never)[0];
    });
    a.get("/api/hub/returned", (c) => c.json({ error: DRIZZLE }, 500));
    // apps/api's onError: the WRAPPER `toSynapError` makes, with an errorId.
    a.onError((_err, c) =>
      c.json(
        {
          error: "InternalServerError",
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred",
          errorId: "0b7f0c1e-1111-4222-8333-444455556666",
        },
        500
      )
    );
    return { a, lines };
  }

  /** Let the fire-and-forget write land. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    h.rows.length = 0;
    resetServerFaultBudget();
  });

  it("logs a thrown TypeError's own name, message and stack, not the wrapper", async () => {
    const { a, lines } = build();
    const res = await a.request("/api/hub/packages/apply", { method: "POST" });
    const { errorId } = (await res.json()) as { errorId: string };
    expect(errorId).toBe("0b7f0c1e-1111-4222-8333-444455556666");

    const line = lines.find((l) => l.obj.errorId === errorId);
    const fault = line?.obj.fault as
      { name: string; message: string; stack: string } | undefined;
    expect(fault?.name).toBe("TypeError");
    expect(fault?.message).toBe(ORIGINAL);
    expect(fault?.stack).toMatch(/^TypeError/);
    expect(line!.msg).toContain(ORIGINAL);
  });

  it("stores ONE fault row under the errorId the client got, with the caller", async () => {
    const { a } = build();
    const res = await a.request("/api/hub/packages/apply", { method: "POST" });
    const { errorId } = (await res.json()) as { errorId: string };
    await settle();

    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      errorId,
      door: "rest",
      method: "POST",
      path: "/api/hub/packages/apply",
      status: 500,
      userId: USER,
      errorName: "TypeError",
      message: ORIGINAL,
    });
  });

  it("tells the client nothing of the cause, only where an admin reads it", async () => {
    const { a } = build();
    const res = await a.request("/api/hub/packages/apply", { method: "POST" });
    const raw = await res.text();
    const body = JSON.parse(raw) as Record<string, string>;

    expect(raw).not.toContain("stages");
    expect(raw).not.toContain("TypeError");
    expect(body.message).toBe(
      "An unexpected server error occurred. Quote errorId when reporting it."
    );
    expect(body.causeUrl).toMatch(new RegExp(`/errors/${body.errorId}$`));
  });

  it("stores a RETURNED 5xx (no throw) with its bound params cut", async () => {
    const { a } = build();
    const res = await a.request("/api/hub/returned");
    const raw = await res.text();
    const { errorId } = JSON.parse(raw) as { errorId: string };
    await settle();

    expect(raw).not.toContain("sk-live-SECRET");
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ errorId, door: "rest", status: 500 });
    expect(String(h.rows[0]!.message)).toContain(
      'Failed query: insert into "skills"'
    );
    expect(JSON.stringify(h.rows[0])).not.toContain("sk-live-SECRET");
  });

  it("stores the fault in development too, and leaves the body as it was", async () => {
    const { a } = build(true);
    const res = await a.request("/api/hub/returned");
    expect(await res.text()).toContain("sk-live-SECRET");
    await settle();
    expect(h.rows).toHaveLength(1);
  });
});
