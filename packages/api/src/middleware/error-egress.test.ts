/**
 * 5xx error-egress sanitizer — regression proofs for the production leak where
 * `GET /api/hub/entities/<truncated-id>` returned a 500 whose body was the
 * whole Drizzle `Failed query: <sql>\nparams: <params>` string: the entities
 * column list, the full access-control predicate, and the caller's user UUID.
 *
 * No Postgres and no app bootstrap needed — the middleware is pure Hono.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { sanitizeErrorEgress } from "./error-egress.js";

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
