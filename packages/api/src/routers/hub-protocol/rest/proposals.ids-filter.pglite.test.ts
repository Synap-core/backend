/**
 * GET /proposals?proposalIds= for a SCOPED key — through the REAL hub auth door
 * (its W1 fence + `runWithGrant`), the REAL route, the REAL `getCaller` → hub
 * `proposals.listProposals` → `proposalUserFloor` (+ `grantReadPredicate`),
 * compiled and run as SQL on PGlite. Only the key lookup (`apiKeyService`) and
 * the guest check are stubbed; each key's grant is a real `grants` row.
 *
 * Why: an app holding a key with a per-workspace read grant resolves a known
 * batch of proposals (the ones it filed, a notification's rows) without paging
 * the whole queue. The filter must NARROW the floored list, never replace it:
 * an id in a workspace the grant does not cover is omitted, exactly as it is
 * from the unfiltered list.
 *
 * Rows rule out: a door that drops `proposalIds` (the in-grant batch would come
 * back with its sibling), a filter that replaces the floor (the out-of-grant id
 * would come back), an empty batch read as "no filter", and a malformed id that
 * surfaces as a 500.
 *
 * Cannot see: production Postgres; the tRPC `proposals.list` twin (same
 * `proposalIdsWhere`, but its own floor — not driven here).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerProposalsRoutes } from "./proposals.js";
import type { HubHono, HubVariables } from "./_shared.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the human whose pod it is
const AGENT = randomUUID(); // the key principal (an agent user, linked to OWNER)
const WS_A = randomUUID(); // the workspace the app's grant covers
const WS_B = randomUUID(); // another of the owner's workspaces — NOT granted
const A1 = randomUUID();
const A2 = randomUUID();
const B1 = randomUUID();

/** Keys by bearer: each one's grant is a real `grants` row. */
const KEYS = {
  // The app-connect shape: read-only, pinned to one workspace.
  pinned: {
    id: randomUUID(),
    permissions: ["proposal.read"],
    workspaceIds: [WS_A] as string[] | null,
  },
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  for (const ws of [WS_A, WS_B]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  // Staggered createdAt so the list order is deterministic.
  for (const [i, [id, ws]] of (
    [
      [A1, WS_A],
      [A2, WS_A],
      [B1, WS_B],
    ] as const
  ).entries()) {
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, created_at)
       values ($1,$2,'entity',$3,'create','{}'::jsonb,'pending',$4, now() - ($5 || ' minutes')::interval)`,
      [id, ws, randomUUID(), OWNER, String(10 - i)]
    );
  }
  for (const k of Object.values(KEYS)) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const name = bearer.replace(/^synap_/, "") as KeyName;
    return {
      status: "valid",
      record: {
        id: KEYS[name].id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: ["hub-protocol.read"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerProposalsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, query: string) =>
  app().request(`/api/hub/proposals?status=all&limit=100&${query}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });

async function ids(res: Response): Promise<string[]> {
  const body = (await res.json()) as {
    proposals?: Array<{ id: string }>;
    error?: string;
  };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.proposals!.map((r) => r.id).sort();
}

describe("GET /proposals?proposalIds= — a filter on the floored, granted list", () => {
  it("control: a full-access key sees all three rows without the filter", async () => {
    expect(await ids(await get("full", ""))).toEqual([A1, A2, B1].sort());
  });

  it("control: the pinned key's unfiltered list is its workspace only", async () => {
    expect(await ids(await get("pinned", ""))).toEqual([A1, A2].sort());
  });

  it("in-grant batch ⇒ exactly the named rows (comma-separated)", async () => {
    expect(await ids(await get("pinned", `proposalIds=${A1}`))).toEqual([A1]);
  });

  it("repeated params are accepted too", async () => {
    expect(
      await ids(await get("pinned", `proposalIds=${A1}&proposalIds=${A2}`))
    ).toEqual([A1, A2].sort());
  });

  it("an id in a workspace the grant does NOT cover is omitted", async () => {
    expect(await ids(await get("pinned", `proposalIds=${A1},${B1}`))).toEqual([
      A1,
    ]);
    expect(await ids(await get("pinned", `proposalIds=${B1}`))).toEqual([]);
  });

  it("control: the same out-of-grant id IS returned to a full-access key", async () => {
    expect(await ids(await get("full", `proposalIds=${A1},${B1}`))).toEqual(
      [A1, B1].sort()
    );
  });

  it("`total` counts the filtered set, not the queue", async () => {
    const res = await get("pinned", `proposalIds=${A1},${B1}`);
    expect(((await res.json()) as { total: number }).total).toBe(1);
  });

  it("an empty batch matches nothing — never read as 'no filter'", async () => {
    expect(await ids(await get("full", "proposalIds="))).toEqual([]);
  });

  it("a malformed id or an over-cap batch is a 400, not a 500", async () => {
    expect((await get("pinned", "proposalIds=not-a-uuid")).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => randomUUID()).join(",");
    expect((await get("pinned", `proposalIds=${tooMany}`)).status).toBe(400);
  });
});
