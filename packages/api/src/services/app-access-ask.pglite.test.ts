/**
 * An app asks for ONE MORE thing (plan 647ebfd4 option C, founder 16 Nov
 * 2026) — end to end on PGlite, through the REAL chain: consent
 * (`decideOAuthAuthorization` → `connectOAuthApp`) → the code → `POST /token`
 * → the app's person token at the REAL Hub doors (`POST /apps/access-requests`,
 * `GET /apps/access-requests/:id`) behind a stand-in for the hub auth door that
 * resolves the bearer as the real one does (`validateApiKey` →
 * `resolveKeyIdentity`) → the REAL approve door (`applyProposalApproval` → the
 * `app/connect` executor, `mode: "add"`).
 *
 * Each row rules out a wrong implementation, and each was seen red with its
 * fix reverted (negative control on the same devbox job):
 *  - MERGE: two asks approved one after the other keep every pair (an
 *    executor that replaces, or that merges into the approval as it stood at
 *    filing, drops one);
 *  - UNDECLARED: a permission the document does not declare is refused with
 *    ASK_NOT_DECLARED and files nothing, at the Hub door and at /authorize;
 *  - REACH: a pair in a space the person cannot give it in (a viewer asked to
 *    write) is refused with ASK_NOT_ON_OFFER; and a document narrowed between
 *    the ask and the tap refuses the approval (the executor re-checks the
 *    ceiling, not only the person's role);
 *  - STEP-UP: a Synap app's device session approves only after a fresh
 *    authentication (`widensCredential`);
 *  - QUIET: a declined pair is not asked again for 30 days; then it is;
 *  - ASKABLE: a write the grant refuses, for a permission the app declares,
 *    carries `askable: true` and the pair; an undeclared one does not;
 *  - the short consent (`synap_ask`) ADDS: what the app held stays.
 *
 * Seams replaced, as in pod-app.connections.pglite.test.ts: the event store
 * and `auditLog` (recorders), `createPendingProposal` (inserts on the given
 * transaction, `expiresAt` kept), `isPodAdmin`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

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
  class RecordingEventRepository {
    constructor(_sql?: unknown) {}
    async append(event: unknown) {
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

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => false,
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
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
          expiresAt: input.expiresAt ?? null,
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
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { runWithGrant, type KeyGrant } from "@synap/database";
import * as schema from "@synap/database/schema";
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import { oauthApp } from "../routers/oauth/routes.js";
import {
  decideOAuthAuthorization,
  getOAuthConsentContext,
} from "../routers/oauth/consent.js";
import { applyProposalApproval } from "../routers/proposals/apply-approval.js";
import { registerAppsRoutes } from "../routers/hub-protocol/rest/apps.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";
import { grantDenialCodeMiddleware } from "../routers/hub-protocol/_middleware/grant-denial-code.js";
import { grantWriteDenial } from "../utils/grant-write-check.js";
import { apiKeyService } from "./api-keys.js";
import { resolveKeyIdentity } from "../access/key-identity.js";

const ISSUER = "https://pod.test.synap.live";
const STUDIO = "https://studio.example.com/.well-known/synap-client.json";
const STUDIO_CB = "https://studio.example.com/api/synap/callback";

const OWNER = "human-owner";
const MEMBER = "human-member";
const OTHER = "human-other";
const BRAND = randomUUID();
const CONTENT = randomUUID();
const TEAM = randomUUID();

const VERIFIER = "v".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);
const READ = "entity.post.read";
const CREATE = "entity.post.create";
const NOTE_READ = "entity.note.read";
const UNDECLARED = "entity.task.read";
const DECLARED = [READ, CREATE, NOTE_READ];

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
  h.client!.query<T>(sql, params).then((r) => r.rows);

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://pod-admin.test.synap.live";
  delete process.env.POD_ADMIN_DOMAIN;
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const [id, email, name] of [
    [OWNER, "owner@x", "Ada"],
    [MEMBER, "member@x", "Bo"],
    [OTHER, "other@x", "Cy"],
  ]) {
    await q(
      `insert into users (id, email, name, user_type) values ($1, $2, $3, 'human')`,
      [id, email, name]
    );
  }
  for (const [id, name, owner, template] of [
    [BRAND, "Brand", OWNER, "brand-library"],
    [CONTENT, "Content OS", OWNER, "content-os"],
    [TEAM, "Team", OTHER, null],
  ]) {
    await q(
      `insert into workspaces (id, name, owner_id, package_slug) values ($1, $2, $3, $4)`,
      [id, name, owner, template]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, owner]
    );
  }
  // OWNER edits in Team (someone else's space); MEMBER only reads Brand.
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
    [randomUUID(), TEAM, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'viewer')`,
    [randomUUID(), BRAND, MEMBER]
  );
  await q(
    `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
       requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, metadata_sha256, created_at)
     values ($1, 'cimd', 'Content Studio', $2, '{}', $3, '{}', now(), now() + interval '1 hour', $4, now())`,
    [
      STUDIO,
      [STUDIO_CB],
      DECLARED,
      createHash("sha256").update(`${STUDIO}#1`).digest("hex"),
    ]
  );
  await q(
    `alter table grants add foreign key (api_key_id) references api_keys(id) on delete cascade`
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from pod_settings`);
  // Not a proof-of-presence suite (presence.pglite.test.ts owns the gate).
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
  // Each test starts from no connection and no ask.
  await q(`delete from proposals`);
  await q(`delete from apps`);
  await q(
    `update oauth_clients set requested_permissions = $1 where client_id = $2`,
    [DECLARED, STUDIO]
  );
  await q(
    `update workspace_members set role = 'editor' where workspace_id = $1 and user_id = $2`,
    [TEAM, OWNER]
  );
});

type Pair = { permission: string; workspaceId: string };

const ctxOf = (userId: string, extra: Record<string, unknown> = {}) =>
  ({
    authenticated: true,
    userId,
    session: { id: "s" },
    ...extra,
  }) as never;

function authorizeParams(synapAsk?: string) {
  return {
    clientId: STUDIO,
    redirectUri: STUDIO_CB,
    responseType: "code",
    scope: DECLARED.join(" "),
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    state: "st",
    ...(synapAsk ? { synapAsk } : {}),
  };
}

async function connect(
  approved: Pair[],
  userId = OWNER,
  synapAsk?: string
): Promise<string> {
  const { redirectTo } = await decideOAuthAuthorization(
    { ...authorizeParams(synapAsk), approve: true, approved },
    userId,
    ctxOf(userId)
  );
  const code = new URL(redirectTo).searchParams.get("code")!;
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: STUDIO,
      redirect_uri: STUDIO_CB,
      code_verifier: VERIFIER,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

const approval = async (owner = OWNER) =>
  (
    await q<{ approved_requests: Pair[] | null; public_id: string }>(
      `select approved_requests, public_id from apps where owner_user_id = $1 and oauth_client_id = $2`,
      [owner, STUDIO]
    )
  )[0]!;

const pairsOf = (rows: Pair[] | null) =>
  (rows ?? []).map((r) => `${r.permission}@${r.workspaceId}`).sort();

/** The hub auth door as these routes read it (see the connections suite). */
function hubApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer /, "");
    const rec = bearer ? await apiKeyService.validateApiKey(bearer) : null;
    if (!rec) return c.json({ error: "Unauthenticated" }, 401);
    const identity = await resolveKeyIdentity(rec).catch(() => null);
    if (!identity) return c.json({ error: "Unauthenticated" }, 401);
    c.set("userId", identity.effectiveUserId);
    if (identity.agentUserId) c.set("agentUserId", identity.agentUserId);
    c.set("apiKeyId", rec.id);
    c.set("keyType", rec.keyType);
    c.set("scopes", rec.scope ?? []);
    await runWithGrant(identity.grant, () => next());
    return undefined;
  });
  registerAppsRoutes(app);
  return app;
}

