/**
 * Contract test — POST /api/hub/connectors/tool-execute threads `sessionId`.
 *
 * Why this exists: `proposals.session_id` (migration 0119) was added expressly
 * to replace fragile correlationId text-matching, yet on the live pod all 45
 * pending `capability/run` proposals carried session_id NULL. The context was
 * present in the IS agent turn and `triggerProviderAction` already declared
 * `sessionId?` — this HTTP door in between simply never forwarded it.
 *
 * These tests pin the seam: what the door ACCEPTS and what it HANDS to
 * `triggerProviderAction`. No database and no real dispatcher.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const USER = "user-1";
const SESSION = "5f3a1c88-1111-4bbb-8ccc-222222222222";

const calls: any[] = [];

vi.mock("../../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: async (input: any) => {
    calls.push(input);
    return { success: true, status: 200, headers: {}, body: { ok: true } };
  },
}));

// Only the two sibling imports this route file pulls in beyond the dispatcher.
vi.mock("../../../connectors/materialize-tools.js", () => ({
  materializeConnectorTools: async () => ({}),
}));
vi.mock("../../../services/capabilities/capability-nango-sync.js", () => ({
  detachNangoConnectionRegistry: async () => {},
}));

const { registerConnectorsRoutes } = await import("./connectors.js");

function buildApp(ctxSessionId?: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    c.set("userId" as never, USER as never);
    // The VERIFIED X-Session-Id the hub middleware resolves once per request.
    if (ctxSessionId) c.set("sessionId" as never, ctxSessionId as never);
    await next();
  });
  registerConnectorsRoutes(app as never);
  return app;
}

async function post(body: Record<string, unknown>, ctxSessionId?: string) {
  return buildApp(ctxSessionId).request("/connectors/tool-execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE = {
  provider: "nango://gmail",
  method: "POST",
  path: "/gmail/v1/messages/send",
  workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

describe("POST /connectors/tool-execute — session provenance", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("forwards a supplied sessionId to triggerProviderAction", async () => {
    const res = await post({ ...BASE, sessionId: SESSION });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe(SESSION);
  });

  it("passes sessionId: null when the caller has no session (never invents one)", async () => {
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    // Explicitly null — NOT undefined-by-omission, and NOT a synthesised id.
    expect(calls[0].sessionId).toBeNull();
  });

  it("falls back to the middleware-verified X-Session-Id when the body omits it", async () => {
    // Same precedence the canonical proposals door uses: body > verified
    // header > null.
    const res = await post(BASE, SESSION);
    expect(res.status).toBe(200);
    expect(calls[0].sessionId).toBe(SESSION);
  });

  it("does not disturb the other forwarded fields", async () => {
    await post({ ...BASE, accountHint: "work", sessionId: SESSION });
    expect(calls[0]).toMatchObject({
      userId: USER,
      provider: BASE.provider,
      method: "POST",
      path: BASE.path,
      accountHint: "work",
      workspaceId: BASE.workspaceId,
    });
  });
});
