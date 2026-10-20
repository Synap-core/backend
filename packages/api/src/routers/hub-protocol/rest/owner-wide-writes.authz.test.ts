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
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

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
// The real "AI — read & propose" preset: reads every subject, never unbounded.
const AI_PRESET = grantRow({
  permissions: GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
    .grant.permissions,
});
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
  // S5 (2026-10-20): /memory writes act for the whole owner — knowledge_facts
  // are recalled in every workspace and no grant narrows them.
  ["POST", "/memory", true],
  ["POST", "/memory/turns", true],
  ["POST", "/memory/sessions", true],
  ["POST", "/memory/writes", true],
  ["DELETE", "/memory/fact-1", true],
  ["POST", "/memory/search", false], // a read
  // S6 (2026-10-20): a knowledge_keys runbook is pod-wide, addressed by key,
  // with no owner check — rewriting / archiving one needs an unbounded key.
  ["PUT", "/knowledge/deploy%3Abackend", true],
  ["DELETE", "/knowledge/deploy%3Abackend", true],
  ["POST", "/knowledge", false], // governed create (checkPermissionOrPropose)
  ["POST", "/knowledge/search", false], // reads
  ["POST", "/knowledge/ask", false],
  ["POST", "/knowledge/answer", false],
];

/** POST doors that READ — the generic fence rules on them, not this class. */
const POST_READS = new Set([
  "/memory/search",
  "/knowledge/search",
  "/knowledge/ask",
  "/knowledge/answer",
]);

/**
 * S1 (2026-10-20): a `*` pinned to a space, project or object is NARROWED, so
 * it goes through the scoped-key fence like any scoped key — unseamed reads
 * and aggregate reads it cannot bound are refused; seamed reads and writes
 * (bounded by the gate) pass. `[method, path, pinned key passes]`.
 */
const FENCE_ROWS: Array<[Method, string, boolean]> = [
  ["GET", "/search", false], // unseamed read
  ["POST", "/knowledge/ask", false], // aggregate read: a pin cannot bound it
  ["GET", "/entities", true], // seamed read
  ["POST", "/entities", true], // a write: bounded by the gate
];

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  for (const [method, path] of [...ROWS, ...FENCE_ROWS]) {
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

  it.each(ROWS.filter((r) => !r[2] && r[0] !== "GET" && !POST_READS.has(r[1])))(
    "%s %s → not owner-wide: a `*` key pinned to one workspace passes",
    async (method, path) => {
      asKey(ONE_WORKSPACE);
      expect((await send(method, path)).status).toBe(200);
    }
  );

  it.each(ROWS.filter((r) => POST_READS.has(r[1])))(
    "%s %s → a read, not owner-wide: the AI preset (bounded, unpinned) passes",
    async (method, path) => {
      asKey(AI_PRESET);
      expect((await send(method, path)).status).toBe(200);
    }
  );
});

describe("S1 — a pinned `*` goes through the scoped-key fence", () => {
  const ONE_PROJECT = grantRow({ projectIds: ["p-1"] });
  const ONE_OBJECT = grantRow({ entityIds: ["e-1"] });
  it.each(FENCE_ROWS)("%s %s → pinned key passes: %s", async (m, path, ok) => {
    for (const row of [ONE_WORKSPACE, ONE_PROJECT, ONE_OBJECT]) {
      asKey(row);
      const res = await send(m, path);
      expect(res.status).toBe(ok ? 200 : 403);
      if (!ok) expect((await res.json()).code).toBe("GRANT_DOOR_UNSUPPORTED");
    }
  });
  it.each(FENCE_ROWS)(
    "%s %s → CONTROL: an unbounded key passes",
    async (m, path) => {
      asKey(FULL);
      expect((await send(m, path)).status).toBe(200);
    }
  );
});
