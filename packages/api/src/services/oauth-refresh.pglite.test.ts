/**
 * Pod app refresh tokens (spec 17, wave PB3; founder decision F5) — end to end
 * on PGlite.
 *
 * The chain is the REAL one, as in pod-app.invariants.pglite.test.ts: consent
 * (`decideOAuthAuthorization` → `connectOAuthApp`) → the code → `POST /token`
 * over HTTP (`oauthApp`: `mintAppOAuthAccessKey` + `startRefreshFamily`) →
 * `POST /token` with `grant_type=refresh_token` (`redeemRefreshToken` →
 * `mintAppOAuthAccessKey` → `rotateRefreshToken`) → `apiKeyService
 * .validateApiKey` (what every key-auth door runs) → `revokeApp` and
 * `POST /revoke`.
 *
 * Pinned (spec 17 §12 PB3): R1 rotation, R2 reuse ⇒ family + live key
 * revoked, R3 concurrent redeem ⇒ one wins, no family revoke, R4 revoked app
 * ⇒ invalid_grant, R5 narrowed approval ⇒ narrower key, R6 30-day idle
 * expiry; plus /revoke with a refresh token, one live family per connection,
 * the GC bound, and the token's plaintext living only in the response.
 *
 * Seams replaced, and why: the event store (`EventRepository`) and `auditLog`
 * write through the postgres-js client this harness has not — both are
 * recorders. `createPendingProposal` inserts on the transaction it is given.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  events: [] as unknown[],
  audits: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class RecordingEventRepository {
    constructor(_sql?: unknown) {}
    async append(event: unknown) {
      h.events.push(event);
      return event;
    }
  }
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    EventRepository: RecordingEventRepository,
  };
});

vi.mock("../utils/audit-log.js", () => ({
  auditLog: async (opts: unknown) => {
    h.audits.push(opts);
    return null;
  },
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    // Inserted on the consent's transaction, as the real door does: a PGlite
    // transaction holds the one connection.
    createPendingProposal: async (
      input: Record<string, unknown>,
      tx?: unknown
    ) => {
      const [row] = await ((tx ?? h.db) as any)
        .insert(schema.proposals)
        .values({
          targetType: input.targetType,
          targetId: input.targetId,
          proposalType: input.proposalType,
          workspaceId: input.workspaceId ?? null,
          status: "pending",
          data: input.data,
          agentUserId: input.agentUserId ?? null,
          createdBy: input.createdBy,
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import { oauthApp } from "../routers/oauth/routes.js";
import { decideOAuthAuthorization } from "../routers/oauth/consent.js";
import { apiKeyService } from "./api-keys.js";
import {
  APP_OAUTH_DEAD_KEYS_KEPT,
  mintAppOAuthAccessKey,
  revokeApp,
} from "./app-connect.js";
import {
  redeemRefreshToken,
  revokeConnectionRefreshTokens,
  rotateRefreshToken,
} from "../routers/oauth/refresh.js";

const ISSUER = "https://pod.test.synap.live";
const STUDIO = "https://studio.example.com/.well-known/synap-client.json";
const STUDIO_CB = "https://studio.example.com/api/synap/callback";
const NOTES = "https://notes.example.com/.well-known/synap-client.json";
const MCP_CB = "https://claude.ai/api/mcp/auth_callback";

const OWNER = "human-owner";
const BRAND = randomUUID(); // OWNER owns it
const SHARED = randomUUID(); // OWNER owns it

const VERIFIER = "v".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
const READ = "entity.post.read";
const CREATE = "entity.post.create";
const DAY_MS = 24 * 60 * 60 * 1000;

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

const tableNames: string[] = [];

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      await h.client!.exec(ddlFor(value));
      tableNames.push(getTableConfig(value).name);
    }
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'owner@x', 'Ada', 'human')`,
    [OWNER]
  );
  for (const [id, name] of [
    [BRAND, "Brand"],
    [SHARED, "Shared"],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      id,
      name,
      OWNER,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, OWNER]
    );
  }
  // Fresh metadata-document cache rows: `resolveCimdClient` serves them.
  for (const [clientId, callback] of [
    [STUDIO, STUDIO_CB],
    [NOTES, "https://notes.example.com/cb"],
  ]) {
    await q(
      `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
         requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, created_at)
       values ($1, 'cimd', 'Content Studio', $2, '{}', $3, '{}', now(), now() + interval '1 hour', now())`,
      [clientId, [callback], [READ, CREATE]]
    );
  }
  // The one foreign key the GC relies on (0305: a key's grants go with it);
  // the harness DDL above declares none.
  await q(
    `alter table grants add foreign key (api_key_id) references api_keys(id) on delete cascade`
  );
}, 120_000);

const HUMAN_CTX = { authenticated: true, userId: OWNER } as never;

/** The consent click → the code it redirects with. */
async function consent(
  approved: Array<{ permission: string; workspaceId: string }>
): Promise<string> {
  const { redirectTo } = await decideOAuthAuthorization(
    {
      clientId: STUDIO,
      redirectUri: STUDIO_CB,
      responseType: "code",
      scope: `${READ} ${CREATE}`,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      state: "st",
      approve: true,
      approved,
    },
    OWNER,
    HUMAN_CTX
  );
  return new URL(redirectTo).searchParams.get("code")!;
}

