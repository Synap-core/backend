/**
 * `GET /computers/me/wakes` with a REAL computer key, through the REAL hub
 * auth door (its W1 grant fence), the REAL route and the REAL wake-lease read
 * (`loadWakerSeenAt`, what the hand-off roster reads), compiled and run as SQL
 * on PGlite. Stubbed: the key lookup (the row it returns is the shape
 * `machine-connect.ts` mints), the guest check.
 *
 * The computer key a device flow mints is a `user_pat` held by the computer
 * (`agent_type = 'machine'`) carrying the "AI — read & propose" grant
 * (`aiDefaultCapabilities()`): a SCOPED key. backend#909 shipped the door
 * REFUSED to every scoped key and the lease read filtered `hub_inbound`, so a
 * real computer was answered 403 and its agents read `no_waker` forever.
 *
 * Rows rule out: the fence refusing the computer's own key, the lease read
 * missing the stamp its poll left, and the door opening to another key that
 * holds the same grant (the route refuses it, not the fence).
 *
 * Cannot see: production Postgres, the CLI's waker loop.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiDefaultCapabilities } from "@synap-core/types/grants";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  keys: new Map<string, Record<string, unknown>>(),
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
    getApiKeyStatus: async (bearer: string) => {
      const record = h.keys.get(bearer.replace(/^synap_/, ""));
      return record ? { status: "valid", record } : { status: "not_found" };
    },
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
import { registerComputerWakesRoutes } from "./computer-wakes.js";
import { loadWakerSeenAt } from "../../../services/computer-waker.js";
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

const PERSON = randomUUID(); // the person who approved the device flow
const COMPUTER = randomUUID(); // the computer principal (agent_type machine)
const AGENT = randomUUID(); // an agent of the same person, not a computer
/** The scopes `machine-connect.ts` gives a computer key (SETUP_AGENT_HUB_SCOPES). */
const SCOPES = ["hub-protocol.read", "hub-protocol.write"];
const KEYS = {
  computer: { id: randomUUID(), userId: COMPUTER },
  agent: { id: randomUUID(), userId: AGENT },
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
    PERSON,
    "person@example.test",
  ]);
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, agent_metadata)
     values ($1,$2,'devbox','agent','machine',$3,'{}'::jsonb)`,
    [COMPUTER, "computer@example.test", PERSON]
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id)
     values ($1,$2,'Claude','agent','claude-code',$3)`,
    [AGENT, "agent@example.test", PERSON]
  );
  const permissions = `{${aiDefaultCapabilities()
    .map((p) => `"${p}"`)
    .join(",")}}`;
  for (const [name, k] of Object.entries(KEYS)) {
    // The row machine-connect mints: a `user_pat`, linked to its person.
    await q(
      `insert into api_keys (id, user_id, key_type, linked_user_id, is_active, created_at)
       values ($1,$2,'user_pat',$3,true,now())`,
      [k.id, k.userId, PERSON]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, created_by)
       values ($1,$2,$3,$4,$5::text[],$4)`,
      [randomUUID(), k.id, k.userId, PERSON, permissions]
    );
    h.keys.set(name, {
      id: k.id,
      userId: k.userId,
      linkedUserId: PERSON,
      parentKeyId: null,
      scope: SCOPES,
      keyType: "user_pat",
      workspaceId: null,
      expiresAt: null,
    });
  }
}, 120_000);

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerComputerWakesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const poll = (key: KeyName) =>
  app().request("/api/hub/computers/me/wakes", {
    headers: {
      authorization: `Bearer synap_${key}`,
      "x-synap-runner": "synap-waker/0.9.9",
    },
  });

type Body = { code?: string; wakesAgents?: boolean; computer?: { id: string } };

describe("GET /computers/me/wakes — a real computer key (user_pat, AI grant)", () => {
  it("the computer's own key is answered by the route, not refused by the fence", async () => {
    const res = await poll("computer");
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.computer?.id).toBe(COMPUTER);
    // The switch is off on this computer: the answer says so.
    expect(body.wakesAgents).toBe(false);
  });

  it("its poll is the lease the hand-off roster reads (loadWakerSeenAt)", async () => {
    expect((await poll("computer")).status).toBe(200);
    const seen = await loadWakerSeenAt([COMPUTER]);
    expect(seen.get(COMPUTER)).toBeInstanceOf(Date);
  });

  it("another key holding the same grant is refused by the route", async () => {
    const res = await poll("agent");
    const body = (await res.json()) as Body;
    expect(res.status, JSON.stringify(body)).toBe(403);
    expect(body.code).toBe("NOT_A_COMPUTER");
  });
});
