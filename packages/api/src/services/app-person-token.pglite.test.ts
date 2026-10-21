/**
 * "Sign in with Synap" (founder A1, 2026-10-20) — a person's own token for an
 * app the pod approved, end to end on PGlite through the REAL doors:
 *
 *   owner-only `setAppRedirectUris` → OAuth `GET /authorize` (Hono, real) →
 *   `getOAuthConsentContext` / `decideOAuthAuthorization` (the consent
 *   procedures' services) → `POST /token` (real) → `mintAppPersonToken` (the
 *   one mint door: `apiKeyService.generateApiKey` + `attachGrantsOrRevoke`) →
 *   the token presented to the REAL Hub auth door (`hubAuthMiddleware`: key
 *   lookup, `resolveKeyIdentity`, W1 fence, `runWithGrant`) → the real write
 *   gate (`checkPermissionOrPropose`), the real `GET /entities` read seam, the
 *   real answer door and the real approval door (`applyProposalApproval`).
 *
 * The person signing in is the pod OWNER, who may do EVERYTHING by role in
 * every space — so every refusal below is the token's grant, never the role.
 * A second person (MEMBER, editor of Sales only) shows the grant narrowed to
 * what the person can reach.
 *
 * Rows that rule out a wrong rule (threats: services/app-person-token.ts):
 *  (a) the token is HELD BY THE PERSON and NOT adopted onto the app's agent;
 *      a write in-grant is GRANTED (direct) where the app's own agent key
 *      PROPOSES the same write — the discriminating control; approve and
 *      answer pass in-grant;
 *  (b) outside the grant (Marketing: owner may write by role; Finance: read
 *      only) the write, the approval and the answer are refused, and reads
 *      return only in-grant rows;
 *  (c) a self-registered (DCR) client registering the SAME redirect URI
 *      still mints through the agent door — never a person token;
 *  (d) a hand-made person key naming the app is still ADOPTED (0313); one of
 *      the person type held by an agent resolves as the agent; one bound to
 *      another app is refused;
 *  (e) an app not approved / with no redirect URI / revoked signs no one in;
 *  (f) code replay, a wrong PKCE verifier and a redirect mismatch are refused;
 *  T5  an approval widened after consent does not widen the token; one
 *      narrowed after mint narrows it; a rotation of the app's key keeps the
 *      person signed in; revoking the app ends the sign-in.
 *
 * Mocked: audit log; the guest check and sub-token mapping (constant answers);
 * the agent door's `provisionSurfaceAgentKey` (spied for the DCR control); the
 * key repository insert used by `issueKey` (its event emit runs on the
 * postgres-js client this harness has not — the row lands in PGlite as is).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  provision: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  class PgliteApiKeyRepository {
    async create(input: Record<string, unknown>) {
      const [row] = await (h.db as any)
        .insert(schema.apiKeys)
        .values({
          keyName: input.keyName,
          keyPrefix: input.keyPrefix,
          keyHash: `hash-${randomUUID()}`,
          keyLookupHash: createHash("sha256")
            .update(String(input.key))
            .digest("hex"),
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
    // The CP registry read the DCR door makes runs on the postgres-js client;
    // no approved Control Plane here, so every DCR client is a direct one.
    TrustedIssuerService: class {
      list() {
        return Promise.resolve([]);
      }
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: async () => false,
}));
vi.mock("./external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: async () => null,
}));
vi.mock("./agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  provisionSurfaceAgentKey: async (args: Record<string, unknown>) => {
    h.provision.push(args);
    return {
      agentUserId: "dcr-agent",
      alreadyValid: false,
      registration: { outcome: "CONNECTED_VERIFIED" },
      apiKey: { expiresAt: new Date(Date.now() + 90 * 86_400_000) },
      plainKey: "synap_user_dcr_agent_key",
      keyId: "dcr-key",
    };
  },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  AppRepository,
  getRequestGrant,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
// Registers the grant read provider (as the API does at load).
import "../access/grant-read.js";
import { hubAuthMiddleware } from "../routers/hub-protocol/_middleware/auth.js";
import { registerEntitiesRoutes } from "../routers/hub-protocol/rest/entities.js";
import { registerFocusSessionsRoutes } from "../routers/hub-protocol/rest/focus-sessions.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";
import { oauthApp } from "../routers/oauth/routes.js";
import {
  decideOAuthAuthorization,
  getOAuthConsentContext,
  type AuthorizeParams,
} from "../routers/oauth/consent.js";
import { oauthKeyInstanceId } from "../routers/oauth/config.js";
import {
  checkPermissionOrPropose,
  previewPermissionDecision,
} from "../utils/permission-check.js";
import { applyProposalApproval } from "../routers/proposals/apply-approval.js";
import { registerProposalExecutor } from "../routers/proposals/execution-registry.js";
import { computeCanReviewApproval } from "../routers/proposals/review-authority.js";
import { resolveKeyIdentity } from "../access/key-identity.js";
import { apiKeyService } from "./api-keys.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import {
  applyApprovedReach,
  grantsForApprovedRequests,
  issueKey,
  revokeApp,
  setAppRedirectUris,
  setAppSignInPolicy,
} from "./app-connect.js";
import { proposalsRouter } from "../routers/proposals.js";
import { keyGrantReadsSubject } from "../utils/webhook-delivery.js";

const ISSUER = "https://pod.test.synap.live";
const CALLBACK = "https://studio.example.com/auth/callback";
const OWNER = randomUUID();
const MEMBER = randomUUID();
const SALES = randomUUID();
const FINANCE = randomUUID();
const MARKETING = randomUUID();
/** MEMBER's own space, where OWNER is only an editor (H1 owner-role row). */
const CONTENT = randomUUID();
const POD_ADMIN_WS = randomUUID();
const PERSON_PROFILE = randomUUID();
const ENTITY = {
  [SALES]: randomUUID(),
  [FINANCE]: randomUUID(),
  [MARKETING]: randomUUID(),
};
const SESSION = { [SALES]: randomUUID(), [MARKETING]: randomUUID() };
const PROPOSAL = {
  [SALES]: randomUUID(),
  [FINANCE]: randomUUID(),
  [MARKETING]: randomUUID(),
};
/** Sales proposals for the M2 policy: one by the app's AI, one by nobody's AI. */
const BY_APP_AI = randomUUID();
const BY_PERSON = randomUUID();
const SPACE_NAME: Record<string, string> = {};

