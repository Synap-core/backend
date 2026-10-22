/**
 * A SYNAP pod app acts AS THE PERSON (founder decision 2026-10-22) — end to
 * end on PGlite through the REAL doors:
 *
 *   consent (`getOAuthConsentContext` / `decideOAuthAuthorization` →
 *   `connectOAuthApp`, the person's own connection) → `POST /token` (Hono,
 *   real) → `mintAppOAuthAccessKey` → `podAppActsAs` → the ONE person-token
 *   door (`mintPodAppPersonToken`: `createAndVerifyHubInboundKey` +
 *   `attachGrantsOrRevoke`) → the token presented to the REAL Hub auth door
 *   (`hubAuthMiddleware`: lookup, `resolveKeyIdentity` →
 *   `classifyAppPersonKey`, W1 fence, `runWithGrant`) → the real write gate
 *   (`checkPermissionOrPropose`) and the real approval door
 *   (`applyProposalApproval`); then `grant_type=refresh_token`, `revokeApp`
 *   and `POST /revoke`.
 *
 * Three clients, the same documents but for their origin:
 *   VERIFIED  https://content-studio.synap.live/…       → the person's token
 *   UNVERIFIED https://studio.example.com/…              → the app's agent
 *   LOOKALIKE https://content-studio.synap.live.evil.com/… → the app's agent
 *
 * OWNER owns every space and is a pod admin, so every refusal of OWNER's
 * token below is the token's grant (what they ticked), never their role.
 * MEMBER (not an admin) edits Content only.
 *
 * Threats (services/app-person-token.ts): T9′ any member, their own
 * connection; T11 lookalike / unverified never reaches the person path, and a
 * person key naming an unverified connection is dead; T12 refresh keeps the
 * person and revoking ends it; T13 approves in its granted space only.
 *
 * Seams replaced, and why: the event store (`EventRepository`) and
 * `auditLog` write through the postgres-js client this harness has not —
 * both are recorders; `createPendingProposal` inserts on the transaction it
 * is given (a PGlite transaction holds the one connection); the guest check
 * and sub-token mapping the Hub door asks are constant answers.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "pod-app-person-test-jwt-secret";
});

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
vi.mock("../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: async () => false,
}));
vi.mock("./external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: async () => null,
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
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { getRequestGrant } from "@synap/database";
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
// Registers the grant read provider (as the API does at load).
import "../access/grant-read.js";
import { hubAuthMiddleware } from "../routers/hub-protocol/_middleware/auth.js";
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
import { computeS256Challenge } from "../routers/oauth/protocol.js";
import {
  checkPermissionOrPropose,
  previewPermissionDecision,
} from "../utils/permission-check.js";
import { applyProposalApproval } from "../routers/proposals/apply-approval.js";
import { registerProposalExecutor } from "../routers/proposals/execution-registry.js";
import { resolveKeyIdentity } from "../access/key-identity.js";
import { apiKeyService } from "./api-keys.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import { grantsForApprovedRequests, revokeApp } from "./app-connect.js";

const ISSUER = "https://pod.test.synap.live";
const DOC = "/.well-known/synap-client.json";
const VERIFIED = `https://content-studio.synap.live${DOC}`;
const UNVERIFIED = `https://studio.example.com${DOC}`;
const LOOKALIKE = `https://content-studio.synap.live.evil.com${DOC}`;
const callbackOf = (clientId: string) =>
  `${new URL(clientId).origin}/api/synap/callback`;

const OWNER = randomUUID();
const MEMBER = randomUUID();
const CONTENT = randomUUID();
const ECOSYSTEM = randomUUID();
const FINANCE = randomUUID();
const POD_ADMIN_WS = randomUUID();
const PERSON_PROFILE = randomUUID();
const SPACE_NAME: Record<string, string> = {
  [CONTENT]: "Content OS",
  [ECOSYSTEM]: "Ecosystem",
  [FINANCE]: "Finance",
};
const PROPOSAL = { [CONTENT]: randomUUID(), [FINANCE]: randomUUID() };

const READ = "entity.person.read";
const CREATE = "entity.person.create";
const APPROVE = "proposal.approve";
/** What every client's document declares (a review verb: Synap apps only). */
const DECLARED: Record<string, string[]> = {
  [VERIFIED]: [READ, CREATE, APPROVE],
  [UNVERIFIED]: [READ, CREATE],
  [LOOKALIKE]: [READ, CREATE],
};

/** OWNER ticks Content OS + Ecosystem; Finance (theirs too) is left out. */
const TICKED = [
  { permission: READ, workspaceId: CONTENT },
  { permission: CREATE, workspaceId: CONTENT },
  { permission: APPROVE, workspaceId: CONTENT },
  { permission: READ, workspaceId: ECOSYSTEM },
];

