/**
 * Pod app sign-in (spec 17, wave PB2) — the invariants, end to end on PGlite.
 *
 * A pod app is an OAuth client identified by its metadata document (CIMD). The
 * chain driven here is the REAL one: the consent context
 * (`getOAuthConsentContext`) → the consent click (`decideOAuthAuthorization`
 * → `connectOAuthApp`: file the `app/connect` proposal and approve it through
 * the ONE approve door, `applyProposalApproval` → the `app/connect` executor)
 * → the code → `POST /token` over HTTP (`oauthApp`, which mints through
 * `mintAppOAuthAccessKey`) → `apiKeyService.validateApiKey` +
 * `resolveKeyIdentity` (what every key-auth door runs) → the write gate in
 * decision-only mode (`previewPermissionDecision`) → `revokeApp` and
 * `POST /revoke`.
 *
 * The app's document is a FRESH `oauth_clients` cache row, so
 * `resolveCimdClient` reads it without a fetch (the fetch is pinned in
 * client-metadata.test.ts).
 *
 * Seams replaced, and why: the event store (`EventRepository`) and `auditLog`
 * write through the postgres-js client this harness has not — both are
 * recorders. `createPendingProposal`'s insert likewise runs on that client; its
 * row lands in PGlite unchanged.
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
    // The consent files inside a transaction (no notification): the insert
    // runs on that transaction, as the real door does — a PGlite transaction
    // holds the one connection, so a write outside it would wait forever.
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
import { runWithActingAgent, runWithGrant } from "@synap/database";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import { oauthApp } from "../routers/oauth/routes.js";
import {
  decideOAuthAuthorization,
  getOAuthConsentContext,
} from "../routers/oauth/consent.js";
import { previewPermissionDecision } from "../utils/permission-check.js";
import { resolveKeyIdentity } from "../access/key-identity.js";
import { apiKeyService } from "./api-keys.js";
import { reapplyAgentKeyGrants } from "./agent-identity-service.js";
import { revokeApp } from "./app-connect.js";

const ISSUER = "https://pod.test.synap.live";
const STUDIO = "https://studio.example.com/.well-known/synap-client.json";
const STUDIO_CB = "https://studio.example.com/api/synap/callback";
const NOTES = "https://notes.example.com/.well-known/synap-client.json";
const NOTES_CB = "https://notes.example.com/cb";
const SYNAP_APP =
  "https://content-studio.synap.live/.well-known/synap-client.json";
const SYNAP_APP_CB = "https://content-studio.synap.live/cb";

const OWNER = "human-owner";
const OTHER = "human-other";
const AGENT = randomUUID();
const BRAND = randomUUID(); // OWNER owns it
const SHARED = randomUUID(); // OWNER is an editor
const VIEWING = randomUUID(); // OWNER is a viewer
const ELSEWHERE = randomUUID(); // OWNER is no member; OTHER owns it
const ARCHIVED = randomUUID(); // OWNER owns it, archived

const VERIFIER = "v".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
const READ = "entity.post.read";
const CREATE = "entity.post.create";

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

/** A fresh cache row: `resolveCimdClient` serves it without fetching. */
async function cacheApp(
  clientId: string,
  callback: string,
  name: string,
  templates: string[] = []
) {
  await q(
    `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
       requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, created_at)
     values ($1, 'cimd', $2, $3, '{}', $4, $5, now(), now() + interval '1 hour', now())
     on conflict (client_id) do nothing`,
    [clientId, name, [callback], [READ, CREATE], templates]
  );
}

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      await h.client!.exec(ddlFor(value));
      tableNames.push(getTableConfig(value).name);
    }
  }
  for (const [id, email] of [
    [OWNER, "owner@x"],
    [OTHER, "other@x"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, email, id === OWNER ? "Ada" : "Bo"]
    );
  }
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type, created_via)
     values ($1, 'agent@x', 'agent', $2, 'claude-code', 'cli')`,
    [AGENT, OWNER]
  );
  const spaces: Array<[string, string, string]> = [
    [BRAND, "Brand", OWNER],
    [SHARED, "Shared", OTHER],
    [VIEWING, "Viewing", OTHER],
    [ELSEWHERE, "Elsewhere", OTHER],
  ];
  for (const [id, name, owner] of spaces) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      id,
      name,
      owner,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, owner]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, archived_at) values ($1, 'Archived', $2, now())`,
    [ARCHIVED, OWNER]
  );
  for (const [ws, role] of [
    [SHARED, "editor"],
    [VIEWING, "viewer"],
  ]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), ws, OWNER, role]
    );
  }
  // A pod-wide `post` kind (the create gate refuses an unknown kind first),
  // and the pod default (0282): agents act on reversible writes. Seeded on
  // purpose — under it a plain agent EXECUTES; the app's agent must propose.
  await q(
    `insert into profiles (id, slug, scope, is_active, origin) values ($1, 'post', 'system', true, 'system')`,
    [randomUUID()]
  );
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1, 'any', 'pod', 'action', $2, 'auto', 'system:reversible-default')`,
    [randomUUID(), REVERSIBLE_CLASS_PATTERN]
  );
  await cacheApp(STUDIO, STUDIO_CB, "Content Studio", ["content-studio"]);
  await cacheApp(NOTES, NOTES_CB, "Content Studio");
  await cacheApp(SYNAP_APP, SYNAP_APP_CB, "Content Studio");
}, 120_000);

const HUMAN_CTX = (userId: string, extra: Record<string, unknown> = {}) =>
  ({ authenticated: true, userId, ...extra }) as never;

const params = (clientId: string, callback: string, scope: string) => ({
  clientId,
  redirectUri: callback,
  responseType: "code",
  scope,
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
  state: "st",
});

/** The consent click → the code it redirects with. */
async function consent(
  approved: Array<{ permission: string; workspaceId: string }>,
  opts: {
    user?: string;
    clientId?: string;
    callback?: string;
    scope?: string;
    ctx?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const user = opts.user ?? OWNER;
  const { redirectTo } = await decideOAuthAuthorization(
    {
      ...params(
        opts.clientId ?? STUDIO,
        opts.callback ?? STUDIO_CB,
        opts.scope ?? `${READ} ${CREATE}`
      ),
      approve: true,
      approved,
    },
    user,
    HUMAN_CTX(user, opts.ctx)
  );
  const back = new URL(redirectTo);
  expect(back.searchParams.get("iss")).toBe(ISSUER);
  return back.searchParams.get("code")!;
}

async function redeem(
  code: string,
  clientId = STUDIO,
  callback = STUDIO_CB
): Promise<{ status: number; body: any }> {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: callback,
      code_verifier: VERIFIER,
    }).toString(),
  });
  return { status: res.status, body: await res.json() };
}

/** Consent + /token: the access token and the key row behind it. */
async function connect(
  approved: Array<{ permission: string; workspaceId: string }>,
  opts: Parameters<typeof consent>[1] = {}
) {
  const code = await consent(approved, opts);
  const { status, body } = await redeem(
    code,
    opts.clientId ?? STUDIO,
    opts.callback ?? STUDIO_CB
  );
  expect(status).toBe(200);
  const record = await apiKeyService.validateApiKey(body.access_token);
  expect(record).not.toBeNull();
  return { token: body.access_token as string, body, record: record! };
}

const appRow = async (owner: string, clientId: string) =>
  (
    await q<{
      id: string;
      public_id: string;
      mode: string;
      agent_user_id: string | null;
      approved_requests: unknown;
      revoked_at: string | null;
    }>(
      `select id, public_id, mode, agent_user_id, approved_requests, revoked_at from apps where owner_user_id = $1 and oauth_client_id = $2`,
      [owner, clientId]
    )
  ).rows[0];

const liveGrantsOf = async (keyId: string) =>
  (
    await q<{ permissions: string[]; workspace_ids: string[] | null }>(
      `select permissions, workspace_ids from grants where api_key_id = $1 and revoked_at is null order by workspace_ids`,
      [keyId]
    )
  ).rows.map((g) => ({
    permissions: [...g.permissions].sort(),
    workspaceIds: g.workspace_ids,
  }));

const countProposals = async () =>
  (await q(`select id from proposals where target_type = 'app'`)).rows.length;
const countCodes = async () =>
  (await q(`select code_hash from oauth_authorization_codes`)).rows.length;
const countApproved = async () =>
  (
    await q(
      `select id from proposals where target_type = 'app' and status = 'approved'`
    )
  ).rows.length;

/**
 * The two refusals of WHO decides, each pinned to the layer that throws it.
 * A request carrying an acting agent or a key's grant (any key door) stops at
 * the consent door's own person-only gate (`decideOAuthAuthorization`,
 * oauth/consent.ts), before the caller is even looked up. An agent named only
 * on the request context gets past that gate and stops at the connect's owner
 * floor (`assertOwnerCredential`, app-connect.ts), before anything is filed.
 */
const PERSON_ONLY_REFUSAL = {
  code: "FORBIDDEN",
  message: "Only a person signed in to this pod can authorize a connection.",
};
const AGENT_CREDENTIAL_REFUSAL = (act: string) => ({
  code: "FORBIDDEN",
  message: `An agent credential cannot ${act} — sign in as the app's owner.`,
});