async function tokenRequest(
  params: Record<string, string>
): Promise<{ status: number; body: any }> {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.json() };
}

/** Consent + the code exchange: the first access + refresh token pair. */
async function connect(
  approved: Array<{ permission: string; workspaceId: string }> = [
    { permission: READ, workspaceId: BRAND },
  ]
): Promise<{ access: string; refresh: string; body: any }> {
  const code = await consent(approved);
  const { status, body } = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: STUDIO,
    redirect_uri: STUDIO_CB,
    code_verifier: VERIFIER,
  });
  expect(status).toBe(200);
  expect(typeof body.refresh_token).toBe("string");
  return { access: body.access_token, refresh: body.refresh_token, body };
}

const refresh = (refreshToken: string, clientId = STUDIO) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

const revokeRequest = (params: Record<string, string>) =>
  oauthApp.request("/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

const valid = async (token: string) =>
  (await apiKeyService.validateApiKey(token)) !== null;

const connection = async () =>
  (
    await q<{ id: string; public_id: string; agent_user_id: string }>(
      `select id, public_id, agent_user_id from apps where owner_user_id = $1 and oauth_client_id = $2`,
      [OWNER, STUDIO]
    )
  ).rows[0]!;

const refreshRows = async () =>
  (
    await q<{
      id: string;
      family_id: string;
      last_used_at: string | null;
      revoked_at: string | null;
      replaced_by: string | null;
      expires_at: Date;
    }>(
      `select id, family_id, last_used_at, revoked_at, replaced_by, expires_at
         from oauth_refresh_tokens where app_id = $1 order by created_at, id`,
      [(await connection()).id]
    )
  ).rows;

const liveRefreshRows = async () =>
  (await refreshRows()).filter((r) => !r.revoked_at && !r.last_used_at);

const keyGrants = async (token: string) => {
  const record = await apiKeyService.validateApiKey(token);
  expect(record).not.toBeNull();
  return (
    await q<{ workspace_ids: string[] }>(
      `select workspace_ids from grants where api_key_id = $1 and revoked_at is null order by workspace_ids`,
      [record!.id]
    )
  ).rows.map((g) => g.workspace_ids);
};

describe("R1 — rotation: each refresh token works once, and its successor carries on", () => {
  it("a refresh answers a new access + refresh token; the used one is refused; the old key stops", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({
      token_type: "Bearer",
      scope: READ,
      synap_grant: [
        { permission: READ, workspaceId: BRAND, workspaceName: "Brand" },
      ],
      synap_user: { id: OWNER, name: "Ada" },
    });
    expect(r1.body.expires_in).toBeGreaterThan(3590);
    expect(r1.body.expires_in).toBeLessThanOrEqual(3600);
    expect(r1.body.refresh_token).not.toBe(first.refresh);
    expect(r1.body.access_token).not.toBe(first.access);
    expect(await valid(first.access)).toBe(false);
    expect(await valid(r1.body.access_token)).toBe(true);

    // The chain goes on: the successor works once too.
    const r2 = await refresh(r1.body.refresh_token);
    expect(r2.status).toBe(200);
    expect(await valid(r1.body.access_token)).toBe(false);
    expect(await valid(r2.body.access_token)).toBe(true);

    // One family, linked: each used token names its successor.
    const [live] = await liveRefreshRows();
    const family = (await refreshRows()).filter(
      (r) => r.family_id === live!.family_id
    );
    expect(family).toHaveLength(3);
    const byId = new Map(family.map((r) => [r.id, r]));
    const head = family.find(
      (r) => !family.some((other) => other.replaced_by === r.id)
    )!;
    const chain = [head];
    while (chain.at(-1)!.replaced_by) {
      chain.push(byId.get(chain.at(-1)!.replaced_by!)!);
    }
    expect(chain.map((r) => r.id)).toHaveLength(3);
    expect(chain.at(-1)!.id).toBe(live!.id);
    expect(chain.map((r) => !!r.last_used_at)).toEqual([true, true, false]);
  });

  it("a refresh token is bound to its client: another pod app is refused and the token is not spent", async () => {
    const { refresh: rt, access } = await connect();
    const other = await refresh(rt, NOTES);
    expect(other.status).toBe(400);
    expect(other.body.error).toBe("invalid_grant");
    // Not a reuse, not consumed: its own client still refreshes.
    expect(await valid(access)).toBe(true);
    expect((await refresh(rt)).status).toBe(200);
  });

  it("an MCP (DCR) client is refused the refresh grant (unauthorized_client)", async () => {
    const res = await oauthApp.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [MCP_CB], client_name: "Claude" }),
    });
    const { client_id } = (await res.json()) as { client_id: string };
    const refused = await refresh("anything", client_id);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("unauthorized_client");
  });
});

