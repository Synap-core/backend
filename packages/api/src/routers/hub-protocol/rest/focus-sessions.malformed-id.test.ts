/**
 * Hub REST — a malformed `:id`/`:sessionId` never reaches Postgres.
 *
 * `eq(focusSessions.id, id)` casts to a `uuid` column. An unvalidated,
 * malformed id (truncated, non-hex, empty) makes Postgres throw
 * invalid-uuid-syntax, and every route in this file mapped that catch-all to
 * 500 — a client mistake reported as a server fault, and (worse) a caller
 * cannot tell "malformed" from "server broke" apart from "not found".
 *
 * DB-free: an isolated Hono app mounting only `registerFocusSessionsRoutes`,
 * with `db.query.focusSessions.findFirst` spied (not mocked away — same
 * reasoning as `capture.enqueue-corpus.test.ts`: `@synap/database`'s barrel
 * is real and import-safe; a narrow stub of it breaks module load) so the
 * assertion is "the row lookup never ran", not just "the status looked right".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const MALFORMED = "not-a-uuid";
const TRUNCATED = "c074e8ac"; // display-shortened, the shape callers actually paste in

function buildTestApp(
  scopes: string[] = ["hub-protocol.write", "hub-protocol.read"]
): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", scopes);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub REST focus-sessions — malformed id refused before the DB", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockImplementation(() => {
        throw new Error(
          "db.query.focusSessions.findFirst must not be called for a malformed id"
        );
      });
  });

  afterEach(() => {
    findFirstSpy.mockRestore();
  });

  it("GET /focus-sessions/:id — 404, no DB call", async () => {
    const app = buildTestApp();
    const res = await app.request(`/focus-sessions/${MALFORMED}`);
    expect(res.status).toBe(404);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("GET /focus-sessions/:id — a truncated (display-shortened) uuid is refused the same way", async () => {
    const app = buildTestApp();
    const res = await app.request(`/focus-sessions/${TRUNCATED}`);
    expect(res.status).toBe(404);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("PATCH /focus-sessions/:id — 404, no DB call", async () => {
    const app = buildTestApp();
    const res = await app.request(`/focus-sessions/${MALFORMED}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: 50 }),
    });
    expect(res.status).toBe(404);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("POST /focus-sessions/:id/cancel — 404, no DB call", async () => {
    const app = buildTestApp();
    const res = await app.request(`/focus-sessions/${MALFORMED}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });

  it("a well-formed but missing id still answers 404 (unchanged behaviour)", async () => {
    findFirstSpy.mockImplementation(async () => undefined);
    const app = buildTestApp();
    const res = await app.request(
      "/focus-sessions/11111111-1111-4111-8111-111111111111"
    );
    expect(res.status).toBe(404);
  });
});