describe("the consent screen shows the app as its domain, and what it may be given where", () => {
  it("an unverified app: domain headline, the spaces per permission (writes only where the person may write)", async () => {
    const ctx = await getOAuthConsentContext(
      params(STUDIO, STUDIO_CB, `${READ} ${CREATE} mcp.read`),
      OWNER
    );
    expect(ctx.clientKind).toBe("cimd");
    expect(ctx.app).toMatchObject({
      domain: "studio.example.com",
      verified: false,
      templates: ["content-studio"],
    });
    const offer = Object.fromEntries(
      ctx.app!.permissions.map((p) => [
        p.permission,
        p.workspaces.map((w) => w.workspaceName),
      ])
    );
    // Reads: every space the person reads. Writes: owned or editor, never
    // the space they only view, never one they are not in. Never an
    // archived space.
    expect(offer[READ]).toEqual(["Brand", "Shared", "Viewing"]);
    expect(offer[CREATE]).toEqual(["Brand", "Shared"]);
  });

  it("a Synap app (exact https://content-studio.synap.live origin) shows verified", async () => {
    const ctx = await getOAuthConsentContext(
      params(SYNAP_APP, SYNAP_APP_CB, READ),
      OWNER
    );
    expect(ctx.app?.verified).toBe(true);
  });

  it("a person with no space to give a write sees an empty offer for it (the screen states it)", async () => {
    const ctx = await getOAuthConsentContext(
      params(STUDIO, STUDIO_CB, CREATE),
      "human-without-spaces"
    );
    // No reason in this app's document: null (the consent contract).
    expect(ctx.app!.permissions).toEqual([
      { permission: CREATE, workspaces: [], reason: null },
    ]);
  });
});

