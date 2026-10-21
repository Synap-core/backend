/**
 * Hub `POST /focus-sessions/:id/outputs/block` parses `ask` with the ONE ask
 * schema (`AskSchema`, through `expectedOutputWireSchema.shape.ask`), like the
 * tRPC `blockOutput` door. The body schema used to be `z.custom<Ask>()`, which
 * accepts any value: an agent key could store a masked "Re-enter your
 * password" form, or an act url the schema refuses, on a slot the person's
 * clients render as is. Driven through the real route; the service is the
 * observed seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  blocked: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/focus-sessions/block-output.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  blockExpectedOutput: async (args: Record<string, unknown>) => {
    h.blocked.push(args);
    return {
      status: "blocked",
      expectedLabel: args.expectedLabel,
      kind: "entity",
    };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("agentUserId", AGENT_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const block = (ask: unknown) =>
  app().request(`/focus-sessions/${SESSION_ID}/outputs/block`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expectedLabel: "Stripe key",
      blockedReason: "decision",
      ask,
    }),
  });

describe("Hub block door — the ask goes through AskSchema", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.blocked = [];
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        status: "active",
        expectedOutputs: [],
        metadata: {},
      } as never);
  });
  afterEach(() => {
    findFirstSpy.mockRestore();
  });

  it("drops a password field from a form ask before it reaches the slot", async () => {
    const res = await block({
      mode: "form",
      form: {
        fields: [
          { key: "account", label: "Account", type: "text" },
          {
            key: "confirm",
            label: "Re-enter your Synap password",
            type: "password",
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const ask = h.blocked.at(-1)!.ask as {
      mode: string;
      form: { fields: Array<{ key: string }> };
    };
    expect(ask.mode).toBe("form");
    expect(ask.form.fields.map((f) => f.key)).toEqual(["account"]);
  });

  it("refuses a form whose only field is a credential, with nothing stored", async () => {
    const res = await block({
      mode: "form",
      form: {
        fields: [{ key: "pw", label: "Password", type: "password" }],
      },
    });
    expect(res.status).toBe(400);
    expect(h.blocked).toHaveLength(0);
  });

  it("refuses a javascript: act url, with nothing stored", async () => {
    const res = await block({ mode: "act", url: "javascript:alert(1)" });
    expect(res.status).toBe(400);
    expect(h.blocked).toHaveLength(0);
  });

  it("refuses a mode outside the closed set", async () => {
    const res = await block({ mode: "grade" });
    expect(res.status).toBe(400);
    expect(h.blocked).toHaveLength(0);
  });

  it("keeps a well-formed ask and a null (clear)", async () => {
    const choose = {
      mode: "choose",
      options: [
        { label: "EU", value: "eu", recommended: true },
        { label: "US", value: "us" },
      ],
    };
    expect((await block(choose)).status).toBe(200);
    expect(h.blocked.at(-1)!.ask).toEqual(choose);
    expect((await block(null)).status).toBe(200);
    expect(h.blocked.at(-1)!.ask).toBeNull();
  });
});
