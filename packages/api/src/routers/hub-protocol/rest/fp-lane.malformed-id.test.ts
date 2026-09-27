/**
 * Hub REST — `GET /projects/:id` and `GET /workspaces/:workspaceId` refuse a
 * malformed id BEFORE it reaches Postgres.
 *
 * Live evidence 2026-09-27: both routes read `c.req.param(...)` raw and fed
 * it straight into a `uuid` column comparison. Postgres throws
 * `invalid input syntax for type uuid` (22P02) for a non-uuid value, and the
 * route's catch mapped that to 500 — a client typo reported as a server
 * fault. Fix: both now call `requireUuidParam(c, name)` (`_shared.ts`) first.
 *
 * DB-free, same shape as `focus-sessions.malformed-id.test.ts`: an isolated
 * Hono app mounting only the one router under test, with the row lookup
 * spied to throw if it is ever reached for a malformed id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import { registerProjectsRoutes } from "./projects.js";
import { registerWorkspacesRoutes } from "./workspaces.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const MALFORMED = "not-a-uuid";

function buildApp(
  register: (app: HubHono) => void,
  scopes: string[] = ["hub-protocol.write", "hub-protocol.read"]
): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", scopes);
    await next();
  });
  register(app);
  return app;
}

describe("Hub REST — GET /projects/:id refuses a malformed id before the DB", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findFirstSpy = vi
      .spyOn(db.query.projects, "findFirst")
      .mockImplementation(() => {
        throw new Error(
          "db.query.projects.findFirst must not be called for a malformed id"
        );
      });
  });

  afterEach(() => {
    findFirstSpy.mockRestore();
  });

  it("GET /projects/:id — 400, no DB call", async () => {
    const app = buildApp(registerProjectsRoutes);
    const res = await app.request(`/projects/${MALFORMED}`);
    expect(res.status).toBe(400);
    expect(findFirstSpy).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain(MALFORMED);
  });

  it("a well-formed uuid still reaches the DB lookup (unchanged behaviour)", async () => {
    findFirstSpy.mockImplementation(async () => undefined);
    const app = buildApp(registerProjectsRoutes);
    const res = await app.request(
      "/projects/11111111-1111-4111-8111-111111111111"
    );
    expect(findFirstSpy).toHaveBeenCalled();
    expect(res.status).toBe(404);
  });
});

describe("Hub REST — GET /workspaces/:workspaceId refuses a malformed id before the DB", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;
  let membersFindFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findFirstSpy = vi
      .spyOn(db.query.workspaces, "findFirst")
      .mockImplementation(() => {
        throw new Error(
          "db.query.workspaces.findFirst must not be called for a malformed workspaceId"
        );
      });
    membersFindFirstSpy = vi
      .spyOn(db.query.workspaceMembers, "findFirst")
      .mockImplementation(() => {
        throw new Error(
          "db.query.workspaceMembers.findFirst must not be called for a malformed workspaceId"
        );
      });
  });

  afterEach(() => {
    findFirstSpy.mockRestore();
    membersFindFirstSpy.mockRestore();
  });

  it("GET /workspaces/:workspaceId — 400, no DB call", async () => {
    const app = buildApp(registerWorkspacesRoutes);
    const res = await app.request(`/workspaces/${MALFORMED}`);
    expect(res.status).toBe(400);
    expect(findFirstSpy).not.toHaveBeenCalled();
    expect(membersFindFirstSpy).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain(MALFORMED);
  });

  it("GET /workspaces/:workspaceId — missing hub-protocol.read scope still 403s first (unchanged)", async () => {
    const app = buildApp(registerWorkspacesRoutes, []);
    const res = await app.request(`/workspaces/${MALFORMED}`);
    expect(res.status).toBe(403);
    expect(findFirstSpy).not.toHaveBeenCalled();
  });
});