describe("I2 — the key is exactly the consented subset; narrowing works, widening is refused", () => {
  it("narrowed to one permission in one space: the key carries exactly that, for 1 h, read-only scope", async () => {
    const { body, record } = await connect([
      { permission: READ, workspaceId: BRAND },
    ]);
    expect(await liveGrantsOf(record.id)).toEqual([
      { permissions: [READ], workspaceIds: [BRAND] },
    ]);
    expect(record.scope).toEqual(["hub-protocol.read"]);
    expect(body.scope).toBe(READ);
    expect(body.synap_grant).toEqual([
      { permission: READ, workspaceId: BRAND, workspaceName: "Brand" },
    ]);
    expect(body.synap_user).toEqual({ id: OWNER, name: "Ada" });
    const ttl = (new Date(record.expiresAt!).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);

    // The consent is a durable record: an app/connect proposal the PERSON
    // filed and approved, with the pod's offer frozen as `asked`.
    const row = await appRow(OWNER, STUDIO);
    const [proposal] = (
      await q<{ status: string; reviewed_by: string; data: any }>(
        `select status, reviewed_by, data from proposals where target_id = $1 order by created_at desc limit 1`,
        [row!.id]
      )
    ).rows;
    expect(proposal).toMatchObject({ status: "approved", reviewed_by: OWNER });
    expect(proposal!.data.asked).toEqual(
      expect.arrayContaining([
        { permission: CREATE, workspaceId: SHARED },
        { permission: READ, workspaceId: VIEWING },
      ])
    );
  });

  it("two permissions in two spaces: one grant per space, never their cross product", async () => {
    const { record } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: CREATE, workspaceId: SHARED },
    ]);
    const grants = await liveGrantsOf(record.id);
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        { permissions: [READ], workspaceIds: [BRAND] },
        { permissions: [CREATE], workspaceIds: [SHARED] },
      ])
    );
    expect(record.scope).toEqual(["hub-protocol.read", "hub-protocol.write"]);
  });

  const tampered: Array<[string, { permission: string; workspaceId: string }]> =
    [
      [
        "a write where the person is only a viewer",
        { permission: CREATE, workspaceId: VIEWING },
      ],
      [
        "a space the person is not in",
        { permission: READ, workspaceId: ELSEWHERE },
      ],
      [
        "a permission the app never asked for",
        { permission: "entity.post.delete", workspaceId: BRAND },
      ],
      ["a full-access *", { permission: "*", workspaceId: BRAND }],
      ["an unknown space id", { permission: READ, workspaceId: randomUUID() }],
    ];
  for (const [name, extra] of tampered) {
    it(`a tampered consent POST adding ${name} is refused: nothing filed, no code, no reach`, async () => {
      const before = {
        proposals: await countProposals(),
        codes: await countCodes(),
      };
      const approvedBefore = (await appRow(OWNER, STUDIO))?.approved_requests;
      await expect(
        consent([{ permission: READ, workspaceId: BRAND }, extra])
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await countProposals()).toBe(before.proposals);
      expect(await countCodes()).toBe(before.codes);
      expect((await appRow(OWNER, STUDIO))?.approved_requests).toEqual(
        approvedBefore
      );
    });
  }

  it("an empty selection is refused (Allow needs at least one space)", async () => {
    await expect(consent([])).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("re-consent narrowing narrows the LIVE key at once, without a new token", async () => {
    const { token, record } = await connect([
      { permission: READ, workspaceId: BRAND },
      { permission: READ, workspaceId: SHARED },
    ]);
    expect(await liveGrantsOf(record.id)).toHaveLength(2);
    // The same person consents again, ticking less (no /token call).
    await consent([{ permission: READ, workspaceId: BRAND }]);
    expect(await liveGrantsOf(record.id)).toEqual([
      { permissions: [READ], workspaceIds: [BRAND] },
    ]);
    expect((await apiKeyService.validateApiKey(token))?.id).toBe(record.id);
    // The app's agent leaves the space it no longer reaches.
    const agent = (await appRow(OWNER, STUDIO))!.agent_user_id!;
    const spaces = (
      await q<{ workspace_id: string }>(
        `select workspace_id from workspace_members where user_id = $1`,
        [agent]
      )
    ).rows.map((r) => r.workspace_id);
    expect(spaces).toEqual([BRAND]);
  });
});