const VERIFIER = "v".repeat(64);
const CHALLENGE = computeS256Challenge(VERIFIER);

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

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://admin.pod.test.synap.live";
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // The GC relies on it (0305: a key's grants go with it).
  await q(
    `alter table grants add foreign key (api_key_id) references api_keys(id) on delete cascade`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1,'owner@x','Ada','human'), ($2,'member@x','Bo','human')`,
    [OWNER, MEMBER]
  );
  for (const ws of [CONTENT, ECOSYSTEM, FINANCE]) {
    // Content OS was made from a template; the others from none.
    await q(
      `insert into workspaces (id, name, owner_id, settings, package_slug) values ($1,$2,$3,'{}'::jsonb,$4)`,
      [ws, SPACE_NAME[ws], OWNER, ws === CONTENT ? "content-os" : null]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), CONTENT, MEMBER]
  );
  // OWNER is a pod admin: the A1 rule would let their REGISTERED app sign
  // anyone in — the input on which "the connection is its person's" matters.
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
  // The pod default (0282): agents act on reversible writes — so "proposed"
  // below is the app agent's ask-first posture, not a pod rule.
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1,'any','pod','action',$2,'auto','system:reversible-default')`,
    [randomUUID(), REVERSIBLE_CLASS_PATTERN]
  );
  // Fresh metadata-document cache rows: `resolveCimdClient` serves them.
  for (const clientId of [VERIFIED, UNVERIFIED, LOOKALIKE]) {
    await q(
      `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
         requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, created_at)
       values ($1, 'cimd', 'Content Studio', $2, '{}', $3, '{}', now(), now() + interval '1 hour', now())`,
      [clientId, [callbackOf(clientId)], DECLARED[clientId]]
    );
  }
  registerProposalExecutor({
    key: "probe/noop" as never,
    execute: async (args: { proposal: { id: string } }) => {
      await q(`update proposals set status = 'approved' where id = $1`, [
        args.proposal.id,
      ]);
      return { success: true } as never;
    },
  } as never);
  for (const [ws, id] of Object.entries(PROPOSAL)) {
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, workspace_id, status, data, created_by)
       values ($1,'probe','probe-target','noop',$2,'pending','{}'::jsonb,$3)`,
      [id, ws, OWNER]
    );
  }
}, 180_000);

// ─── The OAuth flow ──────────────────────────────────────────────────────────

const params = (clientId: string): AuthorizeParams => ({
  clientId,
  redirectUri: callbackOf(clientId),
  responseType: "code",
  scope: DECLARED[clientId]!.join(" "),
  state: "st",
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
});

/** The consent click, as the person, for what they ticked → the code. */
async function consent(
  person: string,
  clientId: string,
  approved: Array<{ permission: string; workspaceId: string }>
): Promise<string> {
  const { redirectTo } = await decideOAuthAuthorization(
    { ...params(clientId), approve: true, approved },
    person,
    { authenticated: true, userId: person } as never
  );
  return new URL(redirectTo).searchParams.get("code")!;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Consent + the code exchange: the /token answer. */
async function connect(
  person: string,
  clientId: string,
  approved: Array<{ permission: string; workspaceId: string }>
) {
  const code = await consent(person, clientId, approved);
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: callbackOf(clientId),
    code_verifier: VERIFIER,
  });
  expect(res.status).toBe(200);
  return res.body;
}

const refresh = (refreshToken: string, clientId: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

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

const connectionOf = async (person: string, clientId: string) =>
  (
    await q<{ id: string; public_id: string; agent_user_id: string | null }>(
      `select id, public_id, agent_user_id from apps where owner_user_id = $1 and oauth_client_id = $2 and revoked_at is null`,
      [person, clientId]
    )
  ).rows[0]!;

// ─── The Hub door, with probes that run inside it ────────────────────────────

function hubApp() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
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
  // The agent half, decision-only (this harness files no proposal row).
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
    try {
      await applyProposalApproval({
        proposal,
        userId,
        input: { proposalId },
        ctx: { userId, agentUserId: c.get("agentUserId") } as never,
      });
      return c.json({ refused: null });
    } catch (err) {
      return c.json({
        refused: err instanceof Error ? err.message : String(err),
      });
    }
  });
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const hub = (bearer: string, path: string, body: unknown) =>
  hubApp().request(`/api/hub${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const write = async (bearer: string, workspaceId: string) =>
  (await (await hub(bearer, "/__probe/write", { workspaceId })).json()) as any;

// ─── the consent screen ─────────────────────────────────────────────────────

describe("the consent screen says 'act as you' for a Synap app only", () => {
  it("a Synap app: who it acts as, from the server, approving included", async () => {
    const ctx = await getOAuthConsentContext(params(VERIFIED), OWNER);
    expect(ctx.app?.verified).toBe(true);
    expect(ctx.app?.actsAs).toEqual({
      kind: "person",
      lead: "Content Studio will act as you in",
      note: "What you do in Content Studio is saved as you, right away — not sent for review, approving changes included. It cannot delete, see other spaces, or create keys. You can sign it out any time from Connected.",
    });
    // The review verb is offered where OWNER may give a write.
    expect(
      ctx
        .app!.permissions.find((p) => p.permission === APPROVE)!
        .workspaces.map((w) => w.workspaceName)
    ).toEqual(expect.arrayContaining(["Content OS", "Ecosystem", "Finance"]));
  });

  it("an unverified app and a lookalike keep the ask-first words, and never say 'act as you'", async () => {
    for (const clientId of [UNVERIFIED, LOOKALIKE]) {
      const ctx = await getOAuthConsentContext(params(clientId), OWNER);
      expect(ctx.app?.verified).toBe(false);
      expect(ctx.app?.actsAs).toEqual({
        kind: "agent",
        note: "Every change it makes is sent to you for review first. It can never see other spaces, approve its own changes, or create keys.",
      });
      expect(JSON.stringify(ctx)).not.toMatch(/act as you/);
    }
  });
});

// ─── a Synap app: the person's token ─────────────────────────────────────────

describe("a Synap app's token is HELD BY THE PERSON, within what they ticked", () => {
  let body: any;
  let token: string;
  beforeAll(async () => {
    body = await connect(OWNER, VERIFIED, TICKED);
    token = body.access_token;
  }, 60_000);

  it("/token says so (synap_acts_as) and the key is the person's own, 1 h, in the connection's slot", async () => {
    const conn = await connectionOf(OWNER, VERIFIED);
    expect(body).toMatchObject({
      token_type: "Bearer",
      synap_acts_as: "person",
      synap_user: { id: OWNER, name: "Ada" },
      synap_app: { id: conn.public_id },
    });
    expect(typeof body.refresh_token).toBe("string");
    expect(body.expires_in).toBeGreaterThan(3500);
    expect(body.expires_in).toBeLessThanOrEqual(3600);
    expect(
      (body.synap_grant as Array<{ permission: string; workspaceName: string }>)
        .map((g) => `${g.workspaceName}:${g.permission}`)
        .sort()
    ).toEqual(
      TICKED.map((t) => `${SPACE_NAME[t.workspaceId]}:${t.permission}`).sort()
    );
    // The three permissions ticked, sorted (entity.* before proposal.*).
    expect(body.scope.split(" ").sort()).toEqual([CREATE, READ, APPROVE]);
    // A templated space names its template; an untemplated one has no key.
    for (const g of body.synap_grant as Array<Record<string, unknown>>) {
      if (g.workspaceId === CONTENT) expect(g.templateSlug).toBe("content-os");
      else expect(g).not.toHaveProperty("templateSlug");
    }

    const row = await keyRow(token);
    expect(row).toMatchObject({
      user_id: OWNER,
      linked_user_id: null,
      key_type: "app_person",
      instance_id: oauthKeyInstanceId(VERIFIED, OWNER),
      is_active: true,
    });
    expect(await livePairs(row.id)).toEqual([
      "Content OS:entity.person.create",
      "Content OS:entity.person.read",
      "Content OS:proposal.approve",
      "Ecosystem:entity.person.read",
    ]);
    // No agent was made for this connection: nothing to act as but the person.
    expect(conn.agent_user_id).toBeNull();
    const status = await apiKeyService.getApiKeyStatus(token);
    const id = await resolveKeyIdentity((status as any).record);
    expect(id).toMatchObject({
      isAgent: false,
      agentUserId: undefined,
      effectiveUserId: OWNER,
    });
    expect(id.grant?.clientId).toBe(conn.public_id);
  });

  it("a write in-grant is the PERSON's, direct", async () => {
    const res = await write(token, CONTENT);
    expect(res).toMatchObject({
      userId: OWNER,
      agentUserId: null,
      clientId: (await connectionOf(OWNER, VERIFIED)).public_id,
    });
    expect(res.decision).toMatchObject({ granted: true });
  });

  it("a write outside what was ticked is refused — though the person may by role", async () => {
    // Ecosystem: ticked for read only. Finance: not ticked at all.
    for (const ws of [ECOSYSTEM, FINANCE]) {
      const res = await write(token, ws);
      expect(res.decision).toMatchObject({ denied: true });
      expect(res.decision.reason).toMatch(/grant does not allow/);
    }
  });

  it("approves in its granted space; refused outside it, by the approval door itself", async () => {
    const inGrant = (await (
      await hub(token, "/__probe/approve", { proposalId: PROPOSAL[CONTENT] })
    ).json()) as any;
    expect(inGrant.refused).toBeNull();
    const [row] = (
      await q<{ status: string; data: Record<string, unknown> }>(
        `select status, data from proposals where id = $1`,
        [PROPOSAL[CONTENT]]
      )
    ).rows;
    expect(row!.status).toBe("approved");
    expect(row!.data.approvedInApp).toMatchObject({
      publicId: (await connectionOf(OWNER, VERIFIED)).public_id,
    });

    const outside = (await (
      await hub(token, "/__probe/approve", { proposalId: PROPOSAL[FINANCE] })
    ).json()) as any;
    expect(outside.refused).toMatch(/may not approve changes here/);
  });
});

// ─── every other app: its agent, ask-first ──────────────────────────────────

describe("an unverified app and a lookalike keep the ask-first agent key", () => {
  for (const clientId of [UNVERIFIED, LOOKALIKE]) {
    it(`${new URL(clientId).host}: its agent's key; its write is proposed; it never approves`, async () => {
      const body = await connect(OWNER, clientId, [
        { permission: READ, workspaceId: CONTENT },
        { permission: CREATE, workspaceId: CONTENT },
      ]);
      expect(body.synap_acts_as).toBe("agent");
      // Every pod app's synap_grant names a templated space's template.
      expect(body.synap_grant).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workspaceId: CONTENT,
            templateSlug: "content-os",
          }),
        ])
      );
      const conn = await connectionOf(OWNER, clientId);
      const row = await keyRow(body.access_token);
      expect(row).toMatchObject({
        user_id: conn.agent_user_id,
        linked_user_id: OWNER,
        key_type: "hub_inbound",
      });
      expect(
        (await q(`select id from api_keys where key_type = 'app_person' and instance_id = $1`, [
          oauthKeyInstanceId(clientId, OWNER),
        ])).rows
      ).toHaveLength(0);
      // The discriminating control: the same write the person's token makes
      // directly is a proposal for the agent.
      const preview = await (
        await hub(body.access_token, "/__probe/preview", {
          workspaceId: CONTENT,
        })
      ).json();
      expect(preview).toEqual({ decision: "propose" });
      const approve = (await (
        await hub(body.access_token, "/__probe/approve", {
          proposalId: PROPOSAL[FINANCE],
        })
      ).json()) as any;
      expect(approve.refused).toMatch(/agent credential cannot approve/);
    });
  }

  it("a person key naming an UNVERIFIED connection is dead (T11, read on every request)", async () => {
    const conn = await connectionOf(OWNER, UNVERIFIED);
    const keyId = randomUUID();
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope, instance_id)
       values ($1,$2,null,true,'app_person','hand made','synap_hub_test_',$3,'{hub-protocol.read,hub-protocol.write}',$4)`,
      [keyId, OWNER, `h-${keyId}`, oauthKeyInstanceId(UNVERIFIED, OWNER)]
    );
    await attachGrantsOrRevoke({
      apiKeyId: keyId,
      principalUserId: OWNER,
      onBehalfOf: OWNER,
      grants: grantsForApprovedRequests([
        { permission: CREATE, workspaceId: CONTENT },
      ]),
      expiresAt: null,
      createdBy: OWNER,
      clientId: conn.public_id,
    });
    await expect(
      resolveKeyIdentity({ id: keyId, userId: OWNER, linkedUserId: null })
    ).rejects.toThrow(/sign in to the app again/);
  });
});

// ─── any member, their own connection (T9′) ─────────────────────────────────

describe("any member consenting to a Synap app gets a token that is THEIRS", () => {
  let token: string;
  beforeAll(async () => {
    token = (
      await connect(MEMBER, VERIFIED, [
        { permission: CREATE, workspaceId: CONTENT },
      ])
    ).access_token;
  }, 60_000);

  it("held by the member, bounded by their own consent — never the admin's approval", async () => {
    const row = await keyRow(token);
    expect(row).toMatchObject({
      user_id: MEMBER,
      key_type: "app_person",
      instance_id: oauthKeyInstanceId(VERIFIED, MEMBER),
    });
    expect(await livePairs(row.id)).toEqual(["Content OS:entity.person.create"]);
    expect((await write(token, CONTENT)).decision).toMatchObject({
      granted: true,
    });
    // OWNER's connection approves Ecosystem; the member's token never reaches it.
    expect((await write(token, ECOSYSTEM)).decision).toMatchObject({
      denied: true,
    });
  });

  it("a person key naming ANOTHER person's connection is dead, though its owner is a pod admin", async () => {
    const ownerConn = await connectionOf(OWNER, VERIFIED);
    const keyId = randomUUID();
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active, key_type, key_name, key_prefix, key_hash, scope, instance_id)
       values ($1,$2,null,true,'app_person','hand made','synap_hub_test_',$3,'{hub-protocol.read,hub-protocol.write}',$4)`,
      [keyId, MEMBER, `h-${keyId}`, oauthKeyInstanceId(VERIFIED, MEMBER)]
    );
    await attachGrantsOrRevoke({
      apiKeyId: keyId,
      principalUserId: MEMBER,
      onBehalfOf: MEMBER,
      grants: grantsForApprovedRequests([
        { permission: CREATE, workspaceId: CONTENT },
      ]),
      expiresAt: null,
      createdBy: MEMBER,
      clientId: ownerConn.public_id,
    });
    await expect(
      resolveKeyIdentity({ id: keyId, userId: MEMBER, linkedUserId: null })
    ).rejects.toThrow(/sign in to the app again/);
  });

  it("the member losing a space narrows the live token on its next request", async () => {
    await q(`delete from workspace_members where workspace_id = $1 and user_id = $2`, [
      CONTENT,
      MEMBER,
    ]);
    try {
      expect((await write(token, CONTENT)).decision).toMatchObject({
        denied: true,
      });
    } finally {
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
        [randomUUID(), CONTENT, MEMBER]
      );
    }
    expect((await write(token, CONTENT)).decision).toMatchObject({
      granted: true,
    });
  });
});