/** What the owner approved for the app (`app/connect`). */
const APPROVED = [
  { permission: "entity.person.read", workspaceId: SALES },
  { permission: "entity.person.create", workspaceId: SALES },
  { permission: "proposal.approve", workspaceId: SALES },
  { permission: "session.update", workspaceId: SALES },
  { permission: "entity.person.read", workspaceId: FINANCE },
];

const VERIFIER = "v".repeat(43) + "erifier-for-the-studio-sign-in";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

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
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

let publicId: string;
let appId: string;
let appAgent: string;
let appKey: string;

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://admin.pod.test.synap.live";
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1,'owner@x','human'), ($2,'member@x','human')`,
    [OWNER, MEMBER]
  );
  for (const [ws, name] of [
    [SALES, "Sales"],
    [FINANCE, "Finance"],
    [MARKETING, "Marketing"],
  ] as const) {
    SPACE_NAME[ws] = name;
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), SALES, MEMBER]
  );
  // CONTENT: MEMBER's own space; OWNER edits there (and may give it to an app).
  SPACE_NAME[CONTENT] = "Content";
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Content',$2,'{}'::jsonb)`,
    [CONTENT, MEMBER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'), ($4,$2,$5,'editor')`,
    [randomUUID(), CONTENT, MEMBER, randomUUID(), OWNER]
  );
  // OWNER is a POD ADMIN: their app may sign in other members (H1).
  await q(
    `insert into workspaces (id, name, owner_id, settings, system_slug) values ($1,'Pod admin',$2,'{}'::jsonb,'pod-admin')`,
    [POD_ADMIN_WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), POD_ADMIN_WS, OWNER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, origin)
     values ($1,'person','Person','kind','system','workspace',true,'{}'::jsonb,'system')`,
    [PERSON_PROFILE]
  );
  for (const [ws, id] of Object.entries(ENTITY)) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'person','p','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, PERSON_PROFILE]
    );
  }
  for (const [ws, id] of Object.entries(SESSION)) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, title, status, expected_outputs)
       values ($1,$2,$3,'Weekly interview','active','[]'::jsonb)`,
      [id, OWNER, ws]
    );
  }
  // The pod default (0282): agents act on reversible writes — the input on
  // which "governed like an agent" and "acts as the person" disagree.
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1,'any','pod','action',$2,'auto','system:reversible-default')`,
    [randomUUID(), REVERSIBLE_CLASS_PATTERN]
  );

  const repo = new AppRepository(h.db as never);
  const app = await repo.register({ ownerUserId: OWNER, name: "Studio" });
  await repo.setApprovedRequests(app.id, APPROVED);
  publicId = app.publicId;
  appId = app.id;
  // The app's own (agent) key — the AI half, unchanged by this feature.
  appKey = (await issueKey({ publicId, ownerUserId: OWNER, via: "cli" }))
    .apiKey;
  appAgent = (await repo.getByPublicId(publicId))!.app.agentUserId!;
  await setAppRedirectUris({
    publicId,
    ownerUserId: OWNER,
    redirectUris: [CALLBACK],
  });

  // The probes' proposals approve through the REAL registry dispatch: an
  // executor for their key that applies (flips the row) and succeeds, so the
  // approval core runs end to end — gates, apply, then the in-app stamp.
  registerProposalExecutor({
    key: "probe/noop" as never,
    execute: async (args: { proposal: { id: string } }) => {
      await q(`update proposals set status = 'approved' where id = $1`, [
        args.proposal.id,
      ]);
      return { success: true } as never;
    },
  } as never);
  for (const [id, ws, agent] of [
    ...Object.entries(PROPOSAL).map(([ws, id]) => [id, ws, appAgent]),
    [BY_APP_AI, SALES, appAgent],
    [BY_PERSON, SALES, null],
  ] as Array<[string, string, string | null]>) {
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, workspace_id, status, data, created_by, agent_user_id)
       values ($1,'probe','probe-target','noop',$2,'pending','{}'::jsonb,$3,$4)`,
      [id, ws, agent ?? OWNER, agent]
    );
  }
}, 180_000);