describe("I3 — per-app identity: the key is the app's own agent's, for this person", () => {
  it("the key resolves as the app's ask-first agent acting for the person, attributed to the app", async () => {
    const { record } = await connect([
      { permission: READ, workspaceId: BRAND },
    ]);
    const row = (await appRow(OWNER, STUDIO))!;
    expect(row.mode).toBe("oauth");
    const [agent] = (
      await q<{ user_type: string; agent_type: string }>(
        `select user_type, agent_type from users where id = $1`,
        [row.agent_user_id]
      )
    ).rows;
    expect(agent).toEqual({ user_type: "agent", agent_type: row.public_id });
    expect(agent!.agent_type).not.toMatch(/^claude-web/);
    expect(record.userId).toBe(row.agent_user_id);
    expect(record.linkedUserId).toBe(OWNER);
    const id = await resolveKeyIdentity(record);
    expect(id).toMatchObject({
      isAgent: true,
      agentUserId: row.agent_user_id,
      effectiveUserId: OWNER,
    });
    expect(id.grant?.clientId).toBe(row.public_id);
    expect(id.grant?.scopes.some((s) => s.permissions.includes("*"))).toBe(
      false
    );
  });

  it("two apps for one person get two distinct agents", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    await connect([{ permission: READ, workspaceId: BRAND }], {
      clientId: NOTES,
      callback: NOTES_CB,
    });
    const a = (await appRow(OWNER, STUDIO))!;
    const b = (await appRow(OWNER, NOTES))!;
    expect(a.id).not.toBe(b.id);
    expect(a.agent_user_id).toBeTruthy();
    expect(b.agent_user_id).toBeTruthy();
    expect(a.agent_user_id).not.toBe(b.agent_user_id);
  });

  it("the same app for two people gets two distinct rows and agents", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    const { record } = await connect(
      [{ permission: READ, workspaceId: SHARED }],
      { user: OTHER }
    );
    const mine = (await appRow(OWNER, STUDIO))!;
    const theirs = (await appRow(OTHER, STUDIO))!;
    expect(mine.id).not.toBe(theirs.id);
    expect(mine.agent_user_id).not.toBe(theirs.agent_user_id);
    expect(record.linkedUserId).toBe(OTHER);
  });

  it("tripwire: re-applying agent capabilities never widens an app agent's key", async () => {
    const { record } = await connect([
      { permission: READ, workspaceId: BRAND },
    ]);
    const agent = (await appRow(OWNER, STUDIO))!.agent_user_id!;
    expect(
      await reapplyAgentKeyGrants({ agentUserId: agent, createdBy: OWNER })
    ).toBe(0);
    expect(await liveGrantsOf(record.id)).toEqual([
      { permissions: [READ], workspaceIds: [BRAND] },
    ]);
  });
});

