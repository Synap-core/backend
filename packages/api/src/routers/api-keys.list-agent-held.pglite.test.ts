/**
 * `apiKeys.list` / `apiKeys.revoke` see the keys an agent holds FOR you (D6,
 * 2026-10-06 centralisation audit).
 *
 * THE DEFECT. Agent and OAuth-client keys are owned by the AGENT user
 * (`api_keys.user_id` = agent, `linked_user_id` = the human). `list` floored on
 * `user_id = me`, so /my-connections showed none of them, and `revoke` answered
 * NOT_FOUND for them — the human could neither see nor stop the credentials
 * acting in their name.
 *
 * Driven through the REAL procedures on PGlite (every @synap/database table).
 * Stubbed: the db handle, and the governance gate (a human revoking their own
 * agent's key is granted — the gate's ladder is pinned elsewhere).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

// The pod-admin gate is pinned in its own tests; here one admin passes it.
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async (userId: string) => userId === "pod-admin-1"),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { apiKeysRouter } from "./api-keys.js";

const HUMAN = "human-1";
const AGENT = "agent-1";
const STRANGER = "stranger-1";
const OWN_KEY = randomUUID();
const AGENT_KEY = randomUUID();
const STRANGER_KEY = randomUUID();

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

const caller = (userId: string) =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
  } as never);

async function addKey(id: string, userId: string, linkedUserId: string | null) {
  await h.client!.query(
    `insert into api_keys
       (id, user_id, key_name, key_prefix, key_hash, key_type, scope,
        linked_user_id, is_active, usage_count, created_at)
     values ($1, $2, $4, 'synap_hub_test_', $5, 'hub_inbound',
        '{hub-protocol.read}', $3, true, 0, now())`,
    [id, userId, linkedUserId, `key-${id}`, `hash-${id}`]
  );
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await addKey(OWN_KEY, HUMAN, null);
  await addKey(AGENT_KEY, AGENT, HUMAN);
  await addKey(STRANGER_KEY, STRANGER, null);
});

describe("apiKeys.list — the keys you hold and the keys held for you", () => {
  it("lists your key and your agent's key, never a stranger's", async () => {
    const keys = await caller(HUMAN).list();
    expect(keys.map((k) => k.id).sort()).toEqual([AGENT_KEY, OWN_KEY].sort());
    expect(keys.find((k) => k.id === AGENT_KEY)?.heldByAgent).toBe(true);
    expect(keys.find((k) => k.id === OWN_KEY)?.heldByAgent).toBe(false);
  });
});

describe("apiKeys.revoke — you can stop a key held for you", () => {
  it("revokes your agent's key", async () => {
    await expect(
      caller(HUMAN).revoke({ keyId: AGENT_KEY })
    ).resolves.toMatchObject({ status: "revoked" });
    const { rows } = await h.client!.query<{ is_active: boolean }>(
      `select is_active from api_keys where id = $1`,
      [AGENT_KEY]
    );
    expect(rows[0].is_active).toBe(false);
  });

  it("still refuses a stranger's key", async () => {
    await expect(
      caller(HUMAN).revoke({ keyId: STRANGER_KEY })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("apiKeys.list — a switched-off key says why", () => {
  // Rules out: the UIs' `revokedAt ?? createdAt` guess, which read a key
  // waiting for approval as revoked on the day it was made.
  it("a revoked key carries its revoke stamp; a key waiting for approval is not revoked", async () => {
    const PENDING_KEY = randomUUID();
    await addKey(PENDING_KEY, AGENT, HUMAN);
    await h.client!.query(
      `update api_keys set is_active = false where id = $1`,
      [PENDING_KEY]
    );
    const keys = await caller(HUMAN).list();
    const revoked = keys.find((k) => k.id === AGENT_KEY)!;
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.awaitingApproval).toBe(false);
    const pending = keys.find((k) => k.id === PENDING_KEY)!;
    expect(pending.revokedAt).toBeNull();
    expect(pending.awaitingApproval).toBe(true);
    expect(keys.find((k) => k.id === OWN_KEY)!.awaitingApproval).toBe(false);
  });
});

describe("apiKeys.list — an old CLI key that acts as you is flagged", () => {
  // MACHINE-IDENTITY-PLAN §0: old CLI keys are kept, flagged "acts as you",
  // and offered a replacement. Rules out: flagging an agent-held key (a
  // computer's or an agent's writes as ITSELF), or a key minted for no
  // integration (a personal key you made on purpose).
  it("flags your own integration Hub key, never an agent-held or non-integration key", async () => {
    const CLI_KEY = randomUUID();
    const AGENT_CLI_KEY = randomUUID();
    await addKey(CLI_KEY, HUMAN, null);
    await addKey(AGENT_CLI_KEY, AGENT, HUMAN);
    await h.client!.query(
      `update api_keys set hub_id = 'integration:cli' where id = any($1)`,
      [[CLI_KEY, AGENT_CLI_KEY]]
    );
    const keys = await caller(HUMAN).list();
    expect(keys.find((k) => k.id === CLI_KEY)!.actsAsYou).toBe(true);
    expect(keys.find((k) => k.id === AGENT_CLI_KEY)!.actsAsYou).toBe(false);
    expect(keys.find((k) => k.id === OWN_KEY)!.actsAsYou).toBe(false);
  });
});

describe("apiKeys.list — who holds each key", () => {
  // An app key, a computer key and a person's own token are ALL `user_pat`;
  // the holder is the only fact that tells them apart. Rules out: labelling
  // an app's or a computer's key "Operator" (a human token) in the key lists.
  it("names an app, a computer, an agent and a person as such", async () => {
    const OWNER = "owner-h";
    const MACHINE = "machine-h";
    const APP_AGENT = "app-agent-h";
    const PLAIN_AGENT = "plain-agent-h";
    await h.client!.query(
      `insert into users (id, email, name, user_type, agent_type) values
         ($1, 'owner@x', 'Owner', 'human', null),
         ($2, 'machine@x', 'Studio Mac', 'agent', 'machine'),
         ($3, 'app@x', 'app agent', 'agent', 'app'),
         ($4, 'agent@x', 'Claude', 'agent', 'claude')`,
      [OWNER, MACHINE, APP_AGENT, PLAIN_AGENT]
    );
    await h.client!.query(
      `insert into apps (id, owner_user_id, public_id, name, agent_user_id)
       values (gen_random_uuid(), $1, 'app_x', 'Invoicer', $2)`,
      [OWNER, APP_AGENT]
    );
    const keyOf = {
      own: randomUUID(),
      machine: randomUUID(),
      app: randomUUID(),
      agent: randomUUID(),
    };
    await addKey(keyOf.own, OWNER, null);
    await addKey(keyOf.machine, MACHINE, OWNER);
    await addKey(keyOf.app, APP_AGENT, OWNER);
    await addKey(keyOf.agent, PLAIN_AGENT, OWNER);

    const keys = await caller(OWNER).list();
    const holder = (id: string) => keys.find((k) => k.id === id)?.holder;
    expect(holder(keyOf.own)).toEqual({ kind: "person", name: "Owner" });
    expect(holder(keyOf.machine)).toEqual({
      kind: "computer",
      name: "Studio Mac",
    });
    expect(holder(keyOf.app)).toEqual({
      kind: "app",
      name: "Invoicer",
      appId: "app_x",
    });
    expect(holder(keyOf.agent)).toEqual({ kind: "agent", name: "Claude" });
  });

  it("a holder whose user row is gone reads as unknown (null)", async () => {
    const keys = await caller(HUMAN).list();
    // HUMAN / AGENT were never inserted as users in this file's fixtures.
    expect(keys.find((k) => k.id === OWN_KEY)?.holder).toBeNull();
  });
});

describe("apiKeys.adminListAll — a space key says which space", () => {
  // Rules out: the console guessing a key's space from a `hubId` convention
  // nothing mints, while the real `api_keys.workspace_id` never reached it.
  it("carries the key's own workspaceId, null for a pod-wide key", async () => {
    const SPACE = randomUUID();
    const SPACE_KEY = randomUUID();
    await addKey(SPACE_KEY, HUMAN, null);
    await h.client!.query(
      `update api_keys set workspace_id = $2 where id = $1`,
      [SPACE_KEY, SPACE]
    );
    const keys = await caller("pod-admin-1").adminListAll();
    expect(keys.find((k) => k.id === SPACE_KEY)?.workspaceId).toBe(SPACE);
    expect(keys.find((k) => k.id === OWN_KEY)?.workspaceId).toBeNull();
  });
});

describe("apiKeys.adminListAll({ workspaceId }) — only keys confined to that space", () => {
  // Rules out: the space's API keys tab listing every key a member owns,
  // their pod-wide keys and their keys confined to OTHER spaces included.
  it("lists the space's own keys, not a member's pod-wide or other-space key", async () => {
    const SPACE = randomUUID();
    const OTHER_SPACE = randomUUID();
    const MEMBER = "space-member-1";
    const inSpace = randomUUID();
    const podWide = randomUUID();
    const elsewhere = randomUUID();
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values (gen_random_uuid(), $1, $2, 'editor')`,
      [SPACE, MEMBER]
    );
    await addKey(inSpace, MEMBER, null);
    await addKey(podWide, MEMBER, null);
    await addKey(elsewhere, MEMBER, null);
    await h.client!.query(
      `update api_keys set workspace_id = $2 where id = $1`,
      [inSpace, SPACE]
    );
    await h.client!.query(
      `update api_keys set workspace_id = $2 where id = $1`,
      [elsewhere, OTHER_SPACE]
    );

    const keys = await caller("pod-admin-1").adminListAll({
      workspaceId: SPACE,
    });
    expect(keys.map((k) => k.id)).toEqual([inSpace]);
  });

  it("refuses a caller who is not a pod admin", async () => {
    await expect(
      caller(HUMAN).adminListAll({ workspaceId: randomUUID() })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
