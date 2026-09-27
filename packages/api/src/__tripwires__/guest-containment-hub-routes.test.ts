/**
 * TRIPWIRE — a GUEST principal is refused on EVERY authenticated Hub REST
 * route, whatever the method, and on MCP.
 *
 * The hub serves agents, the IS and tooling. A guest (a guest project role and
 * no pod participation) reads what an owner shared through the app's floors;
 * none of the ~50 hub sub-routers were built with guests in mind, and a Kratos
 * session token alone reaches them (`X-Session-Token`). So the refusal sits in
 * `hubAuthMiddleware`, on the FINAL principal of both credential paths.
 *
 * DERIVED, BEHAVIOURAL: every route is read from the served app
 * (`hubProtocolRestApp.routes`) and REQUESTED with a guest credential. Stubbed:
 * the key lookup (`apiKeyService`), the key→principal remap
 * (`resolveKeyIdentity`) and the audience probe
 * (`AccessContext.prototype.audience` → "guest"). The refusal happens inside
 * auth, so no route handler runs. A route that answers a guest with anything
 * but the refusal must ALSO answer an anonymous caller without a 401: it is a
 * credential-less door, and a guest credential buys nothing there.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const GUEST = "0b9d6f3e-1c2a-4e5f-8a7b-9c0d1e2f3a4b";

vi.mock("../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: vi.fn(async () => ({
      status: "valid",
      record: {
        id: "key-guest",
        userId: GUEST,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        expiresAt: null,
        keyType: "user_pat",
        workspaceId: null,
        linkedUserId: null,
        parentKeyId: null,
      },
    })),
    validateApiKey: vi.fn(async () => ({
      id: "key-guest",
      userId: GUEST,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType: "user_pat",
      workspaceId: null,
      linkedUserId: null,
    })),
    recordKeyUse: vi.fn(),
    checkRateLimit: vi.fn(() => true),
  },
}));
vi.mock("../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: GUEST,
    agentUserId: undefined,
    isAgent: false,
  })),
}));
vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: vi.fn(async () => ({ identity: { id: GUEST } })),
}));

import { Hono } from "hono";
import { hubProtocolRestApp } from "../routers/hub-protocol-rest.js";
import { mcpHttpApp } from "../routers/mcp/http-handler.js";
import { AccessContext } from "../access/context.js";
import { GUEST_REFUSED_MESSAGE } from "../access/guest-containment.js";

const ID = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
const server = new Hono().route("/api/hub", hubProtocolRestApp);

type Route = { method: string; path: string };
const routes: Route[] = (hubProtocolRestApp.routes as Route[])
  .filter((r) => !(r.method === "ALL" && (r.path === "/*" || r.path === "*")))
  .map((r) => ({
    method: r.method === "ALL" ? "GET" : r.method,
    path: r.path,
  }));
const unique = [
  ...new Map(routes.map((r) => [`${r.method} ${r.path}`, r])).values(),
];

function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, ID).replace(/\*/g, "x");
}

async function request(
  route: Route,
  headers: Record<string, string>
): Promise<Response> {
  return server.request(`/api/hub${concrete(route.path)}`, {
    method: route.method,
    headers: { "content-type": "application/json", ...headers },
    body: route.method === "GET" || route.method === "HEAD" ? undefined : "{}",
  });
}

async function isGuestRefusal(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return body?.error === GUEST_REFUSED_MESSAGE;
}

let audienceSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  audienceSpy = vi
    .spyOn(AccessContext.prototype, "audience")
    .mockResolvedValue("guest");
});
afterAll(() => audienceSpy.mockRestore());

describe("tripwire: guest containment covers every Hub REST route and MCP", () => {
  it("the scan sees the served hub routes (non-vacuity)", () => {
    // Measured 2026-09-27: several hundred method+path pairs.
    expect(unique.length).toBeGreaterThan(200);
    const keys = unique.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain("POST /workspaces/enroll-agent");
    expect(keys).toContain("GET /users/me");
    expect(keys.some((k) => k.startsWith("GET /entities"))).toBe(true);
  });

  it("every route refuses a guest API key, or is a credential-less door", async () => {
    const leaked: string[] = [];
    let refused = 0;
    for (const route of unique) {
      const res = await request(route, {
        authorization: "Bearer synap_guest_key_for_test",
      });
      if (await isGuestRefusal(res)) {
        refused++;
        continue;
      }
      // Not refused: only acceptable on a door that runs its OWN credential
      // check (or none) and ignores the hub credential — the guest's answer
      // must then be exactly an anonymous caller's.
      const anon = await request(route, {});
      if (anon.status !== res.status) {
        leaked.push(
          `${route.method} ${route.path} → guest ${res.status} / anonymous ${anon.status}`
        );
      }
    }
    expect(leaked).toEqual([]);
    // Most of the surface is authenticated; a refusal count near zero means the
    // guard stopped firing, not that the surface became public.
    expect(refused).toBeGreaterThan(200);
  });

  it("a guest Kratos session token is refused too (reads included)", async () => {
    for (const route of [
      { method: "GET", path: "/entities" },
      { method: "POST", path: "/workspaces" },
    ]) {
      const res = await request(route, { "x-session-token": "kratos-guest" });
      expect(await isGuestRefusal(res)).toBe(true);
    }
  });

  it("MCP refuses a guest key before any tool runs", async () => {
    const res = await mcpHttpApp.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synap_guest_key_for_test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      id: unknown;
      error: { message: string };
    };
    expect(body.id).toBe(7);
    expect(body.error.message).toBe(GUEST_REFUSED_MESSAGE);
  });
});
