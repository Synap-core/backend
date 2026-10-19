/**
 * Webhook management through the REAL hub auth door + the REAL route handlers.
 *
 * A subscription is fanned out by OWNER only (`jobs/src/workers/
 * webhook-worker.ts` `fanOutDomainEvent` matches `webhookSubscriptions.userId`),
 * so one row streams every event of the person — every workspace, every
 * project, every kind — to the URL it names. Two things must therefore hold:
 *
 *  1. Creating or deleting one is a WRITE: it needs `hub-protocol.write`. A
 *     read-only key once created a subscription with no scope check at all.
 *  2. A SCOPED key (any grant short of the explicit full-access `*`) may not
 *     manage webhooks at all: nothing narrows the fan-out to a grant, so a key
 *     limited to one workspace (or one kind, or read-only) would otherwise
 *     receive the whole pod. The W1 door fence (`grant-door-fence.ts`)
 *     answered `true` for every non-read POST and every DELETE ("bounded by
 *     the gate") — but these handlers never pass the gate.
 *
 * Rows rule out: a fix that checks only the scope (fenced+write row), a fix
 * that fences only POST (DELETE rows), a fix that refuses everyone (full-access
 * rows), and a listing that leaks another person's rows (the `where` row).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getApiKeyStatus, insertValues, deleteWhere, listFindMany, grant } =
  vi.hoisted(() => ({
    getApiKeyStatus: vi.fn(),
    insertValues: vi.fn(),
    deleteWhere: vi.fn(),
    listFindMany: vi.fn(),
    grant: { rows: [] as Array<Record<string, unknown>> },
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: async () => ({ id: "u", userType: "agent" }) },
        webhookSubscriptions: { findMany: listFindMany },
      },
      // GrantRepository.resolveForKey — the key's live grant rows.
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: async () => grant.rows }),
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          insertValues(v);
          return {
            returning: async () => [
              {
                id: "00000000-0000-4000-8000-000000000001",
                createdAt: new Date("2026-10-19T00:00:00.000Z"),
                ...v,
              },
            ],
          };
        },
      }),
      delete: () => ({
        where: (w: unknown) => {
          deleteWhere(w);
          return { returning: async () => [{ id: "x" }] };
        },
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
const { registerWebhooksRoutes } = await import("./webhooks.js");
import type { HubHono, HubVariables } from "./_shared.js";

const OWNER = "pod-owner-human";
const READ = ["hub-protocol.read"];
const READ_WRITE = ["hub-protocol.read", "hub-protocol.write"];

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
/**
 * `*` pinned to one workspace. NOT fenced by `isFencedGrant` (which reads
 * permissions only), so the generic fence never looks at it — the owner-wide
 * door must refuse it on its own.
 */
const ONE_WORKSPACE = grantRow({ workspaceIds: ["ws-1"] });
/** A plainly fenced read grant, narrowed to one workspace. */
const DOC_ONLY_WS = grantRow({
  permissions: ["document.read"],
  workspaceIds: ["ws-1"],
});
/** The default every new AI agent is minted with: read & propose, no narrowing. */
const AI_PRESET_LIKE = grantRow({
  permissions: ["entity.*.read", "entity.*.create", "document.read"],
});

/** Both production mounts (apps/api/src/index.ts: /api/hub + /api/hub-protocol). */
function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerWebhooksRoutes(hub);
  // A POST READ door the fence classifies (GRANT_REST_POST_READS) — a stub, so
  // the fence's verdict is what the status reports.
  hub.post("/knowledge/ask", (c) => c.json({ ok: true }));
  const root = new Hono();
  root.route("/api/hub", hub);
  root.route("/api/hub-protocol", hub);
  return root;
}

function asKey(scope: string[], row: Record<string, unknown>) {
  grant.rows = [row];
  getApiKeyStatus.mockResolvedValue({
    status: "valid",
    record: {
      id: "key-1",
      userId: "agent-principal",
      linkedUserId: OWNER,
      parentKeyId: null,
      scope,
      keyType: "hub_inbound",
      workspaceId: null,
      expiresAt: null,
    },
  });
}