async function ask(
  token: string,
  requests: Array<
    { permission: string } & ({ workspaceId: string } | { template: string })
  >
): Promise<{ status: number; body: any }> {
  const res = await hubApp().request("/apps/access-requests", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requests, reason: "To publish your essays" }),
  });
  return { status: res.status, body: await res.json() };
}

async function readAsk(token: string, id: string) {
  const res = await hubApp().request(`/apps/access-requests/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function approve(proposalId: string, ctx = ctxOf(OWNER)) {
  const row = await (h.db as any).query.proposals.findFirst({
    where: (p: any, { eq }: any) => eq(p.id, proposalId),
  });
  return applyProposalApproval({
    proposal: row,
    userId: OWNER,
    input: { proposalId },
    ctx,
  });
}

describe("MERGE — an approval only adds", () => {
  it("two asks approved one after the other keep every pair", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const first = await ask(token, [
      { permission: CREATE, workspaceId: BRAND },
    ]);
    const second = await ask(token, [
      { permission: NOTE_READ, template: "content-os" },
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Both filed before either is approved: an executor that merged into
    // the approval as it stood at FILING would drop the first one here.
    await approve(first.body.id);
    await approve(second.body.id);
    expect(pairsOf((await approval()).approved_requests)).toEqual(
      [
        `${READ}@${BRAND}`,
        `${CREATE}@${BRAND}`,
        `${NOTE_READ}@${CONTENT}`,
      ].sort()
    );
    // The app reads its answer instead of asking again.
    expect((await readAsk(token, first.body.id)).body.status).toBe("allowed");
  });

  it("the short consent (synap_ask) adds to what the app holds", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    const context = await getOAuthConsentContext(
      authorizeParams(`${NOTE_READ}@content-os`),
      OWNER
    );
    expect(context.app!.ask!.pairs).toEqual([
      {
        permission: NOTE_READ,
        workspaceId: CONTENT,
        workspaceName: "Content OS",
      },
    ]);
    expect(context.app!.ask!.title).toBe(
      "Content Studio asks to read notes in Content OS"
    );
    await connect(
      [{ permission: NOTE_READ, workspaceId: CONTENT }],
      OWNER,
      `${NOTE_READ}@content-os`
    );
    expect(pairsOf((await approval()).approved_requests)).toEqual(
      [`${READ}@${BRAND}`, `${NOTE_READ}@${CONTENT}`].sort()
    );
  });

  it("the short consent gives only what was asked", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    await expect(
      decideOAuthAuthorization(
        {
          ...authorizeParams(`${NOTE_READ}@content-os`),
          approve: true,
          approved: [
            { permission: NOTE_READ, workspaceId: CONTENT },
            { permission: CREATE, workspaceId: CONTENT },
          ],
        },
        OWNER,
        ctxOf(OWNER)
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(pairsOf((await approval()).approved_requests)).toEqual([
      `${READ}@${BRAND}`,
    ]);
  });
});

describe("UNDECLARED — an app asks only for what its document declares", () => {
  it("the Hub door refuses an undeclared permission and files nothing", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const r = await ask(token, [
      { permission: UNDECLARED, workspaceId: BRAND },
    ]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ASK_NOT_DECLARED");
    expect(
      await q(`select id from proposals where status = 'pending'`)
    ).toEqual([]);
  });

  it("/authorize sends an undeclared synap_ask back to the app", async () => {
    const res = await oauthApp.request(
      `/authorize?${new URLSearchParams({
        client_id: STUDIO,
        redirect_uri: STUDIO_CB,
        response_type: "code",
        scope: READ,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        synap_ask: `${UNDECLARED}@content-os`,
      })}`
    );
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(STUDIO_CB);
    expect(to.searchParams.get("error")).toBe("invalid_request");
  });
});

describe("REACH — never beyond what the person may give", () => {
  it("a viewer's connection cannot ask to write in that space", async () => {
    const token = await connect(
      [{ permission: READ, workspaceId: BRAND }],
      MEMBER
    );
    const r = await ask(token, [{ permission: CREATE, workspaceId: BRAND }]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ASK_NOT_ON_OFFER");
  });

  it("a document narrowed after the ask refuses the approval", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const r = await ask(token, [{ permission: CREATE, workspaceId: TEAM }]);
    expect(r.status).toBe(201);
    // The app stops declaring it; the person's role in Team is unchanged.
    await q(
      `update oauth_clients set requested_permissions = $1 where client_id = $2`,
      [[READ, NOTE_READ], STUDIO]
    );
    await expect(approve(r.body.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(pairsOf((await approval()).approved_requests)).toEqual([
      `${READ}@${BRAND}`,
    ]);
  });

  it("a role dropped after the ask refuses the approval", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const r = await ask(token, [{ permission: CREATE, workspaceId: TEAM }]);
    await q(
      `update workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2`,
      [TEAM, OWNER]
    );
    await expect(approve(r.body.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("STEP-UP — a device session approves only after a fresh sign-in", () => {
  it("a stale device session is refused; a fresh one approves", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const r = await ask(token, [{ permission: CREATE, workspaceId: BRAND }]);
    const device = (authTime: Date) =>
      ctxOf(OWNER, {
        sessionKind: "person_device",
        session: { id: "s", device: { id: "dev-1", authTime } },
      });
    await expect(
      approve(r.body.id, device(new Date(Date.now() - 60 * 60 * 1000)))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(pairsOf((await approval()).approved_requests)).toEqual([
      `${READ}@${BRAND}`,
    ]);
    await approve(r.body.id, device(new Date()));
    expect(pairsOf((await approval()).approved_requests)).toContain(
      `${CREATE}@${BRAND}`
    );
  });
});

describe("QUIET — one open ask per pair; Not now keeps it quiet", () => {
  it("dedupes, stays quiet 30 days after Not now, then asks again", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const first = await ask(token, [
      { permission: CREATE, workspaceId: BRAND },
      { permission: READ, workspaceId: BRAND },
    ]);
    expect(first.body.pairs.map((p: any) => [p.permission, p.state])).toEqual([
      [CREATE, "asked"],
      [READ, "given"],
    ]);
    const again = await ask(token, [
      { permission: CREATE, workspaceId: BRAND },
    ]);
    expect(again.status).toBe(200);
    expect(again.body.id).toBeNull();
    expect(again.body.pairs[0]).toMatchObject({
      state: "open",
      askId: first.body.id,
    });

    // The person answers "Not now".
    await q(
      `update proposals set status = 'rejected', reviewed_by = $2, reviewed_at = now() where id = $1`,
      [first.body.id, OWNER]
    );
    expect((await readAsk(token, first.body.id)).body.status).toBe("declined");
    const quiet = await ask(token, [
      { permission: CREATE, workspaceId: BRAND },
    ]);
    expect(quiet.body.id).toBeNull();
    expect(quiet.body.pairs[0]).toMatchObject({
      state: "quiet",
      askId: first.body.id,
    });

    // 31 days later it may ask again.
    await q(
      `update proposals set reviewed_at = now() - interval '31 days' where id = $1`,
      [first.body.id]
    );
    const later = await ask(token, [
      { permission: CREATE, workspaceId: BRAND },
    ]);
    expect(later.status).toBe(201);
    expect(later.body.pairs[0].state).toBe("asked");
  });

  it("an ask unanswered for 7 days expires and cannot be approved", async () => {
    const token = await connect([{ permission: READ, workspaceId: BRAND }]);
    const r = await ask(token, [{ permission: CREATE, workspaceId: BRAND }]);
    await q(
      `update proposals set expires_at = now() - interval '1 minute' where id = $1`,
      [r.body.id]
    );
    expect((await readAsk(token, r.body.id)).body.status).toBe("expired");
    await expect(approve(r.body.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("an app reads only its own asks", async () => {
    const owner = await connect([{ permission: READ, workspaceId: BRAND }]);
    const r = await ask(owner, [{ permission: CREATE, workspaceId: BRAND }]);
    const member = await connect(
      [{ permission: READ, workspaceId: BRAND }],
      MEMBER
    );
    expect((await readAsk(member, r.body.id)).status).toBe(404);
  });
});

describe("ASKABLE — a refusal says when it can be asked for", () => {
  function denialApp(grant: KeyGrant) {
    const a = new Hono();
    a.use("/*", grantDenialCodeMiddleware);
    a.post("/:kind", async (c) =>
      c.json(
        {
          error: await runWithGrant(grant, () =>
            grantWriteDenial({
              subjectType: "entity",
              action: "create",
              workspaceId: CONTENT,
              data: { profileSlug: c.req.param("kind") },
            })
          ),
        },
        403
      )
    );
    return a;
  }

  it("a declared write carries askable and the pair; an undeclared one does not", async () => {
    await connect([{ permission: READ, workspaceId: BRAND }]);
    const { public_id } = await approval();
    const grant: KeyGrant = {
      scopes: [
        {
          permissions: [READ],
          workspaceIds: [BRAND],
          projectIds: null,
          entityIds: null,
        },
      ],
      clientId: public_id,
    } as never;
    const post = await denialApp(grant).request("/post", { method: "POST" });
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({
      code: "GRANT_DENIED",
      askable: true,
      ask: { permission: CREATE, workspaceId: CONTENT },
    });
    const task = await denialApp(grant).request("/task", { method: "POST" });
    const body = (await task.json()) as Record<string, unknown>;
    expect(body.code).toBe("GRANT_DENIED");
    expect(body.askable).toBeUndefined();
  });
});
