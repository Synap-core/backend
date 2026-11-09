/**
 * `/skills/:id/approve` and `/tools/:id/approve` turn a verb or a tool ON: a
 * sensitive decision (PRESENCE_REQUEST_KINDS `skill`, `tool`). When the
 * procedure refuses it for want of a proof, the Hub answer carries the typed
 * refusal `code`, as POST /proposals/:id/approve does, so a client asks for the
 * proof and retries instead of reading the sentence (review of 6 Nov 2026).
 *
 * The procedures are stubs that refuse the way the gate does; the gate itself
 * is real on PGlite in services/presence/presence.pglite.test.ts.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(
  () => () =>
    Object.assign(
      new Error(
        "Confirm it is you: this needs Face ID, Touch ID or your passkey."
      ),
      { code: "FORBIDDEN", cause: { reasonCode: "PRESENCE_REQUIRED" } }
    )
);

vi.mock("./_shared.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActingContext: async () => ({ ok: true, userId: "human-1" }),
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: async () => ({}),
}));
vi.mock("../../skills.js", () => ({
  skillsRouter: {
    createCaller: () => ({
      setApproved: async () => {
        throw refusal();
      },
    }),
  },
}));
vi.mock("../../tools.js", () => ({
  toolsRouter: {
    createCaller: () => ({
      setApproved: async () => {
        throw refusal();
      },
    }),
  },
}));

const { registerSkillsCrudRoutes } = await import("./skills-crud.js");
const { registerToolsRoutes } = await import("./tools.js");
import type { HubHono, HubVariables } from "./_shared.js";

const ID = "00000000-0000-4000-8000-000000000001";

describe("Hub approve doors carry the presence refusal code", () => {
  it.each([
    { door: "skills", register: registerSkillsCrudRoutes },
    { door: "tools", register: registerToolsRoutes },
  ])("$door: 403 with code PRESENCE_REQUIRED", async ({ door, register }) => {
    const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    app.use("/*", async (c, next) => {
      c.set("userId", "human-1");
      c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
      await next();
    });
    register(app);
    const res = await app.request(`/${door}/${ID}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "PRESENCE_REQUIRED",
      error: expect.stringMatching(/Confirm it is you/),
    });
  });
});
