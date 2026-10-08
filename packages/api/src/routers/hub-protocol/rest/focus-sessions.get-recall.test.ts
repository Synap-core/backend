/**
 * Hub `GET /focus-sessions/:id` carries `recall` — the SAME projection MCP
 * `synap_get_session` returns (`projectSessionRecall`, session-recall.ts), so
 * the IS (which reads sessions over Hub) sees what the pod recalled from the
 * owner's captures when the session started, or that recall failed.
 *
 * Reachability, not shape: the stored `metadata.recalled` item must ARRIVE on
 * the wire, and a stored `recallError` must arrive as a failure — never as an
 * empty list.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const RECALLED_ID = "22222222-2222-4222-8222-222222222222";

vi.mock(
  "../../../services/focus-sessions/session-outputs.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    readSessionOutcomesSection: async () => ({ status: "unavailable" }),
  })
);
vi.mock("../../../services/focus-sessions/continuation-packet.js", () => ({
  projectContinuationPacket: async () => ({
    rerun: null,
    evaluation: { status: "unavailable" },
  }),
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

function withMetadata(metadata: Record<string, unknown>) {
  return vi.spyOn(db.query.focusSessions, "findFirst").mockResolvedValue({
    id: SESSION_ID,
    userId: USER_ID,
    title: "DJ set tonight",
    status: "active",
    metadata,
  } as never);
}

describe("Hub GET /focus-sessions/:id — recall", () => {
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => spy?.mockRestore());

  it("returns the recalled captures stored on the session", async () => {
    spy = withMetadata({
      recalledAt: "2026-10-08T00:00:00.000Z",
      recalled: [
        {
          entityId: RECALLED_ID,
          title: "These two tracks match",
          kind: "note",
          score: 0.71,
          reason: "mentions both tracks",
          recalledAt: "2026-10-08T00:00:00.000Z",
        },
      ],
    });
    const res = await buildTestApp().request(`/focus-sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recall?: { status?: string } };
    expect(body.recall?.status).toBe("ok");
    expect(JSON.stringify(body.recall)).toContain(RECALLED_ID);
  });

  it("reports a failed recall as a failure, not as an empty list", async () => {
    spy = withMetadata({
      recalledAt: "2026-10-08T00:00:00.000Z",
      recallError: { message: "search unavailable" },
    });
    const res = await buildTestApp().request(`/focus-sessions/${SESSION_ID}`);
    const body = (await res.json()) as { recall?: Record<string, unknown> };
    expect(body.recall?.status).toBe("failed");
    expect(body.recall?.error).toBe("search unavailable");
  });
});
