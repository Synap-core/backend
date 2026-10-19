/**
 * Owner-wide WRITES with no grant check (lane/sec-webhooks sweep, family 7),
 * through the REAL hub auth door. Each handler writes directly, never passes
 * the gate, and its effect spans every workspace of the owner — so the W1
 * fence's "writes are bounded by the gate" rule let a narrowed key through:
 *
 *  - capability credentials POST / PATCH / DELETE — a credential row is used
 *    by the owner in EVERY workspace (`workspaceId: null`);
 *  - DELETE /vault/secrets/:id — any secret the person can write, in any
 *    workspace;
 *  - connector disconnect (DELETE /connectors/connections/:id, POST
 *    /connectors/disconnect) — revokes the account at the provider and
 *    detaches it from every capability.
 *
 * Only a key whose grant is UNBOUNDED full access may use them (the
 * `/webhooks*` rule), WRITES ONLY: the sibling GETs on the same paths
 * (`GET /connectors/connections/{provider}`, `GET .../credentials`) are reads
 * the generic fence already rules on, and are not newly refused here.
 *
 * Routes are stubs, so the status is the auth door's verdict alone. Rows rule
 * out: a fence that ignores the method (the GET rows must pass for a pinned
 * key), a fence that refuses everyone (the FULL rows), and one that only sees
 * fenced grants (the `*`-pinned-to-one-workspace rows — `isFencedGrant` is
 * blind to that pin).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getApiKeyStatus, grant } = vi.hoisted(() => ({
  getApiKeyStatus: vi.fn(),
  grant: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: async () => ({ id: "u", userType: "agent" }) },
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
const ONE_WORKSPACE = grantRow({ workspaceIds: ["ws-1"] });
const AI_PRESET_LIKE = grantRow({
  permissions: ["entity.*.read", "entity.*.create", "document.read"],
});

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const ROWS: Array<[Method, string, boolean]> = [
  ["POST", "/capabilities/cap-1/credentials", true],
  ["PATCH", "/capabilities/cap-1/credentials/cred-1", true],
  ["DELETE", "/capabilities/cap-1/credentials/cred-1", true],
  ["DELETE", "/vault/secrets/sec-1", true],
  ["DELETE", "/connectors/connections/conn-1", true],
  ["POST", "/connectors/disconnect", true],
  // Same paths, READ method — not this door class.
  ["GET", "/capabilities/cap-1/credentials", false],
  ["GET", "/connectors/connections/google", false],
  // Gated / bounded siblings — not this door class.
  ["POST", "/vault/secrets/sec-1/grant", false],
  ["POST", "/vault/secrets", false],
];

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  for (const [method, path] of ROWS) {
    hub.on(method, path, (c) => c.json({ ok: true }));
  }
  const root = new Hono();
  root.route("/api/hub", hub);
  root.route("/api/hub-protocol", hub);
  return root;
}

function asKey(row: Record<string, unknown>) {
  grant.rows = [row];
  getApiKeyStatus.mockResolvedValue({
    status: "valid",
    record: {
      id: "key-1",
      userId: "agent-principal",
      linkedUserId: "pod-owner-human",
      parentKeyId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType: "hub_inbound",
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

describe("owner-wide writes need an unbounded key", () => {
  it.each(ROWS.filter((r) => r[2]))(
    "%s %s → 403 for a `*` key pinned to one workspace",
    async (method, path) => {
      asKey(ONE_WORKSPACE);
      expect((await send(method, path)).status).toBe(403);
      expect((await send(method, path, "/api/hub-protocol")).status).toBe(403);
    }
  );

  it.each(ROWS.filter((r) => r[2]))(
    "%s %s → 403 for the AI preset (fenced, unpinned)",
    async (method, path) => {
      asKey(AI_PRESET_LIKE);
      expect((await send(method, path)).status).toBe(403);
    }
  );

  it.each(ROWS)(
    "%s %s → CONTROL: an unbounded key passes",
    async (method, path) => {
      asKey(FULL);
      expect((await send(method, path)).status).toBe(200);
    }
  );

  it.each(ROWS.filter((r) => !r[2]))(
    "%s %s → not owner-wide: a `*` key pinned to one workspace passes",
    async (method, path) => {
      asKey(ONE_WORKSPACE);
      expect((await send(method, path)).status).toBe(200);
    }
  );
});
