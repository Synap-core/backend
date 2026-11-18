/**
 * A1 step 1 (plan a640c5bb, 18 Nov 2026), through the REAL hub auth door: a
 * person's app token (`app_person`, "Sign in with Synap") is refused every
 * Hub write still in the unclassified baseline
 * (`access/grant-door-write-baseline.ts`). Such a token acts AS the person,
 * so every owner check behind those handlers passes for it: a connected app
 * with narrow ticks could hard-purge a space (R1 A risk 1).
 *
 * Routes are stubs, so the status is the auth door's verdict alone. Rows rule
 * out: a refusal that ignores the key type (the PAT and agent rows must pass
 * the same routes), one that trusts an unbounded grant (the app token with
 * `*` is still refused), one that refuses classified writes (the approve,
 * cancel and run doors the app SDK calls must pass), and one that ignores
 * the method (a GET of a baselined path passes).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getApiKeyStatus, grant, holder } = vi.hoisted(() => ({
  getApiKeyStatus: vi.fn(),
  grant: { rows: [] as Array<Record<string, unknown>> },
  holder: { userType: "human" as string },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: {
          findFirst: async () => ({ id: "u", userType: holder.userType }),
        },
      },
      // GrantRepository.resolveForKey — the key's live grant rows.
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: async () => grant.rows }),
        }),
      }),
    },
  };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

const { hubAuthMiddleware } = await import("../_middleware/auth.js");
import type { HubHono, HubVariables } from "./_shared.js";

const grantRow = (over: Record<string, unknown>) => ({
  id: "g1",
  permissions: ["*"],
  workspaceIds: null,
  projectIds: null,
  entityIds: null,
  expiresAt: null,
  revokedAt: null,
  clientId: null,
  ...over,
});
const FULL = grantRow({});
// What a connected app usually holds: a few permissions in one space.
const ONE_SPACE = grantRow({
  permissions: ["entity.*.read", "entity.*.create", "proposal.approve"],
  workspaceIds: ["ws-1"],
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Writes still in the baseline: refused to a person's app token. */
const UNCLASSIFIED: Array<[Method, string]> = [
  ["POST", "/workspaces/ws-1/purge"],
  ["POST", "/projects/p-1/purge"],
  ["PATCH", "/workspaces/ws-1"],
  ["DELETE", "/apps/app-1"],
  ["POST", "/import/enqueue-corpus"],
  // The approve tier's one route that reads no key grant.
  ["POST", "/tracks/t-1/criteria/c-1/acceptance"],
];
/** Classified writes (the app SDK's approve, cancel, run) and a read. */
const CLASSIFIED: Array<[Method, string]> = [
  ["POST", "/proposals/p-1/approve"],
  ["POST", "/proposals/p-1/reject"],
  ["POST", "/focus-sessions/s-1/cancel"],
  ["POST", "/focus-sessions/s-1/revert"],
  ["POST", "/playbooks/pb-1/run"],
  ["POST", "/tracks/t-1/participants/pt-1/answer"],
  // The CRM's CSV import: bounded op by op inside the door (c54ff30e).
  ["POST", "/import/analyze"],
  ["POST", "/entities"],
  ["GET", "/entities"],
];

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  for (const [method, path] of [...UNCLASSIFIED, ...CLASSIFIED]) {
    hub.on(method, path, (c) => c.json({ ok: true }));
  }
  const root = new Hono();
  root.route("/api/hub", hub);
  root.route("/api/hub-protocol", hub);
  return root;
}

function asKey(
  keyType: string,
  row: Record<string, unknown>,
  userType: "human" | "agent" = "human"
) {
  grant.rows = [row];
  holder.userType = userType;
  getApiKeyStatus.mockResolvedValue({
    status: "valid",
    record: {
      id: "key-1",
      userId: userType === "agent" ? "agent-1" : "person-1",
      linkedUserId: userType === "agent" ? "person-1" : null,
      parentKeyId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType,
      workspaceId: null,
      expiresAt: null,
    },
  });
}

const send = (method: Method, path: string, mount = "/api/hub") =>
  app().request(`${mount}${path}`, {
    method,
    headers: {
      authorization: "Bearer synap_test",
      "content-type": "application/json",
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });

beforeEach(() => vi.clearAllMocks());

describe("a person's app token on an unclassified write", () => {
  it.each(UNCLASSIFIED)(
    "%s %s → 403 GRANT_DOOR_UNSUPPORTED, both mounts",
    async (method, path) => {
      asKey("app_person", ONE_SPACE);
      for (const mount of ["/api/hub", "/api/hub-protocol"]) {
        const res = await send(method, path, mount);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code?: string; error?: string };
        expect(body.code).toBe("GRANT_DOOR_UNSUPPORTED");
        expect(body.error).toMatch(/app's sign-in/);
      }
    }
  );

  it.each(UNCLASSIFIED)(
    "%s %s → 403 even when its grant is an unbounded `*`",
    async (method, path) => {
      asKey("app_person", FULL);
      expect((await send(method, path)).status).toBe(403);
    }
  );

  it.each(CLASSIFIED)(
    "%s %s → a classified door or a read: it passes",
    async (method, path) => {
      asKey("app_person", ONE_SPACE);
      expect((await send(method, path)).status).toBe(200);
    }
  );

  it("a GET of a baselined write's path is not refused by this rule", async () => {
    asKey("app_person", FULL);
    const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    hub.use("/*", hubAuthMiddleware as never);
    hub.get("/import/enqueue-corpus", (c) => c.json({ ok: true }));
    const root = new Hono();
    root.route("/api/hub", hub);
    const res = await root.request("/api/hub/import/enqueue-corpus", {
      headers: { authorization: "Bearer synap_test" },
    });
    expect(res.status).toBe(200);
  });
});

describe("every other key is unchanged on those writes (step 2 is later)", () => {
  it.each(UNCLASSIFIED)(
    "%s %s → a person's own key (PAT, unbounded) passes",
    async (method, path) => {
      asKey("user_pat", FULL);
      expect((await send(method, path)).status).toBe(200);
    }
  );

  it.each(UNCLASSIFIED)(
    "%s %s → a person's key limited to one space passes the fence (its write meets the gate)",
    async (method, path) => {
      asKey("hub_inbound", ONE_SPACE);
      expect((await send(method, path)).status).toBe(200);
    }
  );

  it.each(UNCLASSIFIED)(
    "%s %s → an agent key passes the fence",
    async (method, path) => {
      asKey("hub_inbound", ONE_SPACE, "agent");
      expect((await send(method, path)).status).toBe(200);
    }
  );
});
