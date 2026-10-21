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
 * revoked, R3 concurrent redeem ⇒ no family revoke, R4 revoked app
 * ⇒ invalid_grant, R5 narrowed approval ⇒ narrower key, R6 30-day idle
 * expiry; plus /revoke with a refresh token, one live family per connection,
 * the GC bound, and the token's plaintext living only in the response.
 * PB3b: the reuse grace (a replay by the same client within 30 s gets the
 * same pair; past it, a used successor, another client, a revoked app: no).
 *
 * Seams replaced, and why: the event store (`EventRepository`) and `auditLog`
 * write through the postgres-js client this harness has not — both are
 * recorders. `createPendingProposal` inserts on the transaction it is given.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";

// Before refresh.ts loads: its successor key derives from JWT_SECRET (PB3b).
vi.hoisted(() => {
  process.env.JWT_SECRET ||= "pb3b-test-jwt-secret";
});

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
  REFRESH_REUSE_GRACE_MAX_SECONDS,
  REFRESH_SUCCESSOR_WAIT_MS,
  RefreshTokenReuseError,
  confirmGraceSuccessor,
  redeemRefreshToken,
  refreshReuseGraceMs,
  revokeConnectionRefreshTokens,
  rotateRefreshToken,
  successorAccessToken,
  successorRefreshToken,
  withinReuseGrace,
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

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Move a used token's use `seconds` into the past (the grace clock). */
const usedSecondsAgo = (raw: string, seconds: number) =>
  q(
    `update oauth_refresh_tokens set last_used_at = now() - $2::int * interval '1 second'
       where token_hash = $1 and last_used_at is not null`,
    [sha256(raw), seconds]
  );

