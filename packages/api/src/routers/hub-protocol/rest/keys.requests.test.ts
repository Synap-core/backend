/**
 * Hub Protocol REST — the key-request routes (keys plan Decision 4).
 *
 * The service (`services/key-requests.ts`) is driven end to end in
 * `key-requests.pglite.test.ts`. This file pins what only the ROUTES decide:
 *   - a request is made with a KEY (no `apiKeyId` → 401) and needs
 *     `hub-protocol.write` (403), a list needs `hub-protocol.read`;
 *   - the requester is the ACTING principal (the computer's agent user), the
 *     person is the key's human: a computer files, collects, lists and
 *     revokes as itself, never as its person;
 *   - the one-shot answers (`request_code`, the key) are `no-store`;
 *   - a poll that collects nothing answers 400 with an RFC 8628 error and
 *     its words, and `slow_down` carries the new interval.
 *
 * Isolated app, as `keys.rotate-cli.test.ts`: a stub auth middleware + the
 * keys routes, the service mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./_shared.js", () => ({
  httpStatusForTrpcError: () => 500,
  hasScope: (scopes: string[] | undefined, required: string) =>
    (scopes ?? []).includes(required),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: { generateApiKey: vi.fn(), revokeApiKey: vi.fn() },
}));

const svc = vi.hoisted(() => ({
  createKeyRequest: vi.fn(async (_args: Record<string, unknown>) => ({
    request_code: "rc-0123456789abcdef",
    request_id: "11111111-1111-4111-8111-111111111111",
    review_url:
      "http://localhost:4040/keys/requests/11111111-1111-4111-8111-111111111111",
    expires_in: 900,
    interval: 5,
  })),
  collectKeyRequest: vi.fn(
    async (
      _args: Record<string, unknown>
    ): Promise<
      | { ok: true; body: Record<string, unknown> }
      | { ok: false; error: string; interval?: number }
    > => ({ ok: false, error: "authorization_pending" })
  ),
  listKeyTemplates: vi.fn(async (_person: string) => []),
  listRequestedKeys: vi.fn(async (_requester: string) => []),
  revokeRequestedKey: vi.fn(async (_args: Record<string, unknown>) => ({
    revoked: true,
  })),
}));
vi.mock("../../../services/key-requests.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/key-requests.js")
  >()),
  ...svc,
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerKeysRoutes } from "./keys.js";
import type { HubHono, HubVariables } from "./_shared.js";

const PERSON = "person-1";
const COMPUTER = "computer-agent-1";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const RW = ["hub-protocol.read", "hub-protocol.write"];

/** A computer's key by default: the person owns, the agent acts. */
function app(
  opts: { keyId?: string | null; scopes?: string[]; agent?: string | null } = {}
): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    const keyId = opts.keyId === undefined ? KEY_ID : opts.keyId;
    if (keyId) c.set("apiKeyId", keyId);
    c.set("userId", PERSON);
    c.set("scopes", opts.scopes ?? RW);
    const agent = opts.agent === undefined ? COMPUTER : opts.agent;
    if (agent) c.set("agentUserId", agent);
    return next();
  });
  registerKeysRoutes(a);
  return a;
}

const post = (a: HubHono, path: string, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_URL", "");
  vi.stubEnv("POD_ADMIN_URL", "");
});

