/**
 * FB1020 review M4 — the entity door floors a possible duplicate for EVERY AI
 * write the gate counts as AI, not only an attributed agent.
 *
 * THE DEFECT: `entities.create` passed `possibleDuplicate` only when
 * `input.agentUserId` was set, while the gate's `isAiWrite` also counts an
 * unattributed `source: "intelligence"` (a hub key / IS call whose agent did
 * not resolve) — so that caller's same-name create auto-applied with a
 * warning (against B2c), and it could pass the reviewer's `approvalDuplicate`.
 *
 * Driven through the REAL Bearer door and the REAL gate on PGlite (every
 * table); only the key lookup / identity and delivery side effects are
 * stubbed. The seam under test — `checkPermissionOrPropose` — is NOT mocked.
 *
 * Rows:
 *  - an unattributed hub create of a same-name person is FILED, no twin row;
 *  - CONTROL: the same caller's create with no twin still lands (rules out
 *    "every AI create is a proposal");
 *  - an unattributed AI caller's `approvalDuplicate: "keep_both"` is ignored
 *    (rules out the reviewer's flag riding an AI filing).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  agentUserId: undefined as string | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: "event" }) }
  );
  return { ...actual, db: h.db, getDb: async () => h.db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "44444444-4444-4444-8444-444444444444",
      userId: "user-m4",
      linkedUserId: null,
      keyName: "m4",
      keyType: "user_pat",
      workspaceId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
    })),
    checkRateLimit: vi.fn(() => true),
  },
}));
vi.mock("../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "user-m4",
    agentUserId: h.agentUserId,
    grant: null,
  })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubProtocolRouter } from "./index.js";
import { entitiesRouter } from "../entities.js";

const USER = "user-m4";
const WS = randomUUID();
const PERSON_PROFILE = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function hub() {
  h.agentUserId = undefined;
  const req = new Request("http://pod.test/api/hub/trpc/x", {
    headers: { authorization: "Bearer sk_test", "x-workspace-id": WS },
  });
  return hubProtocolRouter.createCaller({
    req,
    authenticated: false,
    workspaceId: WS,
  } as never);
}

const rowsTitled = async (title: string) =>
  (await q(`select id from entities where title = $1`, [title])).rows.length;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@x`,
  ]);
  await q(`insert into workspaces (id, owner_id, name) values ($1, $2, 'w')`, [
    WS,
    USER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, entity_scope, profile_kind, is_active, origin, ui_hints, default_values)
     values ($1, 'person', 'Person', 'system', 'pod', 'kind', true, 'authored', '{}', '{}')`,
    [PERSON_PROFILE]
  );
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties, created_at, updated_at)
     values (gen_random_uuid(), $1, 'person', $2, 'Ada Lovelace', null, '{}', now(), now()),
            (gen_random_uuid(), $1, 'person', $2, 'Bea Twin', null, '{}', now(), now())`,
    [USER, PERSON_PROFILE]
  );
});

describe("an unattributed AI create meets the POSSIBLE_DUPLICATE floor (M4)", () => {
  it("a same-name person through a hub key is FILED for review, no twin row", async () => {
    const res = await hub().entities.createEntity({
      userId: USER,
      profileSlug: "person",
      title: "Ada Lovelace",
    });
    expect(res.status).toBe("proposed");
    expect(await rowsTitled("Ada Lovelace")).toBe(1);
  });

  it("CONTROL — the same caller's create with no twin still lands", async () => {
    const res = await hub().entities.createEntity({
      userId: USER,
      profileSlug: "person",
      title: "Zed Nobody",
    });
    expect(res.status).toBe("created");
    expect(await rowsTitled("Zed Nobody")).toBe(1);
  });

  it("an unattributed AI caller cannot pass the reviewer's keep_both", async () => {
    const res = (await entitiesRouter
      .createCaller({
        authenticated: true,
        userId: USER,
        workspaceId: WS,
      } as never)
      .create({
        profileSlug: "person",
        title: "Bea Twin",
        source: "intelligence",
        approvalDuplicate: "keep_both",
      } as never)) as { status: string };
    expect(res.status).toBe("proposed");
    expect(await rowsTitled("Bea Twin")).toBe(1);
  });
});