const liveAgentKeys = async () =>
  (
    await q<{ id: string }>(
      `select id from api_keys where user_id = $1 and is_active = true`,
      [(await connection()).agent_user_id]
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

describe("R2 — reuse of a used token, past the reuse grace, revokes its whole family and the live key", () => {
  it("replaying a rotated token 31 s after its use: invalid_grant, the successor is dead, the live access key is dead", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    expect(r1.status).toBe(200);
    expect(await valid(r1.body.access_token)).toBe(true);

    // PB3b: within 30 s the same client would get the same pair back.
    await usedSecondsAgo(first.refresh, 31);
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

describe("R3 — a concurrent redeem of the same token: one rotation, no family revoke", () => {
  it("two refreshes at once: both 200 with the SAME pair (PB3b grace); that successor still works", async () => {
    const { refresh: rt } = await connect();
    const [a, b] = await Promise.all([refresh(rt), refresh(rt)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // One rotation, answered twice: whichever copy the app keeps works.
    expect(b.body.refresh_token).toBe(a.body.refresh_token);
    expect(b.body.access_token).toBe(a.body.access_token);
    // Not treated as a theft: the family lives on.
    expect(await valid(a.body.access_token)).toBe(true);
    expect(await liveRefreshRows()).toHaveLength(1);
    const next = await refresh(a.body.refresh_token);
    expect(next.status).toBe(200);
  });

  it("outside the grace (OAUTH_REFRESH_REUSE_GRACE_SECONDS=0): the loser is refused, nothing revoked", async () => {
    process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS = "0";
    try {
      const { refresh: rt } = await connect();
      const [a, b] = await Promise.all([refresh(rt), refresh(rt)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 400]);
      const winner = a.status === 200 ? a : b;
      expect(await valid(winner.body.access_token)).toBe(true);
      expect((await refresh(winner.body.refresh_token)).status).toBe(200);
    } finally {
      delete process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS;
    }
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
    // A pod app's token: owned by its connection, never a device (0340).
    const appId = redeemed.appId!;
    const minted = await mintAppOAuthAccessKey({
      appId,
      ownerUserId: redeemed.userId,
      oauthClientId: redeemed.clientId,
      instanceId: `oauth:${STUDIO}:${OWNER}`,
    });
    expect(await valid(minted.accessToken)).toBe(true);
    await revokeConnectionRefreshTokens(appId);
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
    // The reuse grace (PB3b) answers the same pair, re-derived, not stored.
    const again = await refresh(rt);
    expect(again.status).toBe(200);
    expect(again.body.refresh_token).toBe(r.body.refresh_token);
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

describe("PB3b — the reuse grace: the same client, within 30 s, gets the same pair", () => {
  it("a replay right after the rotation: 200, the same refresh + access token, no revoke, nothing extended", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    expect(r1.status).toBe(200);
    const [successor] = await liveRefreshRows();
    // The pair is the one the successor's id re-derives.
    expect(successorRefreshToken(successor!.id)).toBe(r1.body.refresh_token);
    expect(successorAccessToken(successor!.id)).toBe(r1.body.access_token);
    const keyRow = async () =>
      (
        await q<{ id: string; expires_at: Date; is_active: boolean }>(
          `select id, expires_at, is_active from api_keys where key_lookup_hash = $1`,
          [sha256(r1.body.access_token)]
        )
      ).rows;
    const [keyBefore] = await keyRow();
    expect(keyBefore!.is_active).toBe(true);

    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(200);
    expect(replay.body.refresh_token).toBe(r1.body.refresh_token);
    expect(replay.body.access_token).toBe(r1.body.access_token);
    expect(replay.body.synap_grant).toEqual(r1.body.synap_grant);
    expect(replay.body.expires_in).toBeLessThanOrEqual(r1.body.expires_in);

    // The SAME key row (its stored hash matches the re-derived token), its
    // 1 h expiry untouched: the grace never extends it.
    const after = await keyRow();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(keyBefore!.id);
    expect(new Date(after[0]!.expires_at).getTime()).toBe(
      new Date(keyBefore!.expires_at).getTime()
    );
    expect(
      (await apiKeyService.validateApiKey(replay.body.access_token))!.id
    ).toBe(keyBefore!.id);

    // No family revoke, no second key, no new successor, no longer expiry.
    expect(await valid(r1.body.access_token)).toBe(true);
    expect(await liveAgentKeys()).toHaveLength(1);
    const live = await liveRefreshRows();
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(successor!.id);
    expect(new Date(live[0]!.expires_at).getTime()).toBe(
      new Date(successor!.expires_at).getTime()
    );
    // The pair both callers hold carries on.
    const next = await refresh(r1.body.refresh_token);
    expect(next.status).toBe(200);
    expect(await valid(next.body.access_token)).toBe(true);
  });

  it("the window is half-open: 29.999 s is a grace, 30 s exactly is a reuse", () => {
    const usedAt = new Date("2026-10-21T12:00:00.000Z");
    const t = usedAt.getTime();
    expect(withinReuseGrace(usedAt, t, 30_000)).toBe(true);
    expect(withinReuseGrace(usedAt, t + 29_999, 30_000)).toBe(true);
    expect(withinReuseGrace(usedAt, t + 30_000, 30_000)).toBe(false);
    expect(withinReuseGrace(usedAt, t + 30_001, 30_000)).toBe(false);
    expect(withinReuseGrace(usedAt, t, 0)).toBe(false);
  });

  it("a replay 30 s after the use: a reuse — family and live key revoked", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    await usedSecondsAgo(first.refresh, 30);
    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(r1.body.access_token)).toBe(false);
  });

  it("29 s after the use is still within the grace", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    await usedSecondsAgo(first.refresh, 29);
    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(200);
    expect(replay.body.refresh_token).toBe(r1.body.refresh_token);
  });

  it("within the grace but the successor was already used: a reuse — family and live key revoked", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const r2 = await refresh(r1.body.refresh_token);
    expect(r2.status).toBe(200);

    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(replay.body).not.toHaveProperty("access_token");
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(r2.body.access_token)).toBe(false);
  });

  it("within the grace but the successor was already used: the redeem itself is a reuse, no grace handed out", async () => {
    // Pinned at redeemRefreshToken: through /token, confirmGraceSuccessor
    // would also catch the spent successor, so the end state alone cannot
    // show that the grace check refuses it first.
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const r2 = await refresh(r1.body.refresh_token);
    expect(r2.status).toBe(200);

    await expect(
      redeemRefreshToken(first.refresh, STUDIO)
    ).rejects.toBeInstanceOf(RefreshTokenReuseError);
    expect(await liveRefreshRows()).toEqual([]);
  });

  it("within the grace from another client: no grace — a spent token elsewhere is a reuse, family and live key revoked", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const foreign = await refresh(first.refresh, NOTES);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("invalid_grant");
    expect(foreign.body).not.toHaveProperty("refresh_token");
    expect(foreign.body).not.toHaveProperty("access_token");
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(r1.body.access_token)).toBe(false);
  });

  it("a refresh naming another resource is invalid_target and spends nothing; this pod's resource is accepted", async () => {
    const first = await connect();
    const evil = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh,
      client_id: STUDIO,
      resource: "https://evil.example.com/mcp",
    });
    expect(evil.status).toBe(400);
    expect(evil.body.error).toBe("invalid_target");
    expect(await liveRefreshRows()).toHaveLength(1);
    const ours = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh,
      client_id: STUDIO,
      resource: `${ISSUER}/mcp`,
    });
    expect(ours.status).toBe(200);
  });

  it("the successor derivation is domain-separated: its own key (not JWT_SECRET as-is), one label per credential", () => {
    const secret = process.env.JWT_SECRET!;
    expect(secret).toBeTruthy();
    const id = randomUUID();
    const key = createHmac("sha256", secret)
      .update("oauth-refresh-successor")
      .digest();
    const mac = (k: Buffer | string, label: string) =>
      createHmac("sha256", k).update(`${label}|${id}`).digest();
    expect(successorRefreshToken(id)).toBe(
      mac(key, "refresh").toString("base64url")
    );
    expect(
      successorAccessToken(id).endsWith(mac(key, "access").toString("hex"))
    ).toBe(true);
    // Not the raw JWT_SECRET, and the two credentials never share a MAC.
    expect(successorRefreshToken(id)).not.toBe(
      mac(secret, "refresh").toString("base64url")
    );
    const refreshMac = Buffer.from(successorRefreshToken(id), "base64url");
    expect(successorAccessToken(id)).not.toContain(refreshMac.toString("hex"));
  });

  it("within the grace after revokeApp: invalid_grant, no token", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const app = await connection();
    await revokeApp({ publicId: app.public_id, ownerUserId: OWNER });
    for (const rt of [first.refresh, r1.body.refresh_token as string]) {
      const after = await refresh(rt);
      expect(after.status).toBe(400);
      expect(after.body.error).toBe("invalid_grant");
      expect(after.body).not.toHaveProperty("access_token");
    }
  });

  it("within the grace, an app revoked by any door (tokens untouched) or emptied: invalid_grant", async () => {
    const first = await connect();
    await refresh(first.refresh);
    const app = await connection();
    await q(`update apps set revoked_at = now() where id = $1`, [app.id]);
    const revoked = await refresh(first.refresh);
    expect(revoked.status).toBe(400);
    expect(revoked.body.error).toBe("invalid_grant");
    expect(revoked.body).not.toHaveProperty("access_token");
    await q(`update apps set revoked_at = null where id = $1`, [app.id]);

    const before = await q<{ approved_requests: unknown }>(
      `select approved_requests from apps where id = $1`,
      [app.id]
    );
    await q(`update apps set approved_requests = '[]'::jsonb where id = $1`, [
      app.id,
    ]);
    const emptied = await refresh(first.refresh);
    expect(emptied.status).toBe(400);
    expect(emptied.body.error).toBe("invalid_grant");
    expect(emptied.body).not.toHaveProperty("access_token");
    await q(`update apps set approved_requests = $1::jsonb where id = $2`, [
      JSON.stringify(before.rows[0]!.approved_requests),
      app.id,
    ]);
  });

  it("the grace never reaches more than the CURRENT approval: narrowed in the row alone, the key handed back is narrowed", async () => {
    const first = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    const r1 = await refresh(first.refresh);
    expect((await keyGrants(r1.body.access_token)).flat().sort()).toEqual(
      [BRAND, SHARED].sort()
    );
    const app = await connection();
    await q(`update apps set approved_requests = $1::jsonb where id = $2`, [
      JSON.stringify([{ permission: READ, workspaceId: SHARED }]),
      app.id,
    ]);
    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(200);
    expect(replay.body.synap_grant).toEqual([
      { permission: READ, workspaceId: SHARED, workspaceName: "Shared" },
    ]);
    expect(await keyGrants(replay.body.access_token)).toEqual([[SHARED]]);
  });

  it("a write approved since: the read-only key is not handed back, one is minted in the same slot", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const app = await connection();
    await q(`update apps set approved_requests = $1::jsonb where id = $2`, [
      JSON.stringify([
        { permission: READ, workspaceId: BRAND },
        { permission: CREATE, workspaceId: BRAND },
      ]),
      app.id,
    ]);
    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(200);
    expect(replay.body.refresh_token).toBe(r1.body.refresh_token);
    expect(replay.body.access_token).not.toBe(r1.body.access_token);
    expect(await liveAgentKeys()).toHaveLength(1);
    expect(await valid(replay.body.access_token)).toBe(true);
  });

  it("a successor not re-derivable (issued before PB3b, random): no grace, the PB3 reuse rule", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const [successor] = await liveRefreshRows();
    await q(`update oauth_refresh_tokens set token_hash = $1 where id = $2`, [
      sha256(`random-${randomUUID()}`),
      successor!.id,
    ]);
    const replay = await refresh(first.refresh);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(r1.body.access_token)).toBe(false);
  });

  it("the successor spent between the grace check and the answer: refused as a reuse", async () => {
    const first = await connect();
    const r1 = await refresh(first.refresh);
    const redeemed = await redeemRefreshToken(first.refresh, STUDIO);
    expect(redeemed.grace?.refreshToken).toBe(r1.body.refresh_token);
    const r2 = await refresh(r1.body.refresh_token);
    expect(r2.status).toBe(200);
    await expect(
      confirmGraceSuccessor({ ...redeemed, grace: redeemed.grace! })
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await liveRefreshRows()).toEqual([]);
    expect(await valid(r2.body.access_token)).toBe(false);
  });

  it("a replay while the first redeem is still minting waits for its successor", async () => {
    const { refresh: rt } = await connect();
    const redeemed = await redeemRefreshToken(rt, STUDIO);
    const replay = refresh(rt);
    const successorId = randomUUID();
    const minted = await mintAppOAuthAccessKey({
      appId: redeemed.appId!,
      ownerUserId: redeemed.userId,
      oauthClientId: redeemed.clientId,
      instanceId: `oauth:${STUDIO}:${OWNER}`,
      plainKey: successorAccessToken(successorId),
    });
    const successor = await rotateRefreshToken(redeemed, successorId);
    const answered = await replay;
    expect(answered.status).toBe(200);
    expect(answered.body.refresh_token).toBe(successor);
    expect(answered.body.access_token).toBe(minted.accessToken);
  });

  it(
    "a replay whose first redeem issues no successor in time: refused, nothing revoked",
    async () => {
      const { refresh: rt } = await connect();
      await redeemRefreshToken(rt, STUDIO);
      // This test's family only: the file shares one connection, and each
      // connect() ends the earlier tests' families (startRefreshFamily).
      const live = (await refreshRows()).filter((r) => r.revoked_at === null);
      expect(live).toHaveLength(1);
      const familyId = live[0]!.family_id;
      const startedAt = Date.now();
      const replay = await refresh(rt);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        REFRESH_SUCCESSOR_WAIT_MS - 200
      );
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
      const family = (await refreshRows()).filter(
        (r) => r.family_id === familyId
      );
      expect(family.length).toBeGreaterThan(0);
      expect(family.every((r) => r.revoked_at === null)).toBe(true);
    },
    REFRESH_SUCCESSOR_WAIT_MS + 10_000
  );

  it("OAUTH_REFRESH_REUSE_GRACE_SECONDS: overrides the 30 s, capped at 60, 0 turns it off", async () => {
    expect(refreshReuseGraceMs({})).toBe(30_000);
    expect(
      refreshReuseGraceMs({ OAUTH_REFRESH_REUSE_GRACE_SECONDS: "45" })
    ).toBe(45_000);
    expect(
      refreshReuseGraceMs({ OAUTH_REFRESH_REUSE_GRACE_SECONDS: "600" })
    ).toBe(REFRESH_REUSE_GRACE_MAX_SECONDS * 1000);
    expect(REFRESH_REUSE_GRACE_MAX_SECONDS).toBe(60);
    expect(
      refreshReuseGraceMs({ OAUTH_REFRESH_REUSE_GRACE_SECONDS: "0" })
    ).toBe(0);
    for (const unreadable of ["", "soon", "-5"]) {
      expect(
        refreshReuseGraceMs({ OAUTH_REFRESH_REUSE_GRACE_SECONDS: unreadable })
      ).toBe(30_000);
    }

    process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS = "0";
    try {
      const first = await connect();
      const r1 = await refresh(first.refresh);
      const replay = await refresh(first.refresh);
      expect(replay.status).toBe(400);
      expect(await valid(r1.body.access_token)).toBe(false);
    } finally {
      delete process.env.OAUTH_REFRESH_REUSE_GRACE_SECONDS;
    }
  });
});
