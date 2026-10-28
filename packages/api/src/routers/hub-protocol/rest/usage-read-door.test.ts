/**
 * The usage read door's floor (0364): pod owner or admin only, on BOTH doors —
 * Hub `GET /api/hub/usage` and `synap_diagnose` type `usage` (through the REAL
 * `diagnoseRouter`). A non-admin is REFUSED (403 / an error), never shown an
 * empty answer; an admin's query reaches the read with its window, grouping
 * and key filter. The pod-admin check and the SQL read are stubbed at their
 * module boundary (the read itself: api-usage.pglite.test.ts).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  admin: false,
  reads: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../utils/workspace-role.js", async (orig) => ({
  ...(await orig<typeof import("../../../utils/workspace-role.js")>()),
  isPodAdmin: async () => h.admin,
}));

vi.mock("@synap/database", async (orig) => ({
  ...(await orig<typeof import("@synap/database")>()),
  readApiUsage: async (_db: unknown, q: Record<string, unknown>) => {
    h.reads.push(q);
    return {
      since: "2026-10-20T00:00:00.000Z",
      until: "2026-10-27T00:00:00.000Z",
      groupBy: q.groupBy ?? ["client", "rlClass", "outcome"],
      groups: [
        {
          client: "synap-bridge/0.6.0",
          outcome: "429",
          calls: 7,
          heldMs: 0,
          conversations: 2,
        },
      ],
    };
  },
}));

import { registerDiagnoseRoutes } from "./diagnose.js";
import type { HubHono, HubVariables } from "./_shared.js";
import { diagnoseRouter } from "../../../services/diagnose/index.js";
import { USAGE_FORBIDDEN_MESSAGE } from "../../../services/usage/read-usage.js";

const USER = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";

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

describe("GET /usage", () => {
  it("refuses a caller who is not a pod admin (403), and reads nothing", async () => {
    const res = await buildApp().request("/usage");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      USAGE_FORBIDDEN_MESSAGE
    );
    expect(h.reads).toHaveLength(0);
  });

  it("an admin's window, grouping and key reach the read", async () => {
    h.admin = true;
    const res = await buildApp().request(
      `/usage?since=2026-10-20T00:00:00Z&groupBy=client,outcome&apiKeyId=${KEY}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: Array<{ calls: number }> };
    expect(body.groups[0]!.calls).toBe(7);
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]).toMatchObject({
      groupBy: ["client", "outcome"],
      apiKeyId: KEY,
    });
    expect((h.reads[0]!.since as Date).toISOString()).toBe(
      "2026-10-20T00:00:00.000Z"
    );
  });

  it("an unknown groupBy or a bad date is a 400, not an empty answer", async () => {
    h.admin = true;
    expect((await buildApp().request("/usage?groupBy=password")).status).toBe(
      400
    );
    expect((await buildApp().request("/usage?since=yesterday")).status).toBe(
      400
    );
    expect(h.reads).toHaveLength(0);
  });
});

describe("synap_diagnose type usage", () => {
  it("refuses a non-admin with an error, reads nothing", async () => {
    const r = await diagnoseRouter({ userId: USER, type: "usage" });
    expect(r).toEqual({ error: USAGE_FORBIDDEN_MESSAGE });
    expect(h.reads).toHaveLength(0);
  });

  it("an admin gets the class report with the groups", async () => {
    h.admin = true;
    const r = (await diagnoseRouter({
      userId: USER,
      type: "usage",
      groupBy: ["client", "outcome"],
      apiKeyId: KEY,
    })) as {
      mode: string;
      type: string;
      summary: string;
      detail: { groups: unknown[] };
    };
    expect(r.mode).toBe("class");
    expect(r.type).toBe("usage");
    expect(r.detail.groups).toHaveLength(1);
    expect(r.summary).toMatch(/7 calls/);
    expect(r.summary).toMatch(/7 refused/);
    expect(h.reads[0]).toMatchObject({
      apiKeyId: KEY,
      groupBy: ["client", "outcome"],
    });
  });
});