describe("R2 — reuse of a used token revokes its whole family and the live key", () => {
  it("replaying a rotated token: invalid_grant, the successor is dead, the live access key is dead", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    expect(r1.status).toBe(200);
    expect(await valid(r1.body.access_token)).toBe(true);

    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(replay.body).not.toHaveProperty("access_token");

    // The family is dead, including the successor nobody reused…
    expect(await liveRefreshRows()).toEqual([]);
    const next = await refresh(r1.body.refresh_token);
    expect(next.status).toBe(400);
    expect(next.body.error).toBe("invalid_grant");
    // …and so is the access key the successor came with.
    expect(await valid(r1.body.access_token)).toBe(false);
  });
});

describe("R3 — a concurrent redeem of the same token: one wins, no family revoke", () => {
  it("two refreshes at once: exactly one 200; the winner's successor still works", async () => {
    const { refresh: rt } = await connect();
    const [a, b] = await Promise.all([refresh(rt), refresh(rt)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(loser.body.error).toBe("invalid_grant");
    // Not treated as a theft: the family lives on.
    expect(await valid(winner.body.access_token)).toBe(true);
    const next = await refresh(winner.body.refresh_token);
    expect(next.status).toBe(200);
  });
});

describe("R4 — a revoked app gets no key", () => {
  it("revokeApp revokes the connection's refresh tokens; a refresh after it is invalid_grant", async () => {
    const { refresh: rt } = await connect();
    const app = await connection();
    await revokeApp({ publicId: app.public_id, ownerUserId: OWNER });
    // Revoked by the revoke itself, not only refused by the mint.
    expect(await liveRefreshRows()).toEqual([]);
    expect((await refreshRows()).every((r) => r.revoked_at !== null)).toBe(
      true
    );
    const after = await refresh(rt);
    expect(after.status).toBe(400);
    expect(after.body.error).toBe("invalid_grant");
    expect(after.body).not.toHaveProperty("access_token");
  });

  it("an app revoked by any door (no token revoke) is refused at refresh by the mint", async () => {
    const { refresh: rt } = await connect();
    const app = await connection();
    await q(`update apps set revoked_at = now() where id = $1`, [app.id]);
    const after = await refresh(rt);
    expect(after.status).toBe(400);
    expect(after.body.error).toBe("invalid_grant");
    await q(`update apps set revoked_at = null where id = $1`, [app.id]);
  });
});

describe("a family revoked while a refresh is minting", () => {
  it("the successor is refused and the key that refresh minted is revoked", async () => {
    const { refresh: rt } = await connect();
    // The refresh grant's three steps, with the app revoked between the mint
    // and the successor (the window a concurrent revoke can hit).
    const redeemed = await redeemRefreshToken(rt, STUDIO);
    const minted = await mintAppOAuthAccessKey({
      appId: redeemed.appId,
      ownerUserId: redeemed.userId,
      oauthClientId: redeemed.clientId,
      instanceId: `oauth:${STUDIO}:${OWNER}`,
    });
    expect(await valid(minted.accessToken)).toBe(true);
    await revokeConnectionRefreshTokens(redeemed.appId);
    await expect(rotateRefreshToken(redeemed)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(minted.accessToken)).toBe(false);
  });
});

describe("R5 — the refreshed key carries the CURRENT approval", () => {
  it("after the person narrows the app, the next refresh mints the narrower key", async () => {
    const { refresh: rt, access } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    expect((await keyGrants(access)).flat().sort()).toEqual(
      [BRAND, SHARED].sort()
    );
    // The person narrows it on the consent screen; the app never redeems
    // that code, it only refreshes.
    await consent([{ permission: READ, workspaceId: BRAND }]);
    const after = await refresh(rt);
    expect(after.status).toBe(200);
    expect(await keyGrants(after.body.access_token)).toEqual([[BRAND]]);
    expect(after.body.synap_grant).toEqual([
      { permission: READ, workspaceId: BRAND, workspaceName: "Brand" },
    ]);
  });

  it("the approval is the source, never the previous key: narrowed in the row alone, the refresh still narrows", async () => {
    const { refresh: rt, access } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    // A door that changes the approval without re-deriving the live key: the
    // key in hand still reaches both spaces.
    const app = await connection();
    await q(`update apps set approved_requests = $1::jsonb where id = $2`, [
      JSON.stringify([{ permission: READ, workspaceId: SHARED }]),
      app.id,
    ]);
    expect((await keyGrants(access)).flat().sort()).toEqual(
      [BRAND, SHARED].sort()
    );
    const after = await refresh(rt);
    expect(after.status).toBe(200);
    expect(await keyGrants(after.body.access_token)).toEqual([[SHARED]]);
  });
});

describe("R6 — 30-day idle expiry, no absolute cap", () => {
  it("a token idle past its 30 days is invalid_grant and mints nothing", async () => {
    const { refresh: rt } = await connect();
    const app = await connection();
    await q(
      `update oauth_refresh_tokens set expires_at = now() - interval '1 second'
         where app_id = $1 and revoked_at is null and last_used_at is null`,
      [app.id]
    );
    const keysBefore = (
      await q(`select id from api_keys where user_id = $1`, [app.agent_user_id])
    ).rows.length;
    const after = await refresh(rt);
    expect(after.status).toBe(400);
    expect(after.body.error).toBe("invalid_grant");
    const keysAfter = (
      await q(`select id from api_keys where user_id = $1`, [app.agent_user_id])
    ).rows.length;
    expect(keysAfter).toBe(keysBefore);
  });

  it("each refresh restarts the 30 days (idle, not absolute)", async () => {
    const { refresh: rt } = await connect();
    const app = await connection();
    // The family is old: its token was issued 29 days ago.
    await q(
      `update oauth_refresh_tokens set expires_at = now() + interval '1 day'
         where app_id = $1 and revoked_at is null and last_used_at is null`,
      [app.id]
    );
    const after = await refresh(rt);
    expect(after.status).toBe(200);
    const [live] = await liveRefreshRows();
    expect(new Date(live!.expires_at).getTime()).toBeGreaterThan(
      Date.now() + 29.9 * DAY_MS
    );
  });
});

describe("/revoke (RFC 7009) accepts a refresh token", () => {
  it("with token_type_hint=refresh_token: the family and the live access key stop", async () => {
    const { refresh: rt, access } = await connect();
    const res = await revokeRequest({
      token: rt,
      token_type_hint: "refresh_token",
      client_id: STUDIO,
    });
    expect(res.status).toBe(200);
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(access)).toBe(false);
    expect((await refresh(rt)).body.error).toBe("invalid_grant");
  });

  it("without a hint, and by another client (refused, kept)", async () => {
    const { refresh: rt, access } = await connect();
    const wrong = await revokeRequest({ token: rt, client_id: NOTES });
    expect(wrong.status).toBe(400);
    expect(await valid(access)).toBe(true);
    const res = await revokeRequest({ token: rt });
    expect(res.status).toBe(200);
    expect(await valid(access)).toBe(false);
    expect(await liveRefreshRows()).toEqual([]);
  });
});

describe("one live family per connection", () => {
  it("a new authorization code ends the connection's previous family", async () => {
    const old = await connect();
    const fresh = await connect();
    expect((await refresh(old.refresh)).body.error).toBe("invalid_grant");
    const next = await refresh(fresh.refresh);
    expect(next.status).toBe(200);
    expect(await liveRefreshRows()).toHaveLength(1);
  });
});

describe("GC — a refreshed connection does not grow without bound", () => {
  it("dead keys of the connection's slot are swept to the bound; expired refresh rows are deleted", async () => {
    let { refresh: rt } = await connect();
    const app = await connection();
    // An expired, long-dead family of this connection.
    await q(
      `insert into oauth_refresh_tokens (id, token_hash, family_id, client_id, user_id, app_id, expires_at, revoked_at, created_at)
       values ($1, $2, $3, $4, $5, $6, now() - interval '1 day', now() - interval '20 days', now() - interval '31 days')`,
      [randomUUID(), `old-${randomUUID()}`, randomUUID(), STUDIO, OWNER, app.id]
    );
    for (let i = 0; i < 6; i++) {
      const r = await refresh(rt);
      expect(r.status).toBe(200);
      rt = r.body.refresh_token;
    }
    const keys = (
      await q<{ is_active: boolean }>(
        `select is_active from api_keys where user_id = $1`,
        [app.agent_user_id]
      )
    ).rows;
    expect(keys.filter((k) => k.is_active)).toHaveLength(1);
    expect(keys.length).toBeLessThanOrEqual(1 + APP_OAUTH_DEAD_KEYS_KEPT);
    // Grants go with their keys.
    const orphanGrants = await q(
      `select g.id from grants g left join api_keys k on k.id = g.api_key_id where k.id is null`
    );
    expect(orphanGrants.rows).toEqual([]);
    // No row past its expiry is left for this connection.
    expect(
      (await refreshRows()).filter(
        (r) => new Date(r.expires_at).getTime() < Date.now()
      )
    ).toEqual([]);
  });
});

describe("the refresh token's plaintext lives only in the /token response", () => {
  it("is in no table row, no event, no audit call", async () => {
    const { refresh: rt } = await connect();
    const r = await refresh(rt);
    for (const material of [rt, r.body.refresh_token as string]) {
      expect(material.length).toBeGreaterThanOrEqual(43);
      expect(JSON.stringify(h.events)).not.toContain(material);
      expect(JSON.stringify(h.audits)).not.toContain(material);
      let scanned = 0;
      for (const t of tableNames) {
        const rows = (
          await q<{ r: string }>(`select t::text as r from "${t}" t`)
        ).rows;
        scanned += rows.length;
        for (const { r: row } of rows) expect(row).not.toContain(material);
      }
      expect(scanned).toBeGreaterThan(10);
    }
    // Non-vacuity: the rows are there, as hashes.
    expect((await refreshRows()).length).toBeGreaterThan(0);
  });
});
