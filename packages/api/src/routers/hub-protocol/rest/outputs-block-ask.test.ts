/**
 * The Hub `POST /focus-sessions/:id/outputs/block` door parses a slot's `ask`
 * with the ONE ask schema (`AskSchema`, via the slot wire), exactly as its tRPC
 * twin `focusSessions.blockOutput` does.
 *
 * `blockExpectedOutput` stores the ask as given — it trusts the door to have
 * parsed it. The Hub door used `z.custom<Ask>()`, which checks nothing, so an
 * unknown mode or a `javascript:` act url reached storage through it while the
 * tRPC door refused both.
 *
 * Driven through the real route; the service is a probe that records what it
 * was handed, so a refusal is "never reached", not a status code alone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({ asks: [] as unknown[] }));

vi.mock("../../../services/capture-agent/resolve-capture-actor.js", () => ({
  resolveCaptureActorUserId: async () => undefined,
}));
vi.mock("../../../services/focus-sessions/block-output.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  blockExpectedOutput: async (args: {
    ask?: unknown;
    expectedLabel: string;
  }) => {
    h.asks.push(args.ask);
    return { status: "ok", expectedLabel: args.expectedLabel, kind: "note" };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");
const { expectedOutputWireSchema } =
  await import("../../../services/focus-sessions/update-session.js");

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", ME);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

function block(ask: unknown) {
  return app().request(`/focus-sessions/${ID}/outputs/block`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedLabel: "Signed contract",
      blockedReason: "decision",
      ask,
    }),
  });
}

/** Asks `z.custom<Ask>()` let through and `AskSchema` refuses. */
const INVALID: Record<string, unknown> = {
  "an unknown mode": { mode: "vote", prompt: "Pick one" },
  "a javascript: act url": {
    mode: "act",
    prompt: "Open it",
    url: "javascript:alert(1)",
  },
  "a choose with no options": { mode: "choose", options: [] },
  "not an object": "confirm",
};

const VALID: Record<string, unknown> = {
  "a confirm": { mode: "confirm", prompt: "Send the invoice?" },
  "an act at an https url": {
    mode: "act",
    prompt: "Sign it",
    url: "https://example.com/sign",
  },
};

beforeEach(() => {
  h.asks.length = 0;
  vi.spyOn(db.query.focusSessions, "findFirst").mockResolvedValue({
    id: ID,
    userId: ME,
    workspaceId: null,
  } as never);
});
afterEach(() => vi.restoreAllMocks());

describe("Hub outputs/block parses `ask` with AskSchema", () => {
  it("the fixtures discriminate: the slot wire refuses every INVALID ask and takes every VALID one", () => {
    const wire = expectedOutputWireSchema.shape.ask;
    for (const ask of Object.values(INVALID)) {
      expect(wire.safeParse(ask).success).toBe(false);
    }
    for (const ask of Object.values(VALID)) {
      expect(wire.safeParse(ask).success).toBe(true);
    }
  });

  for (const [name, ask] of Object.entries(INVALID)) {
    it(`refuses ${name} with 400, and the service is never reached`, async () => {
      const res = await block(ask);
      expect(res.status).toBe(400);
      expect(h.asks).toEqual([]);
    });
  }

  for (const [name, ask] of Object.entries(VALID)) {
    it(`hands ${name} to the service as parsed`, async () => {
      const res = await block(ask);
      expect(res.status).toBe(200);
      expect(h.asks).toEqual([expectedOutputWireSchema.shape.ask.parse(ask)]);
    });
  }

  it("still clears with null and leaves alone when omitted", async () => {
    expect((await block(null)).status).toBe(200);
    expect((await block(undefined)).status).toBe(200);
    expect(h.asks).toEqual([null, undefined]);
  });
});
