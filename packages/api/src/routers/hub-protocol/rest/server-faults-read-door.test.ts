/**
 * The server-fault read door's floor (0392): pod owner or admin only — Hub
 * `GET /api/hub/errors/:errorId`. A non-admin is
 * REFUSED (403, with the reason), never shown an empty answer or a 404 that
 * would tell them whether an errorId exists; an admin reads the stored cause;
 * an id with nothing stored is a 404 that says faults are kept 30 days. The
 * pod-admin check and the row read are stubbed at their module boundary (the
 * table itself: database `server-faults.pglite.test.ts`).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ERROR_ID = "a74f6adc-012e-4ef3-bf9f-26ac16da8746";

const h = vi.hoisted(() => ({
  admin: false,
  reads: [] as string[],
}));

vi.mock("../../../utils/workspace-role.js", async (orig) => ({
  ...(await orig<typeof import("../../../utils/workspace-role.js")>()),
  isPodAdmin: async () => h.admin,
}));

vi.mock("@synap/database", async (orig) => ({
  ...(await orig<typeof import("@synap/database")>()),
  readServerFault: async (_db: unknown, errorId: string) => {
    h.reads.push(errorId);
    return errorId === ERROR_ID
      ? {
          errorId,
          occurredAt: new Date("2026-11-02T17:14:27.499Z"),
          door: "rest",
          method: "POST",
          path: "/api/hub/packages/apply",
          status: 500,
          userId: "u1",
          agentUserId: null,
          errorName: "ZodError",
          message: "Too big: expected string to have <=5000 characters",
          stack: "ZodError: …",
          causes: [],
        }
      : null;
  },
}));

import { registerDiagnoseRoutes } from "./diagnose.js";
import type { HubHono, HubVariables } from "./_shared.js";
import { SERVER_FAULTS_FORBIDDEN_MESSAGE } from "../../../services/server-faults/read.js";

const USER = "11111111-1111-4111-8111-111111111111";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read"]);
    c.set("userId", USER);
    await next();
  });
  registerDiagnoseRoutes(app);
  return app;
}

beforeEach(() => {
  h.admin = false;
  h.reads = [];
});

describe("GET /errors/:errorId", () => {
  it("refuses a caller who is not a pod admin (403, the reason), and reads nothing", async () => {
    const res = await buildApp().request(`/errors/${ERROR_ID}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      SERVER_FAULTS_FORBIDDEN_MESSAGE
    );
    expect(h.reads).toHaveLength(0);
  });

  it("returns the stored cause to a pod admin", async () => {
    h.admin = true;
    const res = await buildApp().request(`/errors/${ERROR_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      errorId: ERROR_ID,
      errorName: "ZodError",
      message: "Too big: expected string to have <=5000 characters",
      path: "/api/hub/packages/apply",
    });
    expect(h.reads).toEqual([ERROR_ID]);
  });

  it("an id with nothing stored is a 404 that says how long faults are kept", async () => {
    h.admin = true;
    const res = await buildApp().request("/errors/nothing-here");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/30 days/);
  });
});
