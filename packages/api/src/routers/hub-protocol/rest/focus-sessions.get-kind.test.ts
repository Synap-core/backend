/**
 * Hub `GET /focus-sessions/:id` carries `kind` (and `triage`) on the FULL path,
 * as the list door and the withheld path already do — it used to spread the raw
 * row, so the same session had a `kind` in the list and none on its own read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../../../services/focus-sessions/continuation-packet.js", () => ({
  projectContinuationPacket: async () => ({
    rerun: null,
    evaluation: { status: "unavailable" },
  }),
}));
vi.mock(
  "../../../services/focus-sessions/session-outputs.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    readSessionOutcomesSection: async () => ({ status: "unavailable" }),
  })
);

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub GET /focus-sessions/:id — kind", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(db.query.focusSessions, "findFirst").mockResolvedValue({
      id: SESSION_ID,
      userId: "user-1",
      title: "A session",
      status: "active",
      origin: "human",
      metadata: {},
    } as never);
  });
  afterEach(() => spy.mockRestore());

  it("the full path carries a kind", async () => {
    const res = await buildTestApp().request(`/focus-sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.kind).toBe("string");
    expect(body).toHaveProperty("triage");
  });
});