// ─── refresh and revocation (T12) ───────────────────────────────────────────

describe("refresh keeps the person; revoking ends it", () => {
  it("a refresh mints the PERSON's next key in the same slot and retires the last", async () => {
    const first = await connect(OWNER, VERIFIED, TICKED);
    const next = await refresh(first.refresh_token, VERIFIED);
    expect(next.status).toBe(200);
    expect(next.body.synap_acts_as).toBe("person");
    expect(next.body.access_token).not.toBe(first.access_token);
    expect(await keyRow(next.body.access_token)).toMatchObject({
      user_id: OWNER,
      linked_user_id: null,
      key_type: "app_person",
      instance_id: oauthKeyInstanceId(VERIFIED, OWNER),
      is_active: true,
    });
    expect((await keyRow(first.access_token)).is_active).toBe(false);
    expect(
      (await write(next.body.access_token, CONTENT)).decision
    ).toMatchObject({ granted: true });

    // The reuse grace: the same refresh token again, at once, by the same
    // client → the SAME pair, the person's key handed back, not re-minted.
    const again = await refresh(first.refresh_token, VERIFIED);
    expect(again.status).toBe(200);
    expect(again.body.access_token).toBe(next.body.access_token);
    expect(again.body.refresh_token).toBe(next.body.refresh_token);
    expect(again.body.synap_acts_as).toBe("person");
    expect((await keyRow(next.body.access_token)).is_active).toBe(true);
  });

  it("/revoke with the refresh token ends the person's live key too", async () => {
    const pair = await connect(OWNER, VERIFIED, TICKED);
    const res = await oauthApp.request("/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: pair.refresh_token,
        token_type_hint: "refresh_token",
        client_id: VERIFIED,
      }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await keyRow(pair.access_token)).is_active).toBe(false);
    expect((await apiKeyService.validateApiKey(pair.access_token)) ?? null).toBeNull();
  });

  it("revoking the connection (Connected) ends the token and its refresh", async () => {
    const pair = await connect(OWNER, VERIFIED, TICKED);
    expect((await write(pair.access_token, CONTENT)).decision).toMatchObject({
      granted: true,
    });
    const conn = await connectionOf(OWNER, VERIFIED);
    await revokeApp({ publicId: conn.public_id, ownerUserId: OWNER });
    expect((await keyRow(pair.access_token)).is_active).toBe(false);
    const denied = await hub(pair.access_token, "/__probe/write", {
      workspaceId: CONTENT,
    });
    expect(denied.status).toBe(401);
    const after = await refresh(pair.refresh_token, VERIFIED);
    expect(after.status).toBe(400);
    expect(after.body.error).toBe("invalid_grant");
  });
});
