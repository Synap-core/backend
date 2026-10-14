/**
 * POST /library/add — nothing an agent sends lands in the Library
 * (CAPTURE_LIBRARY_PLAN §1, founder 2026-10-13). An agent key or the IS's
 * internal key is refused with AGENT_USE_CAPTURE BEFORE the service runs; a
 * person's key reaches the add service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({ added: [] as unknown[] }));

vi.mock("../../../services/library/add.js", () => ({
  addToLibrary: async (args: unknown) => {
    h.added.push(args);
    return { runId: "r", staged: [], refused: [] };
  },
  startKeptItemReads: async () => undefined,
}));

import { registerLibraryRoutes } from "./library.js";

function appAs(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    c.set("userId" as never, "person-1" as never);
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  registerLibraryRoutes(app as never);
  return app;
}

const add = (app: OpenAPIHono) =>
  app.request("/library/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ kind: "url", url: "https://example.com" }],
    }),
  });

beforeEach(() => {
  h.added.length = 0;
});

describe("POST /library/add", () => {
  it("refuses an agent key and points it at synap_capture", async () => {
    const res = await add(appAs({ agentUserId: "agent-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "AGENT_USE_CAPTURE" });
    expect(h.added).toEqual([]);
  });

  it("refuses the IS's internal key", async () => {
    const res = await add(appAs({ keyType: "is_internal" }));
    expect(res.status).toBe(403);
    expect(h.added).toEqual([]);
  });

  it("lets a person keep (never Read now from this door)", async () => {
    const res = await add(appAs({}));
    expect(res.status).toBe(200);
    expect(h.added).toHaveLength(1);
    expect(
      h.added[0] as { userId: string; request: { readNow: boolean } }
    ).toMatchObject({
      userId: "person-1",
      request: { readNow: false },
    });
  });
});
