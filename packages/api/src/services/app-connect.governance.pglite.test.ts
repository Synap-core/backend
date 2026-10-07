/**
 * Founder decision 2 — an APP's writes are governed like an agent's: a grant
 * permits, it never auto-approves.
 *
 * Driven through the REAL chain on PGlite: `ensureAppAgent` (the app's own
 * agent user + the `ask-first` posture, THE posture writer) → a key held by
 * that agent and linked to the owner → `resolveKeyIdentity` (every key-auth
 * door) → `runWithGrant` + `checkPermissionOrPropose` (the write gate and the
 * ONE agent ladder).
 *
 * The pod default "reversible writes act" (`@reversible`, principal any) is
 * SEEDED on purpose: it is the input on which "governed like an agent" and
 * "governed like a plain new agent" disagree. A plain agent of the same owner
 * auto-executes a person create under it; the app's agent must propose.
 *
 * Rows that rule out a wrong rule:
 *  - inside reach ⇒ PROPOSED, stamped with the app (`proposals.app_id`);
 *  - outside reach ⇒ refused by the grant, no proposal;
 *  - the owner's own write ⇒ granted, untouched by any of this;
 *  - a plain agent (no posture) ⇒ executes — proves the seeded default bites;
 *  - a key minted BEFORE 0313 (held by the human) is adopted onto the app's
 *    agent the first time it authenticates, with the SAME key id.
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
  // The key row lands in PGlite like any other; the real repository also
  // emits through the postgres-js `sql` client, which this harness has not.
  class PgliteApiKeyRepository {
    async create(input: Record<string, unknown>) {
      const [row] = await (h.db as any)
        .insert(schema.apiKeys)
        .values({
          keyName: input.keyName,
          keyPrefix: input.keyPrefix,
          keyHash: "hash",
          scope: input.scope,
          userId: input.userId,
          linkedUserId: input.linkedUserId ?? null,
          keyType: input.keyType,
          isActive: true,
        })
        .returning();
      return row;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    ApiKeyRepository: PgliteApiKeyRepository,
  };
});

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { AppRepository, runWithGrant, type KeyGrant } from "@synap/database";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
import {
  checkPermissionOrPropose,
  previewPermissionDecision,
} from "../utils/permission-check.js";
import { resolveKeyIdentity } from "../access/key-identity.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import { grantsForApprovedRequests, issueKey } from "./app-connect.js";

const OWNER = "human-owner";
const PLAIN_AGENT = randomUUID();
const SALES = randomUUID();
const FINANCE = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    // The columns the insert paths here leave to their database default.
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const APPROVED = [{ permission: "entity.person.create", workspaceId: SALES }];

async function mintAppKey(principal: string, linked: string | null) {
  const keyId = randomUUID();
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope)
     values ($1, $2, $3, true, 'user_pat', 'synap.live (app)', 'synap_', 'h', '{}')`,
    [keyId, principal, linked]
  );
  return keyId;
}

let appAgent: string;
let publicId: string;
let issued: { apiKey: string; keyId: string };

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, 'owner@x', 'human')`,
    [OWNER]
  );
  // A plain agent of the same owner (no posture): the discriminating control.
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, created_via, agent_metadata)
     values ($1, 'plain@x', 'agent', $2, 'claude-code', 'cli', '{"writesRequireProposal": true}'::jsonb)`,
    [PLAIN_AGENT, OWNER]
  );
  for (const ws of [SALES, FINANCE]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      ws,
      ws === SALES ? "Sales" : "Finance",
      OWNER,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  // The plain agent holds the SAME reach the app's agent gets (editor, Sales).
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
    [randomUUID(), SALES, PLAIN_AGENT]
  );
  // A pod-wide `person` kind — the create gate refuses an unknown kind first.
  await q(
    `insert into profiles (id, slug, scope, is_active, origin) values ($1, 'person', 'system', true, 'system')`,
    [randomUUID()]
  );
  // The pod default (migration 0282): agents act on reversible writes.
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1, 'any', 'pod', 'action', $2, 'auto', 'system:reversible-default')`,
    [randomUUID(), REVERSIBLE_CLASS_PATTERN]
  );

  const repo = new AppRepository(h.db as never);
  const app = await repo.register({ ownerUserId: OWNER, name: "synap.live" });
  await repo.setApprovedRequests(app.id, APPROVED);
  publicId = app.publicId;
  // THE door the CLI calls (`POST /apps/:id/key`): creates the app's agent,
  // gives it the approved reach, mints its key.
  issued = await issueKey({ publicId, ownerUserId: OWNER, via: "cli" });
  appAgent = (await repo.getByPublicId(publicId))!.app.agentUserId!;
}, 120_000);

async function identityFor(keyId: string) {
  const row = (
    await q<{ user_id: string; linked_user_id: string | null }>(
      `select user_id, linked_user_id from api_keys where id = $1`,
      [keyId]
    )
  ).rows[0]!;
  return resolveKeyIdentity({
    id: keyId,
    userId: row.user_id,
    linkedUserId: row.linked_user_id,
  });
}

const createPerson = (
  workspaceId: string,
  as: { userId: string; agentUserId?: string },
  grant?: KeyGrant | null
) => {
  const call = () =>
    checkPermissionOrPropose({
      userId: as.userId,
      agentUserId: as.agentUserId,
      workspaceId,
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "person", title: "Ada" },
    } as Parameters<typeof checkPermissionOrPropose>[0]);
  return grant ? runWithGrant(grant, call) : call();
};

describe("an app is governed like an agent (founder decision 2)", () => {
  it("the app has its OWN ask-first agent user, a member of exactly the approved workspace", async () => {
    const members = (
      await q<{ workspace_id: string; role: string }>(
        `select workspace_id, role from workspace_members where user_id = $1`,
        [appAgent]
      )
    ).rows;
    expect(members).toEqual([{ workspace_id: SALES, role: "editor" }]);
    const rules = (
      await q<{ verdict: string }>(
        `select verdict from governance_rules where agent_user_id = $1 and revoked_at is null`,
        [appAgent]
      )
    ).rows;
    expect(rules.length).toBeGreaterThan(0);
    expect(new Set(rules.map((r) => r.verdict))).toEqual(new Set(["propose"]));
    const [row] = (
      await q<{ agent_user_id: string; user_type: string; agent_type: string }>(
        `select a.agent_user_id, u.user_type, u.agent_type from apps a join users u on u.id = a.agent_user_id where a.public_id = $1`,
        [publicId]
      )
    ).rows;
    expect(row).toMatchObject({
      agent_user_id: appAgent,
      user_type: "agent",
      agent_type: publicId,
    });
  });

  it("the issued key resolves as the app's agent, acting for the owner", async () => {
    const id = await identityFor(issued.keyId);
    expect(id).toMatchObject({
      isAgent: true,
      agentUserId: appAgent,
      effectiveUserId: OWNER,
    });
    expect(id.grant?.clientId).toBe(publicId);

    // INSIDE reach ⇒ proposed, never executed. Read through the SAME door in
    // decision-only mode: this harness's database package writes a pending
    // proposal through its own postgres client, which PGlite cannot stand in
    // for. The proposal's "via <app>" stamp is `getRequestGrant().clientId`
    // (permission-check createProposal) — the grant asserted above.
    const inside = await runWithGrant(id.grant!, () =>
      previewPermissionDecision({
        userId: id.effectiveUserId,
        agentUserId: id.agentUserId,
        workspaceId: SALES,
        subjectType: "entity",
        action: "create",
        data: { profileSlug: "person", title: "Ada" },
      } as Parameters<typeof previewPermissionDecision>[0])
    );
    expect(inside).toEqual({ decision: "propose" });

    // OUTSIDE reach ⇒ refused by the grant, nothing proposed.
    const before = (await q(`select id from proposals`)).rows.length;
    const outside = await createPerson(
      FINANCE,
      { userId: id.effectiveUserId, agentUserId: id.agentUserId },
      id.grant
    );
    expect(outside).toMatchObject({ denied: true });
    expect((outside as { reason: string }).reason).toMatch(
      /grant does not allow/
    );
    expect((await q(`select id from proposals`)).rows.length).toBe(before);
  });

  it("CONTROL: a plain agent of the same owner executes under the pod default", async () => {
    const r = await createPerson(SALES, {
      userId: OWNER,
      agentUserId: PLAIN_AGENT,
    });
    expect(r).toMatchObject({ granted: true });
  });

  it("the owner's own write is untouched", async () => {
    expect(await createPerson(SALES, { userId: OWNER })).toMatchObject({
      granted: true,
    });
  });

  it("a key minted BEFORE 0313 (held by the human) is adopted onto the app's agent on first use", async () => {
    const keyId = await mintAppKey(OWNER, null);
    await attachGrantsOrRevoke({
      apiKeyId: keyId,
      principalUserId: OWNER,
      onBehalfOf: OWNER,
      grants: grantsForApprovedRequests(APPROVED),
      expiresAt: null,
      createdBy: OWNER,
      clientId: publicId,
    });
    // The stale shape a verification cache could still hand the door.
    const stale = { id: keyId, userId: OWNER, linkedUserId: null };
    for (let i = 0; i < 2; i++) {
      expect(await resolveKeyIdentity(stale)).toMatchObject({
        isAgent: true,
        agentUserId: appAgent,
        effectiveUserId: OWNER,
      });
    }
    const [key] = (
      await q<{ user_id: string; linked_user_id: string }>(
        `select user_id, linked_user_id from api_keys where id = $1`,
        [keyId]
      )
    ).rows;
    expect(key).toEqual({ user_id: appAgent, linked_user_id: OWNER });
    const principals = (
      await q<{ principal_user_id: string }>(
        `select principal_user_id from grants where api_key_id = $1`,
        [keyId]
      )
    ).rows.map((r) => r.principal_user_id);
    expect(principals).toEqual([appAgent]);
  });

  it("a non-app grant (an OAuth client) is never adopted", async () => {
    const keyId = await mintAppKey(OWNER, null);
    await attachGrantsOrRevoke({
      apiKeyId: keyId,
      principalUserId: OWNER,
      onBehalfOf: OWNER,
      grants: grantsForApprovedRequests(APPROVED),
      expiresAt: null,
      createdBy: OWNER,
      clientId: "dcr_someclient",
    });
    expect(
      await resolveKeyIdentity({ id: keyId, userId: OWNER, linkedUserId: null })
    ).toMatchObject({ isAgent: false, agentUserId: undefined });
  });
});
