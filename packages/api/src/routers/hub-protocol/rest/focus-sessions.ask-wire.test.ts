/**
 * Hub REST — the typed `ask` / answer `value` are parsed with the ONE schema
 * (`@synap-core/types/ask`), and that is what keeps `/openapi.json` alive.
 *
 * The defect this pins: the block / answer bodies and the session wire schema
 * (`expectedOutputWireSchema`, behind POST/PATCH `/focus-sessions`) declared
 * `ask`, `answer.value` and `answer.askSnapshot` as `z.custom<T>()`. Two
 * consequences, one per describe below:
 *
 *   1. zod-to-openapi cannot express `z.custom`, and one unexpressible schema
 *      anywhere in the registry throws for the WHOLE document — so
 *      `GET /api/hub/openapi.json` answered 500 for every agent reading it.
 *   2. `z.custom<T>()` with no predicate accepts ANY value: the Hub doors did
 *      no validation of `ask` / `value`, while the tRPC answer door
 *      (`AskAnswerValueSchema`) and MCP (`AskSchema.safeParse`) did — and
 *      `parseDeclaredAsk`'s docblock promises "the authoring doors REFUSE an
 *      invalid ask".
 *
 * Driven through the REAL route handlers and the REAL schemas: the document is
 * generated from the real hub app (`hubProtocolRestApp`, every route file
 * registered), and the 400s come from the real `registerFocusSessionsRoutes`.
 * Each refusal is paired with a positive control that sends the same body with
 * a VALID ask/value and watches it get PAST the parse (the row lookup / the
 * service runs), so a 400 cannot be passing for an unrelated reason.
 *
 * NOT covered: whether every registered operation is individually correct —
 * only that the document generates and names these four operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";

const answerSlot = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../services/focus-sessions/session-answer.js", async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // Recorded, then refused as not-found: the door's own mapping answers 404,
    // which is distinguishable from the parse's 400.
    answerSessionSlot: async (input: Record<string, unknown>) => {
      answerSlot.calls.push(input);
      return { status: "not_found" };
    },
  };
});

import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import { hubProtocolRestApp } from "../../hub-protocol-rest.js";
import type { HubHono, HubVariables } from "./_shared.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

const post = (app: HubHono, path: string, body: unknown, method = "POST") =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /openapi.json — the hub spec generates", () => {
  it("answers 200 with the block / answer / create / patch operations in it", async () => {
    const res = await hubProtocolRestApp.request("/openapi.json");
    // On failure the body names the unexpressible schema — surface it.
    expect(res.status, await res.clone().text()).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    // Non-vacuity: the whole hub registry, not an empty shell.
    expect(Object.keys(doc.paths).length).toBeGreaterThan(100);
    // Keys are the Hono form (`:id`), as `registerOpenApi` registers them.
    expect(doc.paths["/focus-sessions/:id/outputs/block"]?.post).toBeDefined();
    expect(doc.paths["/focus-sessions/:id/outputs/answer"]?.post).toBeDefined();
    expect(doc.paths["/focus-sessions"]?.post).toBeDefined();
    expect(doc.paths["/focus-sessions/:id"]?.patch).toBeDefined();
  });

  it("the block body documents `ask` as the ask union, not an empty schema", () => {
    const doc = (
      hubProtocolRestApp as unknown as OpenAPIHono
    ).getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const op = doc.paths?.["/focus-sessions/:id/outputs/block"]?.post as {
      requestBody?: { content?: Record<string, { schema?: unknown }> };
    };
    const schema = JSON.stringify(
      op?.requestBody?.content?.["application/json"]?.schema ?? {}
    );
    // Every ask mode is named in the published body schema.
    for (const mode of ["confirm", "choose", "form", "act", "provide"]) {
      expect(schema, mode).toContain(`"${mode}"`);
    }
  });
});

describe("Hub REST — an invalid ask / value is refused at the door (400)", () => {
  let findFirst: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    answerSlot.calls.length = 0;
    // Reaching the row lookup = the body got PAST the parse. Resolves to no
    // row, which every route here maps to 404.
    findFirst = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockImplementation((async () => undefined) as never);
  });

  afterEach(() => {
    findFirst.mockRestore();
  });

  const INVALID_ASKS: Array<[string, unknown]> = [
    ["an unknown mode", { mode: "telepathy" }],
    ["a choose with no options", { mode: "choose", options: [] }],
    [
      "an act url that is not http(s)",
      { mode: "act", url: "javascript:alert(1)" },
    ],
    ["a string", "pick one"],
  ];

  describe("POST /focus-sessions/:id/outputs/block", () => {
    const block = (ask: unknown) =>
      post(buildTestApp(), `/focus-sessions/${SESSION_ID}/outputs/block`, {
        expectedLabel: "Region",
        blockedReason: "decision",
        ask,
      });

    it.each(INVALID_ASKS)(
      "refuses %s — 400, no row lookup",
      async (_n, ask) => {
        const res = await block(ask);
        expect(res.status).toBe(400);
        const body = (await res.json()) as {
          details?: { fieldErrors?: Record<string, unknown> };
        };
        expect(Object.keys(body.details?.fieldErrors ?? {})).toContain("ask");
        expect(findFirst).not.toHaveBeenCalled();
      }
    );

    it("positive control: a valid ask passes the parse and reaches the lookup", async () => {
      const res = await block({
        mode: "choose",
        options: [{ label: "EU", recommended: true }, { label: "US" }],
      });
      expect(res.status).toBe(404);
      expect(findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /focus-sessions/:id/outputs/answer", () => {
    const answer = (value: unknown) =>
      post(buildTestApp(), `/focus-sessions/${SESSION_ID}/outputs/answer`, {
        expectedLabel: "Region",
        text: "EU",
        value,
      });

    it.each<[string, unknown]>([
      ["an unknown type", { type: "telepathy" }],
      ["a chip with no chip", { type: "chip" }],
      [
        "a provide whose secret ref is not a vault ref",
        {
          type: "provide",
          ref: { kind: "secret", vaultRef: "sk_live_plaintext" },
        },
      ],
    ])("refuses %s — 400, the service never runs", async (_n, value) => {
      const res = await answer(value);
      expect(res.status).toBe(400);
      expect(answerSlot.calls).toHaveLength(0);
    });

    it("positive control: a valid value reaches the service PARSED (credential-keyed form value redacted)", async () => {
      const res = await answer({
        type: "form",
        values: { region: "EU", apiKey: "sk-live-plaintext" },
      });
      expect(res.status).toBe(404);
      expect(answerSlot.calls).toHaveLength(1);
      const value = answerSlot.calls[0]!.value as {
        values: Record<string, unknown>;
      };
      expect(value.values.region).toBe("EU");
      // The schema's transform ran at the door: the plaintext never got past it.
      expect(value.values.apiKey).not.toBe("sk-live-plaintext");
    });
  });

  describe("PATCH /focus-sessions/:id (expectedOutputs[].ask — the shared wire schema)", () => {
    const patch = (ask: unknown) =>
      post(
        buildTestApp(),
        `/focus-sessions/${SESSION_ID}`,
        { expectedOutputs: [{ kind: "decision", label: "Region", ask }] },
        "PATCH"
      );

    it.each(INVALID_ASKS)(
      "refuses %s — 400, no row lookup",
      async (_n, ask) => {
        const res = await patch(ask);
        expect(res.status).toBe(400);
        expect(findFirst).not.toHaveBeenCalled();
      }
    );

    it("positive control: a valid ask passes the parse and reaches the lookup", async () => {
      const res = await patch({ mode: "confirm", prompt: "Ship it?" });
      expect(res.status).toBe(404);
      expect(findFirst).toHaveBeenCalledTimes(1);
    });
  });
});