describe("I4 — the app's writes are governed (ask-first); consent never sets auto-apply", () => {
  it("a write inside the consented reach is PROPOSED; outside it is refused", async () => {
    const { record } = await connect([
      { permission: CREATE, workspaceId: SHARED },
    ]);
    const id = await resolveKeyIdentity(record);
    const decide = (workspaceId: string) =>
      runWithGrant(id.grant!, () =>
        previewPermissionDecision({
          userId: id.effectiveUserId,
          agentUserId: id.agentUserId,
          workspaceId,
          subjectType: "entity",
          action: "create",
          data: { profileSlug: "post", title: "Launch" },
        } as Parameters<typeof previewPermissionDecision>[0])
      );
    expect(await decide(SHARED)).toEqual({ decision: "propose" });
    expect(await decide(BRAND)).toMatchObject({ decision: "deny" });
    // The posture the agent was given before it was linked: propose, only.
    const verdicts = (
      await q<{ verdict: string }>(
        `select verdict from governance_rules where agent_user_id = $1 and revoked_at is null`,
        [id.agentUserId]
      )
    ).rows.map((r) => r.verdict);
    expect(verdicts.length).toBeGreaterThan(0);
    expect(new Set(verdicts)).toEqual(new Set(["propose"]));
  });

  it("CONTROL: a plain agent under the same pod default executes", async () => {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor') on conflict do nothing`,
      [randomUUID(), SHARED, AGENT]
    );
    const r = await previewPermissionDecision({
      userId: OWNER,
      agentUserId: AGENT,
      workspaceId: SHARED,
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "post", title: "Launch" },
    } as Parameters<typeof previewPermissionDecision>[0]);
    expect(r).toEqual({ decision: "execute" });
  });
});