// ─── The OAuth flow ──────────────────────────────────────────────────────────

const params = (over: Partial<AuthorizeParams> = {}): AuthorizeParams => ({
  clientId: publicId,
  redirectUri: CALLBACK,
  responseType: "code",
  scope: null,
  state: "state-123",
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
  ...over,
});

function authorize(p: AuthorizeParams) {
  const qs = new URLSearchParams(
    Object.entries({
      client_id: p.clientId,
      redirect_uri: p.redirectUri,
      response_type: p.responseType,
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: p.codeChallengeMethod,
    }).filter((e): e is [string, string] => typeof e[1] === "string")
  );
  return oauthApp.request(`/authorize?${qs}`);
}

/** What the consent screen does: render, then Allow with what it rendered. */
async function consent(person: string, p: AuthorizeParams = params()) {
  const shown = await getOAuthConsentContext(p, person);
  const { redirectTo } = await decideOAuthAuthorization(
    { ...p, approve: true, appSignInFingerprint: shown.appSignIn?.fingerprint },
    person
  );
  const url = new URL(redirectTo);
  return { url, code: url.searchParams.get("code")! };
}

async function token(body: Record<string, string>) {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const redeem = (code: string, over: Record<string, string> = {}) =>
  token({
    grant_type: "authorization_code",
    code,
    client_id: publicId,
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER,
    ...over,
  });

async function signIn(person: string): Promise<string> {
  const { code } = await consent(person);
  const res = await redeem(code);
  expect(res.status).toBe(200);
  return res.body.access_token as string;
}

const keyRow = async (plain: string) =>
  (
    await q<{
      id: string;
      user_id: string;
      linked_user_id: string | null;
      key_type: string;
      instance_id: string | null;
      is_active: boolean;
      expires_at: Date | null;
    }>(
      `select id, user_id, linked_user_id, key_type, instance_id, is_active, expires_at from api_keys where key_lookup_hash = $1`,
      [createHash("sha256").update(plain).digest("hex")]
    )
  ).rows[0]!;

const livePairs = async (keyId: string) =>
  (
    await q<{ permissions: string[]; workspace_ids: string[] | null }>(
      `select permissions, workspace_ids from grants where api_key_id = $1 and revoked_at is null`,
      [keyId]
    )
  ).rows
    .flatMap((g) =>
      (g.workspace_ids ?? []).flatMap((ws) =>
        g.permissions.map((p) => `${SPACE_NAME[ws]}:${p}`)
      )
    )
    .sort();

// ─── The Hub door, with probes that run inside it ────────────────────────────

function hubApp() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerEntitiesRoutes(hub);
  registerFocusSessionsRoutes(hub);
  // A write through the ONE gate, as every Hub write door calls it.
  hub.post("/__probe/write", async (c) => {
    const { workspaceId } = (await c.req.json()) as { workspaceId: string };
    const decision = await checkPermissionOrPropose({
      userId: c.get("userId"),
      agentUserId: c.get("agentUserId"),
      workspaceId,
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "person", title: "Ada" },
    } as Parameters<typeof checkPermissionOrPropose>[0]);
    return c.json({
      userId: c.get("userId"),
      agentUserId: c.get("agentUserId") ?? null,
      clientId: getRequestGrant()?.clientId ?? null,
      decision,
    });
  });
  // The agent half, decision-only (this harness cannot file a proposal row).
  hub.post("/__probe/preview", async (c) => {
    const { workspaceId } = (await c.req.json()) as { workspaceId: string };
    return c.json(
      await previewPermissionDecision({
        userId: c.get("userId"),
        agentUserId: c.get("agentUserId"),
        workspaceId,
        subjectType: "entity",
        action: "create",
        data: { profileSlug: "person", title: "Ada" },
      } as Parameters<typeof previewPermissionDecision>[0])
    );
  });
  // The ONE approval door every approve path reaches.
  hub.post("/__probe/approve", async (c) => {
    const { proposalId } = (await c.req.json()) as { proposalId: string };
    const proposal = (await (h.db as any).query.proposals.findMany({})).find(
      (p: { id: string }) => p.id === proposalId
    );
    const userId = c.get("userId") as string;
    const ladder = await computeCanReviewApproval({
      proposal,
      userId,
      purpose: "approve",
      roster: false,
    });
    try {
      await applyProposalApproval({
        proposal,
        userId,
        input: { proposalId },
        ctx: { userId, agentUserId: c.get("agentUserId") } as never,
      });
      return c.json({ ladder: ladder.allowed, refused: null });
    } catch (err) {
      return c.json({
        ladder: ladder.allowed,
        refused: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const hub = (bearer: string, method: string, path: string, body?: unknown) =>
  hubApp().request(`/api/hub${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ─── (a) + (b) ───────────────────────────────────────────────────────────────

describe("a registered, approved app signs the owner in", () => {
  let ownerToken: string;
  beforeAll(async () => {
    ownerToken = await signIn(OWNER);
  }, 60_000);

  it("/authorize hands the browser to the pod's consent screen", async () => {
    const res = await authorize(params());
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://admin.pod.test.synap.live");
    expect(to.searchParams.get("client_id")).toBe(publicId);
  });

  it("the consent screen says what the app will do AS the person, from the grant", async () => {
    const ctx = await getOAuthConsentContext(params(), OWNER);
    expect(ctx.appSignIn).toMatchObject({
      appName: "Studio",
      headline: "Studio will act as you in: Sales, Finance.",
      cannot:
        "It cannot delete, manage keys, approve outside these spaces, or see other spaces.",
      expiresInDays: 30,
    });
    const sales = ctx.appSignIn!.spaces.find((s) => s.workspaceId === SALES)!;
    expect(sales.can).toMatch(/Approve/);
    expect(ctx.appSignIn!.spaces.map((s) => s.name)).toEqual([
      "Sales",
      "Finance",
    ]);
  });

  it("the token is HELD BY THE PERSON, 30 days, and is not adopted onto the app's agent", async () => {
    const row = await keyRow(ownerToken);
    expect(row).toMatchObject({
      user_id: OWNER,
      linked_user_id: null,
      key_type: "app_person",
      instance_id: oauthKeyInstanceId(publicId, OWNER),
      is_active: true,
    });
    const days =
      (new Date(row.expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    expect(await livePairs(row.id)).toEqual([
      "Finance:entity.person.read",
      "Sales:entity.person.create",
      "Sales:entity.person.read",
      "Sales:proposal.approve",
      "Sales:session.update",
    ]);
    const status = await apiKeyService.getApiKeyStatus(ownerToken);
    expect(status.status).toBe("valid");
    const id = await resolveKeyIdentity((status as any).record);
    expect(id).toMatchObject({
      isAgent: false,
      agentUserId: undefined,
      effectiveUserId: OWNER,
    });
    expect(id.grant?.clientId).toBe(publicId);
    // Still the person's after resolving — never moved onto the agent.
    expect((await keyRow(ownerToken)).user_id).toBe(OWNER);
  });

  it("a write in-grant is the PERSON's, direct — where the app's own key proposes it", async () => {
    const res = await hub(ownerToken, "POST", "/__probe/write", {
      workspaceId: SALES,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      userId: OWNER,
      agentUserId: null,
      clientId: publicId,
    });
    expect(body.decision).toMatchObject({ granted: true });

    // CONTROL — the app's AI key, same write, same space: proposed.
    const agent = await hub(appKey, "POST", "/__probe/preview", {
      workspaceId: SALES,
    });
    expect(await agent.json()).toEqual({ decision: "propose" });
  });

  it("(b) a write outside the grant is refused — though the owner may by role", async () => {
    for (const ws of [MARKETING, FINANCE]) {
      const res = await hub(ownerToken, "POST", "/__probe/write", {
        workspaceId: ws,
      });
      const body = (await res.json()) as any;
      expect(body.decision).toMatchObject({ denied: true });
      expect(body.decision.reason).toMatch(/grant does not allow/);
    }
  });

  it("(b) reads return only in-grant rows", async () => {
    const res = await hub(ownerToken, "GET", "/entities?limit=50");
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>)
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual([ENTITY[SALES]!, ENTITY[FINANCE]!].sort());
  });

  it("approves in-grant; refused outside it by the approval door itself", async () => {
    const inGrant = (await (
      await hub(ownerToken, "POST", "/__probe/approve", {
        proposalId: PROPOSAL[SALES],
      })
    ).json()) as any;
    expect(inGrant.ladder).toBe(true);
    expect(inGrant.refused).toBeNull();
    // M2: an approval made inside the app is recorded as such.
    const [stamped] = (
      await q<{ data: Record<string, unknown> }>(
        `select data from proposals where id = $1`,
        [PROPOSAL[SALES]]
      )
    ).rows;
    expect(stamped!.data.approvedInApp).toEqual({ publicId, name: "Studio" });

    for (const ws of [FINANCE, MARKETING]) {
      const outside = (await (
        await hub(ownerToken, "POST", "/__probe/approve", {
          proposalId: PROPOSAL[ws],
        })
      ).json()) as any;
      // The person could approve here by role; the TOKEN may not.
      expect(outside.ladder).toBe(true);
      expect(outside.refused).toMatch(/may not approve changes here/);
    }

    // CONTROL — the app's AI key never approves.
    const agent = (await (
      await hub(appKey, "POST", "/__probe/approve", {
        proposalId: PROPOSAL[SALES],
      })
    ).json()) as any;
    expect(agent.refused).toMatch(/agent credential cannot approve/);
  });

  it("answers an ask in-grant (reaches the session); refused in a space outside it", async () => {
    const answer = (session: string) =>
      hub(ownerToken, "POST", `/focus-sessions/${session}/outputs/answer`, {
        expectedLabel: "Brief",
        text: "yes",
      });
    const inGrant = await answer(SESSION[SALES]!);
    // Past the key: the session has no "Brief" slot, so the service answers.
    expect(inGrant.status).toBe(404);
    expect(((await inGrant.json()) as any).error).toMatch(/Brief/);

    const outside = await answer(SESSION[MARKETING]!);
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as any).error).toMatch(/grant/i);
  });
});

// ─── the person's reach narrows the grant ───────────────────────────────────

describe("a member signs in: only the spaces they can reach", () => {
  it("consent and token both stop at the member's spaces", async () => {
    const ctx = await getOAuthConsentContext(params(), MEMBER);
    expect(ctx.appSignIn!.spaces.map((s) => s.name)).toEqual(["Sales"]);
    const t = await signIn(MEMBER);
    expect(await livePairs((await keyRow(t)).id)).toEqual([
      "Sales:entity.person.create",
      "Sales:entity.person.read",
      "Sales:proposal.approve",
      "Sales:session.update",
    ]);
  });
});

// ─── (c) a self-registered client ───────────────────────────────────────────

describe("(c) a self-registered (DCR) client never gets a person token", () => {
  it("same redirect URI, same person: minted through the AGENT door", async () => {
    const reg = await oauthApp.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        client_name: "Studio",
      }),
    });
    expect(reg.status).toBe(201);
    const dcrId = ((await reg.json()) as any).client_id as string;
    const p = params({ clientId: dcrId, scope: "mcp.read mcp.write" });
    expect((await getOAuthConsentContext(p, OWNER)).appSignIn).toBeNull();
    const personKeysBefore = (
      await q(`select id from api_keys where key_type = 'app_person'`)
    ).rows.length;
    h.provision.length = 0;
    const { code } = await consent(OWNER, p);
    const res = await token({
      grant_type: "authorization_code",
      code,
      client_id: dcrId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(200);
    expect(h.provision).toHaveLength(1);
    expect(h.provision[0]).toMatchObject({
      agentType: "claude-web-direct",
      linkedUserId: OWNER,
    });
    expect(
      (await q(`select id from api_keys where key_type = 'app_person'`)).rows
        .length
    ).toBe(personKeysBefore);
  });
});

// ─── (d) 0313 stays closed ──────────────────────────────────────────────────

async function handMadeKey(args: {
  holder: string;
  keyType: string;
  instanceId: string | null;
  clientId: string;
}) {
  const keyId = randomUUID();
  await q(
    `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope, instance_id)
     values ($1,$2,null,true,$3,'hand made','synap_user_',$4,'{hub-protocol.read,hub-protocol.write}',$5)`,
    [keyId, args.holder, args.keyType, `h-${keyId}`, args.instanceId]
  );
  await attachGrantsOrRevoke({
    apiKeyId: keyId,
    principalUserId: args.holder,
    onBehalfOf: OWNER,
    grants: grantsForApprovedRequests(APPROVED),
    expiresAt: null,
    createdBy: OWNER,
    clientId: args.clientId,
  });
  return keyId;
}

describe("(d) a hand-made person key naming the app is still adopted (0313)", () => {
  it("even shaped like a sign-in (same instance), a user_pat is moved onto the app's agent", async () => {
    const keyId = await handMadeKey({
      holder: OWNER,
      keyType: "user_pat",
      instanceId: oauthKeyInstanceId(publicId, OWNER),
      clientId: publicId,
    });
    const id = await resolveKeyIdentity({
      id: keyId,
      userId: OWNER,
      linkedUserId: null,
    });
    expect(id).toMatchObject({ isAgent: true, agentUserId: appAgent });
    const [row] = (
      await q<{ user_id: string }>(`select user_id from api_keys where id=$1`, [
        keyId,
      ])
    ).rows;
    expect(row!.user_id).toBe(appAgent);
  });

  it("the person type held by an AGENT resolves as the agent (T4)", async () => {
    const keyId = await handMadeKey({
      holder: appAgent,
      keyType: "app_person",
      instanceId: oauthKeyInstanceId(publicId, appAgent),
      clientId: publicId,
    });
    expect(
      await resolveKeyIdentity({
        id: keyId,
        userId: appAgent,
        linkedUserId: OWNER,
      })
    ).toMatchObject({ isAgent: true, agentUserId: appAgent });
  });

  it("a person token bound to ANOTHER app than its grant names is refused", async () => {
    const keyId = await handMadeKey({
      holder: OWNER,
      keyType: "app_person",
      instanceId: oauthKeyInstanceId("app_someone-else", OWNER),
      clientId: publicId,
    });
    await expect(
      resolveKeyIdentity({ id: keyId, userId: OWNER, linkedUserId: null })
    ).rejects.toThrow(/sign in to the app again/);
  });

  it("consent is never decided from a key door (a grant or an acting agent in scope)", async () => {
    const grant: KeyGrant = {
      scopes: [{ permissions: ["*"] }],
      clientId: null,
    };
    await expect(
      runWithGrant(grant, () =>
        decideOAuthAuthorization({ ...params(), approve: true }, OWNER)
      )
    ).rejects.toThrow(/Only a person signed in/);
  });
});

// ─── (e) + (f) ──────────────────────────────────────────────────────────────

describe("(e) an app that cannot sign anyone in", () => {
  it("no approval, or no redirect URI → shown to the person, never redirected", async () => {
    const repo = new AppRepository(h.db as never);
    const unapproved = await repo.register({
      ownerUserId: OWNER,
      name: "Unapproved",
    });
    await repo.setRedirectUris(unapproved.id, [CALLBACK]);
    const noRedirect = await repo.register({
      ownerUserId: OWNER,
      name: "No redirect",
    });
    await repo.setApprovedRequests(noRedirect.id, APPROVED);
    for (const app of [unapproved, noRedirect]) {
      const res = await authorize(params({ clientId: app.publicId }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toMatch(/cannot sign anyone in/);
      await expect(
        decideOAuthAuthorization(
          { ...params({ clientId: app.publicId }), approve: true },
          OWNER
        )
      ).rejects.toThrow(/cannot sign anyone in/);
    }
  });
});

describe("(f) the code is single-use, PKCE-bound and redirect-bound", () => {
  it("a replayed code is refused", async () => {
    const { code } = await consent(OWNER);
    expect((await redeem(code)).status).toBe(200);
    const again = await redeem(code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("a wrong verifier is refused, and burns the code", async () => {
    const { code } = await consent(OWNER);
    const bad = await redeem(code, { code_verifier: "w".repeat(64) });
    expect(bad.status).toBe(400);
    expect((await redeem(code)).status).toBe(400);
  });

  it("an unregistered redirect URI is refused at /authorize and at /token", async () => {
    const res = await authorize(
      params({ redirectUri: "https://studio.example.com/elsewhere" })
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const { code } = await consent(OWNER);
    const swapped = await redeem(code, {
      redirect_uri: "https://studio.example.com/elsewhere",
    });
    expect(swapped.status).toBe(400);
    expect(swapped.body.error).toBe("invalid_grant");
  });

  it("the redirect carries the client's state and the pod as iss", async () => {
    const { url } = await consent(OWNER);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("iss")).toBe(ISSUER);
  });
});

describe("the app signs the person out (RFC 7009 /revoke)", () => {
  const revoke = (tokenValue: string, clientId: string) =>
    oauthApp.request("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokenValue, client_id: clientId }),
    });

  it("by possession, bound to its own client", async () => {
    const t = await signIn(OWNER);
    const wrong = await revoke(t, "app_someone-else");
    expect(wrong.status).toBe(400);
    expect((await keyRow(t)).is_active).toBe(true);
    expect((await revoke(t, publicId)).status).toBe(200);
    expect((await keyRow(t)).is_active).toBe(false);
  });
});

// ─── T5 + lifecycle ─────────────────────────────────────────────────────────

// ─── PR #29 review: H1, L1, M1, M2 ──────────────────────────────────────────

const removeOwnerFromPodAdmin = () =>
  q(`delete from workspace_members where workspace_id = $1 and user_id = $2`, [
    POD_ADMIN_WS,
    OWNER,
  ]);
const restoreOwnerAsPodAdmin = () =>
  q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), POD_ADMIN_WS, OWNER]
  );
async function identityOf(tokenValue: string) {
  const status = await apiKeyService.getApiKeyStatus(tokenValue);
  return resolveKeyIdentity((status as unknown as { record: never }).record);
}

describe("H1 — who may sign in to an app (owner, or anyone when the owner is a pod admin)", () => {
  it("a member's own app signs in ONLY that member — another member is refused on the pod", async () => {
    const repo = new AppRepository(h.db as never);
    const own = await repo.register({
      ownerUserId: MEMBER,
      name: "Member tool",
    });
    await repo.setApprovedRequests(own.id, [
      { permission: "entity.person.read", workspaceId: SALES },
    ]);
    await repo.setRedirectUris(own.id, [CALLBACK]);
    const p = params({ clientId: own.publicId });
    await expect(getOAuthConsentContext(p, OWNER)).rejects.toThrow(
      /only that member can sign in/
    );
    await expect(
      decideOAuthAuthorization({ ...p, approve: true }, OWNER)
    ).rejects.toThrow(/only that member can sign in/);
    // Its owner signs in, and the screen says who registered it.
    const mine = await getOAuthConsentContext(p, MEMBER);
    expect(mine.appSignIn?.registeredBy).toBe("member@x");
  });

  it("the consent page names who registered an admin's app", async () => {
    const ctx = await getOAuthConsentContext(params(), MEMBER);
    expect(ctx.appSignIn?.registeredBy).toBe("owner@x");
  });

  it("an owner who stops being a pod admin: a member's live token stops; the owner's own does not", async () => {
    const memberToken = await signIn(MEMBER);
    const ownerToken = await signIn(OWNER);
    expect((await identityOf(memberToken)).effectiveUserId).toBe(MEMBER);
    await removeOwnerFromPodAdmin();
    try {
      await expect(identityOf(memberToken)).rejects.toThrow(
        /sign in to the app again/
      );
      expect((await identityOf(ownerToken)).effectiveUserId).toBe(OWNER);
    } finally {
      await restoreOwnerAsPodAdmin();
    }
  });

  it("N1 — a webhook read sees the SAME rule: a demoted owner's member token reads nothing and is ended", async () => {
    const t = await signIn(MEMBER);
    const keyId = (await keyRow(t)).id;
    const reads = () =>
      keyGrantReadsSubject({
        subjectType: "entity",
        subjectId: ENTITY[SALES]!,
        apiKeyId: keyId,
        ownerUserId: MEMBER,
      } as never);
    // The member can read Sales people in their own right AND through the
    // token's grant — so `true` here is the grant passing, not the floor.
    expect(await reads()).toBe(true);
    await removeOwnerFromPodAdmin();
    try {
      expect(await reads()).toBe(false);
      // Ended, not only refused: the row is revoked.
      expect((await keyRow(t)).is_active).toBe(false);
    } finally {
      await restoreOwnerAsPodAdmin();
    }
  });

  it("L1 — an owner's lost role in a space narrows live tokens on the next request", async () => {
    const repo = new AppRepository(h.db as never);
    await repo.setApprovedRequests(appId, [
      ...APPROVED,
      { permission: "entity.person.create", workspaceId: CONTENT },
    ]);
    try {
      const t = await signIn(MEMBER);
      const write = async (workspaceId: string) =>
        (
          (await (
            await hub(t, "POST", "/__probe/write", { workspaceId })
          ).json()) as any
        ).decision;
      expect(await write(CONTENT)).toMatchObject({ granted: true });
      await q(
        `update workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2`,
        [CONTENT, OWNER]
      );
      try {
        expect(await write(CONTENT)).toMatchObject({ denied: true });
        expect(await write(SALES)).toMatchObject({ granted: true });
      } finally {
        await q(
          `update workspace_members set role = 'editor' where workspace_id = $1 and user_id = $2`,
          [CONTENT, OWNER]
        );
      }
    } finally {
      await repo.setApprovedRequests(appId, APPROVED);
    }
  });
});

describe("M1 — undo is fenced by the proposal's own space", () => {
  it("revert of a proposal outside the token's spaces is refused by the door", async () => {
    const id = await identityOf(await signIn(OWNER));
    const caller = proposalsRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      req: undefined,
      workspaceId: null,
    } as never);
    const err = await runWithGrant(id.grant!, () =>
      caller.revert({ proposalId: PROPOSAL[MARKETING]! })
    ).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err?.message).toMatch(/may not undo changes here/);
  });
});

describe("M1 — a PROJECT-bounded key rejects in its project, not outside it (re-review)", () => {
  it("through the real reject door: in-project passes the key check; another project is refused", async () => {
    const PROJECT = randomUUID();
    const OTHER = randomUUID();
    const inProject = randomUUID();
    const elsewhere = randomUUID();
    for (const [id, project] of [
      [inProject, PROJECT],
      [elsewhere, OTHER],
    ] as const) {
      await q(
        `insert into proposals (id, target_type, target_id, proposal_type, workspace_id, project_id, status, data, created_by, agent_user_id)
         values ($1,'probe','probe-target','noop',$2,$3,'pending','{}'::jsonb,$4,null)`,
        [id, SALES, project, OWNER]
      );
    }
    const projectKey: KeyGrant = {
      scopes: [{ permissions: ["proposal.reject"], projectIds: [PROJECT] }],
      clientId: null,
    };
    const caller = proposalsRouter.createCaller({
      authenticated: true,
      userId: OWNER,
      req: undefined,
      workspaceId: null,
    } as never);
    const rejectAs = (proposalId: string) =>
      runWithGrant(projectKey, () =>
        caller.reject({ proposalId, reason: "not now" })
      ).then(
        () => null,
        (e: unknown) => (e as Error).message
      );
    expect((await rejectAs(inProject)) ?? "").not.toMatch(
      /may not reject changes here/
    );
    expect(await rejectAs(elsewhere)).toMatch(/may not reject changes here/);
  });
});

describe("M2 — approving the app's OWN AI's proposals: visible, and switchable by the owner", () => {
  it("off: refused for the app's AI's proposal, still allowed for anyone else's", async () => {
    const t = await signIn(OWNER);
    await setAppSignInPolicy({
      publicId,
      ownerUserId: OWNER,
      personMayDecideOwnAgentProposals: false,
    });
    try {
      const approve = async (proposalId: string) =>
        (
          (await (
            await hub(t, "POST", "/__probe/approve", { proposalId })
          ).json()) as any
        ).refused as string | null;
      expect(await approve(BY_APP_AI)).toMatch(/turned that off/);
      expect(await approve(BY_PERSON)).toBeNull();
    } finally {
      await setAppSignInPolicy({
        publicId,
        ownerUserId: OWNER,
        personMayDecideOwnAgentProposals: true,
      });
    }
  });
});

describe("T5 — never wider than the consent; the app's lifecycle reaches it", () => {
  it("an Allow for a screen that no longer matches the grant is refused", async () => {
    const shown = await getOAuthConsentContext(params(), OWNER);
    const repo = new AppRepository(h.db as never);
    await repo.setApprovedRequests(appId, [
      ...APPROVED,
      { permission: "entity.person.create", workspaceId: FINANCE },
    ]);
    try {
      await expect(
        decideOAuthAuthorization(
          {
            ...params(),
            approve: true,
            appSignInFingerprint: shown.appSignIn!.fingerprint,
          },
          OWNER
        )
      ).rejects.toThrow(/changed since this page was shown/);
    } finally {
      await repo.setApprovedRequests(appId, APPROVED);
    }
  });

  it("an approval widened after consent does not widen the token", async () => {
    const { code } = await consent(OWNER);
    await new AppRepository(h.db as never).setApprovedRequests(appId, [
      ...APPROVED,
      { permission: "entity.person.create", workspaceId: MARKETING },
    ]);
    try {
      const res = await redeem(code);
      expect(res.status).toBe(200);
      const pairs = await livePairs((await keyRow(res.body.access_token)).id);
      expect(pairs.some((p) => p.startsWith("Marketing:"))).toBe(false);
    } finally {
      await new AppRepository(h.db as never).setApprovedRequests(
        appId,
        APPROVED
      );
    }
  });

  it("an approval narrowed after sign-in narrows the live token", async () => {
    const t = await signIn(OWNER);
    const repo = new AppRepository(h.db as never);
    await repo.setApprovedRequests(
      appId,
      APPROVED.filter((r) => r.workspaceId === SALES)
    );
    try {
      await applyApprovedReach(appId);
      expect(await livePairs((await keyRow(t)).id)).toEqual([
        "Sales:entity.person.create",
        "Sales:entity.person.read",
        "Sales:proposal.approve",
        "Sales:session.update",
      ]);
    } finally {
      await repo.setApprovedRequests(appId, APPROVED);
    }
  });

  it("rotating the app's own key keeps the person signed in; revoking the app ends it", async () => {
    const t = await signIn(OWNER);
    appKey = (await issueKey({ publicId, ownerUserId: OWNER, via: "cli" }))
      .apiKey;
    expect((await keyRow(t)).is_active).toBe(true);
    await revokeApp({ publicId, ownerUserId: OWNER });
    expect((await keyRow(t)).is_active).toBe(false);
  });
});