describe("POST /keys/requests", () => {
  it("files the request as the computer, for its person; the answer is not cached", async () => {
    const res = await post(app(), "/keys/requests", {
      template: "dev-loop-poster",
      name: "devbox",
      expiresInDays: 30,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ interval: 5, expires_in: 900 });
    expect(svc.createKeyRequest).toHaveBeenCalledTimes(1);
    expect(svc.createKeyRequest.mock.calls[0]![0]).toMatchObject({
      requesterUserId: COMPUTER,
      requesterKeyId: KEY_ID,
      personUserId: PERSON,
      templateId: "dev-loop-poster",
      name: "devbox",
      expiresInDays: 30,
      podAdminOrigin: "http://localhost:4040",
    });
  });

  it("a person's own key files as the person", async () => {
    await post(app({ agent: null }), "/keys/requests", {
      template: "read-only",
    });
    expect(svc.createKeyRequest.mock.calls[0]![0]).toMatchObject({
      requesterUserId: PERSON,
      personUserId: PERSON,
    });
  });

  it("needs a key (401) with hub-protocol.write (403); files nothing otherwise", async () => {
    const noKey = await post(app({ keyId: null }), "/keys/requests", {
      template: "read-only",
    });
    expect(noKey.status).toBe(401);
    const readOnly = await post(
      app({ scopes: ["hub-protocol.read"] }),
      "/keys/requests",
      { template: "read-only" }
    );
    expect(readOnly.status).toBe(403);
    expect(svc.createKeyRequest).not.toHaveBeenCalled();
  });
});

describe("POST /keys/requests/token", () => {
  it("pending → 400 authorization_pending with its words, polled as the computer", async () => {
    const res = await post(app(), "/keys/requests/token", {
      request_code: "rc-0123456789abcdef",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("authorization_pending");
    expect(typeof body.error_description).toBe("string");
    expect(svc.collectKeyRequest.mock.calls[0]![0]).toEqual({
      requestCode: "rc-0123456789abcdef",
      requesterUserId: COMPUTER,
    });
  });

  it("slow_down carries the new interval", async () => {
    svc.collectKeyRequest.mockResolvedValueOnce({
      ok: false,
      error: "slow_down",
      interval: 10,
    });
    const res = await post(app(), "/keys/requests/token", {
      request_code: "rc-0123456789abcdef",
    });
    expect(await res.json()).toMatchObject({
      error: "slow_down",
      interval: 10,
    });
  });

  it("approved → 200 with the key, not cached", async () => {
    svc.collectKeyRequest.mockResolvedValueOnce({
      ok: true,
      body: {
        apiKey: "synap_user_test-plaintext",
        keyId: KEY_ID,
        keyPrefix: "synap_user_",
        name: "devbox",
        scopes: RW,
        expiresAt: null,
      },
    });
    const res = await post(app(), "/keys/requests/token", {
      request_code: "rc-0123456789abcdef",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ keyId: KEY_ID, scopes: RW });
  });

  it("a session (no key) cannot collect", async () => {
    const res = await post(app({ keyId: null }), "/keys/requests/token", {
      request_code: "rc-0123456789abcdef",
    });
    expect(res.status).toBe(401);
    expect(svc.collectKeyRequest).not.toHaveBeenCalled();
  });
});

describe("the keys a computer requested", () => {
  it("lists and revokes as the computer, never as its person", async () => {
    const list = await app().request("/keys/requested");
    expect(list.status).toBe(200);
    expect(svc.listRequestedKeys).toHaveBeenCalledWith(COMPUTER);

    const del = await app().request(`/keys/requested/${KEY_ID}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(svc.revokeRequestedKey.mock.calls[0]![0]).toEqual({
      requesterUserId: COMPUTER,
      keyId: KEY_ID,
      by: COMPUTER,
    });
  });

  it("revoking needs hub-protocol.write; listing needs hub-protocol.read", async () => {
    const del = await app({ scopes: ["hub-protocol.read"] }).request(
      `/keys/requested/${KEY_ID}`,
      { method: "DELETE" }
    );
    expect(del.status).toBe(403);
    const list = await app({ scopes: [] }).request("/keys/requested");
    expect(list.status).toBe(403);
    expect(svc.revokeRequestedKey).not.toHaveBeenCalled();
    expect(svc.listRequestedKeys).not.toHaveBeenCalled();
  });

  it("templates are the person's (their own roles are templates)", async () => {
    const res = await app().request("/keys/templates");
    expect(res.status).toBe(200);
    expect(svc.listKeyTemplates).toHaveBeenCalledWith(PERSON);
  });
});