describe("the agent-approver floor — an agent caller never approves a consent", () => {
  const refusedAs = async (
    run: () => Promise<unknown>,
    refusal: { code: string; message: string }
  ) => {
    const before = {
      proposals: await countProposals(),
      codes: await countCodes(),
      approved: await countApproved(),
    };
    await expect(run()).rejects.toMatchObject(refusal);
    // No code minted, nothing filed, nothing approved.
    expect(await countCodes()).toBe(before.codes);
    expect(await countProposals()).toBe(before.proposals);
    expect(await countApproved()).toBe(before.approved);
  };

  it("an agent key's context (ctx.agentUserId) is refused", async () => {
    await refusedAs(
      () =>
        consent([{ permission: READ, workspaceId: BRAND }], {
          ctx: { agentUserId: AGENT },
        }),
      AGENT_CREDENTIAL_REFUSAL("connect an app")
    );
  });

  it("an acting agent in the request ALS (a key door's shape) is refused", async () => {
    await refusedAs(
      () =>
        runWithActingAgent(AGENT, () =>
          consent([{ permission: READ, workspaceId: BRAND }])
        ),
      PERSON_ONLY_REFUSAL
    );
  });

  it("the Intelligence Service's internal key is refused", async () => {
    await refusedAs(
      () =>
        consent([{ permission: READ, workspaceId: BRAND }], {
          ctx: { keyType: "is_internal" },
        }),
      AGENT_CREDENTIAL_REFUSAL("connect an app")
    );
  });
});

describe("T4 — the app's own token can never re-consent, widen or end itself", () => {
  it("a consent, a revoke or a mint run AS the app's key is refused", async () => {
    const { record } = await connect([
      { permission: READ, workspaceId: BRAND },
    ]);
    const id = await resolveKeyIdentity(record);
    const row = (await appRow(OWNER, STUDIO))!;
    const asApp = <T>(fn: () => Promise<T>) =>
      runWithActingAgent(id.agentUserId!, () => runWithGrant(id.grant!, fn));
    const before = {
      proposals: await countProposals(),
      codes: await countCodes(),
      approved: await countApproved(),
    };
    await expect(
      asApp(() => consent([{ permission: CREATE, workspaceId: BRAND }]))
    ).rejects.toMatchObject(PERSON_ONLY_REFUSAL);
    await expect(
      asApp(() => revokeApp({ publicId: row.public_id, ownerUserId: OWNER }))
    ).rejects.toMatchObject(AGENT_CREDENTIAL_REFUSAL("revoke an app"));
    // No code minted, nothing filed, nothing approved.
    expect(await countCodes()).toBe(before.codes);
    expect(await countProposals()).toBe(before.proposals);
    expect(await countApproved()).toBe(before.approved);
    // Still connected, still exactly what was consented.
    expect((await appRow(OWNER, STUDIO))!.revoked_at).toBeNull();
    expect(await liveGrantsOf(record.id)).toEqual([
      { permissions: [READ], workspaceIds: [BRAND] },
    ]);
  });
});