const create = (mount = "/api/hub") =>
  app().request(`${mount}/webhooks`, {
    method: "POST",
    headers: {
      authorization: "Bearer synap_test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: "https://attacker.example/hook",
      eventTypes: ["*"],
    }),
  });
const remove = () =>
  app().request("/api/hub/webhooks/00000000-0000-4000-8000-000000000001", {
    method: "DELETE",
    headers: { authorization: "Bearer synap_test" },
  });
const list = () =>
  app().request("/api/hub/webhooks", {
    headers: { authorization: "Bearer synap_test" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  listFindMany.mockResolvedValue([]);
});

describe("POST /webhooks — write scope and an unbounded grant", () => {
  it("a read-only key cannot create a webhook (no row written)", async () => {
    asKey(READ, FULL);
    const res = await create();
    expect(res.status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("a workspace-narrowed key cannot create one, even holding write scope", async () => {
    asKey(READ_WRITE, ONE_WORKSPACE);
    const res = await create();
    expect(res.status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("a kind-narrowed (AI preset-like) key cannot create one either", async () => {
    asKey(READ_WRITE, AI_PRESET_LIKE);
    const res = await create();
    expect(res.status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("a fenced key cannot create one through the /api/hub-protocol alias either", async () => {
    asKey(READ_WRITE, DOC_ONLY_WS);
    expect((await create("/api/hub-protocol")).status).toBe(403);
    asKey(READ_WRITE, ONE_WORKSPACE);
    expect((await create("/api/hub-protocol")).status).toBe(403);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("a full-access key with write scope still can (owner-floored row)", async () => {
    asKey(READ_WRITE, FULL);
    const res = await create();
    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues.mock.calls[0][0]).toMatchObject({ userId: OWNER });
  });
});

describe("DELETE /webhooks/:id — the same rule", () => {
  it("a read-only key cannot delete", async () => {
    asKey(READ, FULL);
    expect((await remove()).status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it("a fenced key cannot delete, even holding write scope", async () => {
    asKey(READ_WRITE, ONE_WORKSPACE);
    expect((await remove()).status).toBe(403);
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it("a full-access key with write scope can", async () => {
    asKey(READ_WRITE, FULL);
    expect((await remove()).status).toBe(200);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });
});

describe("GET /webhooks — the caller's own rows only", () => {
  it("a fenced key cannot list (fan-out config is pod-wide)", async () => {
    asKey(READ_WRITE, ONE_WORKSPACE);
    expect((await list()).status).toBe(403);
    expect(listFindMany).not.toHaveBeenCalled();
  });

  it("a full-access read key lists, filtered on the remapped owner", async () => {
    asKey(READ, FULL);
    expect((await list()).status).toBe(200);
    const where = listFindMany.mock.calls[0][0].where as SQL;
    const q = new PgDialect().sqlToQuery(where);
    expect(q.sql).toMatch(/"user_id" = \$1/);
    expect(q.params).toEqual([OWNER]);
  });

  it("a key with no hub scope at all cannot list", async () => {
    asKey([], FULL);
    expect((await list()).status).toBe(403);
    expect(listFindMany).not.toHaveBeenCalled();
  });
});

describe("the fence sees the /api/hub-protocol alias mount", () => {
  const ask = (mount: string) =>
    app().request(`${mount}/knowledge/ask`, {
      method: "POST",
      headers: {
        authorization: "Bearer synap_test",
        "content-type": "application/json",
      },
      body: "{}",
    });

  it("a fenced key is refused an aggregate POST read on BOTH mounts", async () => {
    asKey(READ_WRITE, DOC_ONLY_WS);
    expect((await ask("/api/hub")).status).toBe(403);
    expect((await ask("/api/hub-protocol")).status).toBe(403);
  });

  it("a full-access key passes it on both (control)", async () => {
    asKey(READ_WRITE, FULL);
    expect((await ask("/api/hub")).status).toBe(200);
    expect((await ask("/api/hub-protocol")).status).toBe(200);
  });
});
