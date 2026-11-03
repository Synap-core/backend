/**
 * Hub REST document reads — who read it, and a binary is never served raw.
 *
 * 3 Nov 2026: stored videos were read again and again through
 * `GET /api/hub/documents/:id`, and the request log named no key, no agent
 * and no client, so nobody could tell which client read them. Each read now
 * logs one line naming the caller; `/raw` refuses a body whose bytes are not
 * text (it was never downloaded) with 409 and the file door.
 *
 * Driven through the real routes; only the tRPC caller is stubbed.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  document: {} as Record<string, unknown>,
  info: [] as Array<[Record<string, unknown>, string]>,
}));

const PG_UUID_RE_FOR_TEST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

vi.mock("./_shared.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: (fields: Record<string, unknown>, msg: string) => {
      h.info.push([fields, msg]);
    },
  },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  errCode: () => undefined,
  httpStatusForTrpcError: () => 500,
  requireUuidParam: (
    c: {
      req: { param: (n: string) => string | undefined };
      json: (b: unknown, s: number) => unknown;
    },
    name: string
  ) => {
    const raw = c.req.param(name) ?? "";
    if (!PG_UUID_RE_FOR_TEST.test(raw)) {
      return c.json({ error: `${name} is not a valid id: ${raw}` }, 400);
    }
    return raw;
  },
  resolveActorId: async () => ({ ok: true }),
  resolveActingContext: async () => ({ ok: true }),
  getCaller: async () => ({
    documents: { getDocument: async () => ({ document: h.document }) },
  }),
}));

vi.mock("../confine-workspace.js", () => ({
  getConfinedWorkspace: (_c: unknown, ws: string | null) => ws,
}));

import { registerDocumentsRoutes } from "./documents.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const DOC = "66666666-6666-4666-8666-666666666666";
const DOOR = "/api/hub/files/77777777-7777-4777-8777-777777777777/url";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read"]);
    c.set("userId", USER);
    c.set("agentUserId", AGENT);
    c.set("apiKeyId", KEY);
    await next();
  });
  registerDocumentsRoutes(app);
  return app;
}

const get = (path: string) =>
  buildApp().request(path, {
    headers: { "user-agent": "synap-cli/9.9.9" },
  });

beforeEach(() => {
  h.info = [];
});

describe("GET /documents/:id — one line naming the reader", () => {
  it("logs the key, the agent, the person, the client, the document and its type", async () => {
    h.document = {
      id: DOC,
      type: "file",
      content: "",
      contentOmitted: "binary",
      fileUrlPath: DOOR,
    };
    const res = await get(`/documents/${DOC}?userId=${USER}`);
    expect(res.status).toBe(200);
    const reads = h.info.filter(([, msg]) => msg === "hub document read");
    expect(reads).toHaveLength(1);
    expect(reads[0]![0]).toEqual({
      documentId: DOC,
      type: "file",
      contentOmitted: "binary",
      apiKeyId: KEY,
      agentUserId: AGENT,
      userId: USER,
      userAgent: "synap-cli/9.9.9",
    });
  });

  it("never logs the content", async () => {
    h.document = { id: DOC, type: "markdown", content: "SECRET PLAN" };
    await get(`/documents/${DOC}?userId=${USER}`);
    expect(JSON.stringify(h.info)).not.toContain("SECRET PLAN");
  });
});

describe("GET /documents/:id/raw — a binary is never served from here", () => {
  it("409 with the file door, after logging the reader", async () => {
    h.document = {
      id: DOC,
      title: "take.mp4",
      type: "file",
      content: "",
      contentOmitted: "binary",
      fileUrlPath: DOOR,
    };
    const res = await get(`/documents/${DOC}/raw?userId=${USER}`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "CONTENT_OMITTED_BINARY",
      contentOmitted: "binary",
      fileUrlPath: DOOR,
    });
    expect(h.info.map(([f]) => f.apiKeyId)).toEqual([KEY]);
  });

  it("a text document is served as before", async () => {
    h.document = {
      id: DOC,
      title: "plan",
      type: "markdown",
      content: "# Plan",
    };
    const res = await get(`/documents/${DOC}/raw?userId=${USER}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# Plan");
  });
});