describe("I6 — revocation is immediate", () => {
  it("revokeApp: a token that validated (and is cached) is refused at once; the agent leaves every space", async () => {
    const { token, record } = await connect([
      { permission: READ, workspaceId: BRAND },
    ]);
    expect((await apiKeyService.validateApiKey(token))?.id).toBe(record.id);
    const row = (await appRow(OWNER, STUDIO))!;
    await revokeApp({ publicId: row.public_id, ownerUserId: OWNER });
    expect(await apiKeyService.validateApiKey(token)).toBeNull();
    expect(await liveGrantsOf(record.id)).toEqual([]);
    expect(
      (
        await q(`select id from workspace_members where user_id = $1`, [
          row.agent_user_id,
        ])
      ).rows
    ).toEqual([]);
  });

  it("revokeApp burns a code still waiting: it redeems to nothing", async () => {
    const code = await consent([{ permission: READ, workspaceId: BRAND }]);
    const row = (await appRow(OWNER, STUDIO))!;
    await revokeApp({ publicId: row.public_id, ownerUserId: OWNER });
    // Burned by the revoke itself, not only refused at /token.
    const waiting = await q(
      `select code_hash from oauth_authorization_codes where app_id = $1 and consumed_at is null`,
      [row.id]
    );
    expect(waiting.rows).toEqual([]);
    const { status, body } = await redeem(code);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(body).not.toHaveProperty("access_token");
  });

  it("/token refuses a code whose app was revoked by any door (the mint checks, not only the burn)", async () => {
    const code = await consent([{ permission: READ, workspaceId: BRAND }]);
    const row = (await appRow(OWNER, STUDIO))!;
    // Revoked without the burn (a revoke door that knows nothing of codes).
    await q(`update apps set revoked_at = now() where id = $1`, [row.id]);
    const { status, body } = await redeem(code);
    expect(status).toBe(400);
    expect(body.error).toBe("invalid_grant");
    expect(body).not.toHaveProperty("access_token");
    await q(`update apps set revoked_at = null where id = $1`, [row.id]);
  });

  it("re-consent after a revoke revives the connection, re-approved from scratch", async () => {
    const { record } = await connect([
      { permission: READ, workspaceId: SHARED },
    ]);
    const row = (await appRow(OWNER, STUDIO))!;
    expect(row.revoked_at).toBeNull();
    expect(row.approved_requests).toEqual([
      { permission: READ, workspaceId: SHARED },
    ]);
    expect(await liveGrantsOf(record.id)).toEqual([
      { permissions: [READ], workspaceIds: [SHARED] },
    ]);
  });

  it("POST /revoke with the token (RFC 7009) retires it at once", async () => {
    const { token } = await connect([{ permission: READ, workspaceId: BRAND }]);
    const res = await oauthApp.request("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: STUDIO }).toString(),
    });
    expect(res.status).toBe(200);
    expect(await apiKeyService.validateApiKey(token)).toBeNull();
  });

  it("a new token rotates the connection's key: the previous one stops", async () => {
    const first = await connect([{ permission: READ, workspaceId: BRAND }]);
    const second = await connect([{ permission: READ, workspaceId: BRAND }]);
    expect(await apiKeyService.validateApiKey(first.token)).toBeNull();
    expect((await apiKeyService.validateApiKey(second.token))?.id).toBe(
      second.record.id
    );
  });
});

describe("the token's plaintext lives only in the /token response", () => {
  it("is in no table row, no event, no audit call", async () => {
    const eventsBefore = h.events.length;
    const { token, record } = await connect([
      { permission: READ, workspaceId: BRAND },
    ]);
    const material = token.slice(token.lastIndexOf("_") + 1);
    expect(material).toMatch(/^[0-9a-f]{64}$/);
    // Non-vacuity: the mint emitted.
    expect(
      h.events
        .slice(eventsBefore)
        .some((e) => JSON.stringify(e).includes(record.id))
    ).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain(material);
    expect(JSON.stringify(h.audits)).not.toContain(material);
    let scanned = 0;
    for (const t of tableNames) {
      const rows = (await q<{ r: string }>(`select t::text as r from "${t}" t`))
        .rows;
      scanned += rows.length;
      for (const { r } of rows) expect(r).not.toContain(material);
    }
    expect(scanned).toBeGreaterThan(10);
  });
});
