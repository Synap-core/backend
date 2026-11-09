/**
 * An app the person APPROVES acts as them (W3 3c, founder decision
 * 2026-11-09; design pod document 790f5f1c) — end to end on PGlite through the
 * REAL doors, the same harness as pod-app-person-token.pglite.test.ts:
 *
 *   consent (`decideOAuthAuthorization` → `connectOAuthApp`) → `POST /token`
 *   → the app's AGENT token → the real Hub door `POST /apps/:id/act-as-person`
 *   (`requestActAsPerson`, one `app/actAsPerson` proposal) → the ONE approve
 *   door (`applyProposalApproval` → the `app/actAsPerson` executor) →
 *   `grant_type=refresh_token` → `mintAppOAuthAccessKey` →
 *   `podAppConnectionActsAs` → the person-token door → the token presented to
 *   the REAL Hub auth door (`resolveKeyIdentity` → `classifyAppPersonKey` →
 *   `loadPersonTokenApp`) → the real write gate (`checkPermissionOrPropose`).
 *
 * The app is an UNVERIFIED one (`https://leads.example.com`): without the
 * approval its token is its own ask-first agent's; with it, the person's.
 * Every abuse case of the design (§3, A1 to A11) has a case below.
 *
 * Seams replaced: as in the sibling suite (event store and `auditLog` are
 * recorders; `createPendingProposal` inserts on the handle it is given).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "approved-app-acts-as-person-test-jwt-secret";
});

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  /** What the run-choice door asked the gate (D7 case below). */
  runChoiceGate: [] as Array<Record<string, unknown>>,
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
    // The run-choice door's ask (D7 case below): the REAL decision engine
    // (`previewPermissionDecision`, the same ladder the gate runs), answered
    // as the gate answers it. Filing the row itself goes through
    // `@synap/database` helpers on the postgres-js client this harness has not
    // (the same reason the agent cases above preview rather than file).
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      if (opts.action !== "set_run_choice") {
        return (actual.checkPermissionOrPropose as (o: unknown) => unknown)(
          opts
        );
      }
      h.runChoiceGate.push(opts);
      const preview = (await (
        actual.previewPermissionDecision as (o: unknown) => Promise<{
          decision: string;
          reason?: string;
        }>
      )(opts)) as { decision: string; reason?: string };
      if (preview.decision === "propose") {
        return {
          proposalId: "00000000-0000-4000-8000-00000000d007",
          proposalType: "set_run_choice",
        };
      }
      if (preview.decision === "deny") {
        return { denied: true, reason: preview.reason };
      }
      return { granted: true };
    },
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
import { apiKeyService } from "./api-keys.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import { revokeApp, revokeAppActsAsPerson } from "./app-connect.js";
import { registerAppsRoutes } from "../routers/hub-protocol/rest/apps.js";
import { proposalExecRegistry } from "../routers/proposals/execution-registry.js";

const ISSUER = "https://pod.test.synap.live";
const DOC = "/.well-known/synap-client.json";
const VERIFIED = `https://content-studio.synap.live${DOC}`;
const UNVERIFIED = `https://studio.example.com${DOC}`;
const LOOKALIKE = `https://content-studio.synap.live.evil.com${DOC}`;
/** A Synap app that asks to read decisions everywhere (decision e1b59d38 B). */
const DEVPLANE = `https://devplane.synap.live${DOC}`;
const DECISIONS = "entity.decision.read";
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
/** Who runs a playbook (run choice v3): read the playbook, run it. */
const PLAYBOOK_READ = "playbook.read";
const PLAYBOOK_RUN = "playbook.run";
const DECLARED: Record<string, string[]> = {
  [VERIFIED]: [READ, CREATE, APPROVE, PLAYBOOK_READ, PLAYBOOK_RUN],
  [UNVERIFIED]: [READ, CREATE, PLAYBOOK_READ, PLAYBOOK_RUN],
  [LOOKALIKE]: [READ, CREATE],
  [DEVPLANE]: [READ, CREATE, DECISIONS],
};

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
  // Not a proof-of-presence suite: this pod CHOSE `report` (a pod with no
  // setting enforces, services/presence/mode.ts), so its sensitive approvals
  // apply without a proof and are recorded. presence.pglite.test.ts owns the gate.
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
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

async function tokenRequest(body: Record<string, string>) {
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { status: res.status, body: (await res.json()) as any };
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
  registerAppsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const hub = (bearer: string, path: string, body: unknown, method = "POST") =>
  hubApp().request(`/api/hub${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const write = async (bearer: string, workspaceId: string) =>
  (await (await hub(bearer, "/__probe/write", { workspaceId })).json()) as any;

// ─── the approved app (W3 3c) ────────────────────────────────────────────────

const APP = `https://leads.example.com${DOC}`;
const SHA_V1 = "a".repeat(64);
const SHA_V2 = "b".repeat(64);
/** Its document asks for a review verb and `*` too: neither ever acts as you. */
const APP_DECLARED = [READ, CREATE, APPROVE, "*"];
/** OWNER ticks Content (read, create, approve), Ecosystem (read), Finance (`*`). */
const APP_TICKED = [
  { permission: READ, workspaceId: CONTENT },
  { permission: CREATE, workspaceId: CONTENT },
  { permission: APPROVE, workspaceId: CONTENT },
  { permission: READ, workspaceId: ECOSYSTEM },
  { permission: "*", workspaceId: FINANCE },
];
/** What may act as the person: no review verb, no `*` (A9). */
const PERSON_PAIRS = [
  "Content OS:entity.person.create",
  "Content OS:entity.person.read",
  "Ecosystem:entity.person.read",
];

beforeAll(async () => {
  await q(
    `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
       requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, metadata_sha256, created_at)
     values ($1, 'cimd', 'Leads', $2, '{}', $3, '{}', now(), now() + interval '1 hour', $4, now())`,
    [APP, [callbackOf(APP)], APP_DECLARED, SHA_V1]
  );
}, 60_000);

const appParams = (): AuthorizeParams => ({
  clientId: APP,
  redirectUri: callbackOf(APP),
  responseType: "code",
  scope: APP_DECLARED.join(" "),
  state: "st",
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
});

/** Consent + code exchange for the approved-app client. */
async function connectApp(
  person: string,
  approved: Array<{ permission: string; workspaceId: string | null }>
) {
  const { redirectTo } = await decideOAuthAuthorization(
    { ...appParams(), approve: true, approved },
    person,
    { authenticated: true, userId: person } as never
  );
  const code = new URL(redirectTo).searchParams.get("code")!;
  const res = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: APP,
    redirect_uri: callbackOf(APP),
    code_verifier: VERIFIER,
  });
  expect(res.status).toBe(200);
  return res.body;
}

const setSha = (sha: string) =>
  q(`update oauth_clients set metadata_sha256 = $2 where client_id = $1`, [
    APP,
    sha,
  ]);

const grantOf = async (person: string) =>
  (
    await q<{ metadata: Record<string, any> }>(
      `select metadata from apps where owner_user_id = $1 and oauth_client_id = $2 and revoked_at is null`,
      [person, APP]
    )
  ).rows[0]?.metadata?.actsAsPerson ?? null;

/** The app asks, through the REAL Hub door, with its own token. */
async function ask(bearer: string, publicId: string) {
  const res = await hub(bearer, `/apps/${publicId}/act-as-person`, {});
  return { status: res.status, body: (await res.json()) as any };
}

const proposalRow = async (id: string) =>
  (
    await q<{
      status: string;
      target_type: string;
      proposal_type: string;
      target_id: string;
      agent_user_id: string | null;
      workspace_id: string | null;
      data: Record<string, any>;
    }>(
      `select status, target_type, proposal_type, target_id, agent_user_id, workspace_id, data from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;

/** The person approves on the proposal page: a signed-in session, no key. */
async function approveAsPerson(proposalId: string, person = OWNER) {
  const proposal = (await (h.db as any).query.proposals.findMany({})).find(
    (p: { id: string }) => p.id === proposalId
  );
  return applyProposalApproval({
    proposal,
    userId: person,
    input: { proposalId },
    ctx: { userId: person } as never,
  });
}

/** Is a request with this token refused at the door (dead token)? */
const deadAtDoor = async (bearer: string) => {
  const res = await hub(bearer, "/__probe/write", { workspaceId: CONTENT });
  return res.status === 401 || res.status === 403;
};

describe("an approved app acts as you: ask, approve, then its token is yours", () => {
  let first: any;
  let conn: { id: string; public_id: string; agent_user_id: string | null };
  let proposalId: string;

  beforeAll(async () => {
    first = await connectApp(OWNER, APP_TICKED);
    conn = await connectionOf(OWNER, APP);
  }, 60_000);

  it("A1: before any approval its token is its own ask-first agent's; a write is proposed", async () => {
    expect(first.synap_acts_as).toBe("agent");
    expect(await keyRow(first.access_token)).toMatchObject({
      user_id: conn.agent_user_id,
      linked_user_id: OWNER,
      key_type: "hub_inbound",
    });
    const preview = await (
      await hub(first.access_token, "/__probe/preview", {
        workspaceId: CONTENT,
      })
    ).json();
    expect(preview).toEqual({ decision: "propose" });
    expect(await grantOf(OWNER)).toBeNull();
  });

  it("only the app itself may ask: the person's own key and another agent are refused", async () => {
    // The person's own full-access key: not the app's agent.
    const own = await apiKeyService.generateApiKey(
      OWNER,
      "own",
      ["hub-protocol.read", "hub-protocol.write"],
      undefined,
      1
    );
    await attachGrantsOrRevoke({
      apiKeyId: own.keyId,
      principalUserId: OWNER,
      onBehalfOf: OWNER,
      grants: [{ permissions: ["*"] }] as never,
      expiresAt: null,
      createdBy: OWNER,
    } as never);
    const res = await ask(own.key, conn.public_id);
    expect(res.status).toBe(403);
    expect(
      res.body.error ?? res.body.message ?? JSON.stringify(res.body)
    ).toMatch(/Only the app itself/);
  });

  it("the app asks: ONE app/actAsPerson proposal, filed as its agent, pairs frozen without review verbs or `*`", async () => {
    const res = await ask(first.access_token, conn.public_id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    proposalId = res.body.proposalId;
    const row = await proposalRow(proposalId);
    expect(row).toMatchObject({
      status: "pending",
      target_type: "app",
      proposal_type: "actAsPerson",
      target_id: conn.id,
      agent_user_id: conn.agent_user_id,
      workspace_id: null,
    });
    expect(row.data.documentSha256).toBe(SHA_V1);
    expect(row.data.oauthClientId).toBe(APP);
    expect(
      (row.data.requests as Array<{ permission: string; workspaceId: string }>)
        .map((r) => `${SPACE_NAME[r.workspaceId]}:${r.permission}`)
        .sort()
    ).toEqual(PERSON_PAIRS);
    // Asking changes nothing: still the agent until the person says yes.
    expect(await grantOf(OWNER)).toBeNull();
    const next = await refresh(first.refresh_token, APP);
    expect(next.status).toBe(200);
    expect(next.body.synap_acts_as).toBe("agent");
    first = next.body;
  });

  it("A2: the app never approves its own grant — its agent token at the approve door, or the executor called as an agent", async () => {
    const viaDoor = (await (
      await hub(first.access_token, "/__probe/approve", { proposalId })
    ).json()) as any;
    expect(viaDoor.refused).toMatch(/agent credential cannot approve/);
    const executor = proposalExecRegistry.resolveExact("app/actAsPerson")!;
    expect(executor).toBeTruthy();
    const proposal = (await (h.db as any).query.proposals.findMany({})).find(
      (p: { id: string }) => p.id === proposalId
    );
    await expect(
      executor.execute({
        proposal,
        payload: proposal.data,
        userId: OWNER,
        input: { proposalId },
        ctx: { userId: OWNER, agentUserId: conn.agent_user_id } as never,
        deps: {} as never,
      })
    ).rejects.toThrow(/agent credential cannot approve an app acting as you/);
    expect(await grantOf(OWNER)).toBeNull();
  });

  it("the person approves: the grant is recorded on their own connection, 90 days, the document they approved", async () => {
    const result = await approveAsPerson(proposalId);
    expect(result.success).toBe(true);
    const grant = await grantOf(OWNER);
    expect(grant).toMatchObject({
      proposalId,
      approvedBy: OWNER,
      oauthClientId: APP,
      documentSha256: SHA_V1,
    });
    const days =
      (Date.parse(grant.expiresAt) - Date.parse(grant.approvedAt)) / 86_400_000;
    expect(days).toBe(90);
    expect((await proposalRow(proposalId)).status).toBe("approved");
  });

  let personToken: string;
  it("its next token is the PERSON's: synap_acts_as person, app_person key, only the frozen pairs (A9)", async () => {
    const next = await refresh(first.refresh_token, APP);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.synap_acts_as).toBe("person");
    personToken = next.body.access_token;
    const row = await keyRow(personToken);
    expect(row).toMatchObject({
      user_id: OWNER,
      linked_user_id: null,
      key_type: "app_person",
      instance_id: oauthKeyInstanceId(APP, OWNER),
      is_active: true,
    });
    // No review verb, nothing from the `*` ticked in Finance.
    expect(await livePairs(row.id)).toEqual(PERSON_PAIRS);
    // The agent's key in that slot is gone.
    expect((await keyRow(first.access_token)).is_active).toBe(false);
    first = next.body;
  });

  it("a write in-grant is the PERSON's, direct, stamped via the app", async () => {
    const res = await write(personToken, CONTENT);
    expect(res).toMatchObject({
      userId: OWNER,
      agentUserId: null,
      clientId: conn.public_id,
    });
    expect(res.decision).toMatchObject({ granted: true });
  });

  it("A9: it never decides proposals as you, though `proposal.approve` was ticked in Content", async () => {
    const res = (await (
      await hub(personToken, "/__probe/approve", {
        proposalId: PROPOSAL[CONTENT],
      })
    ).json()) as any;
    expect(res.refused).toMatch(/may not approve changes/);
    expect(
      (
        await q(`select status from proposals where id = $1`, [
          PROPOSAL[CONTENT],
        ])
      ).rows[0]
    ).toMatchObject({ status: "pending" });
  });

  it("A9: a `*` ticked in Finance is never the person's (no keys, no vault, no review: nothing)", async () => {
    const res = await write(personToken, FINANCE);
    expect(res.decision).toMatchObject({ denied: true });
  });

  it("A5: a wider re-consent does not widen the person's token", async () => {
    await consentApp(OWNER, [
      ...APP_TICKED,
      { permission: CREATE, workspaceId: ECOSYSTEM },
    ]);
    const next = await refresh(first.refresh_token, APP);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.synap_acts_as).toBe("person");
    expect(await livePairs((await keyRow(next.body.access_token)).id)).toEqual(
      PERSON_PAIRS
    );
    expect(
      (await write(next.body.access_token, ECOSYSTEM)).decision
    ).toMatchObject({ denied: true });
    personToken = next.body.access_token;
    first = next.body;
  });

  it("A4: the app's document changes → the live token is dead on its next request, and the next refresh is the agent's", async () => {
    await setSha(SHA_V2);
    try {
      expect(await deadAtDoor(personToken)).toBe(true);
      const next = await refresh(first.refresh_token, APP);
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      expect(next.body.synap_acts_as).toBe("agent");
      first = next.body;
    } finally {
      await setSha(SHA_V1);
    }
    // The same bytes again: the approval holds again (it names those bytes).
    const back = await refresh(first.refresh_token, APP);
    expect(back.body.synap_acts_as).toBe("person");
    personToken = back.body.access_token;
    first = back.body;
  });

  it("A8: an expired approval is the agent again", async () => {
    await q(
      `update apps set metadata = jsonb_set(metadata, '{actsAsPerson,expiresAt}', to_jsonb($2::text)) where id = $1`,
      [conn.id, new Date(Date.now() - 1000).toISOString()]
    );
    expect(await deadAtDoor(personToken)).toBe(true);
    const next = await refresh(first.refresh_token, APP);
    expect(next.body.synap_acts_as).toBe("agent");
    first = next.body;
  });

  it("A6: an ask whose document changed before the approval is refused; approving it again after is a no-op replay", async () => {
    // A fresh ask (the agent holds the slot again after A8).
    await q(
      `update apps set metadata = metadata - 'actsAsPerson' where id = $1`,
      [conn.id]
    );
    const asked = await ask(first.access_token, conn.public_id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await setSha(SHA_V2);
    try {
      await expect(approveAsPerson(asked.body.proposalId)).rejects.toThrow(
        /changed since it asked/
      );
      expect(await grantOf(OWNER)).toBeNull();
    } finally {
      await setSha(SHA_V1);
    }
    // The old approved proposal, approved again: nothing new is recorded.
    const replay = await approveAsPerson(proposalId);
    expect((replay as any).alreadyApproved).toBe(true);
    expect(await grantOf(OWNER)).toBeNull();
  });
});

describe("revoking: the person takes it back, the app gets nothing back by itself", () => {
  let pair: any;
  let conn: { id: string; public_id: string; agent_user_id: string | null };

  /** Connect, ask, approve, refresh: a person token for OWNER. */
  async function approvedPair() {
    let body = await connectApp(OWNER, APP_TICKED);
    conn = await connectionOf(OWNER, APP);
    if (body.synap_acts_as === "agent") {
      const asked = await ask(body.access_token, conn.public_id);
      expect(asked.status, JSON.stringify(asked.body)).toBe(201);
      await approveAsPerson(asked.body.proposalId);
      body = (await refresh(body.refresh_token, APP)).body;
    }
    expect(body.synap_acts_as).toBe("person");
    return body;
  }

  beforeAll(async () => {
    pair = await approvedPair();
  }, 60_000);

  it("the app's own tokens cannot revoke or re-grant it (owner credential only)", async () => {
    const res = await hub(
      pair.access_token,
      `/apps/${conn.public_id}/act-as-person`,
      {},
      "DELETE"
    );
    expect(res.status).toBe(403);
    expect(await grantOf(OWNER)).not.toBeNull();
  });

  it("A10: the person revokes → the live token is dead now, the grant is gone, the next refresh is the agent's", async () => {
    const out = await revokeAppActsAsPerson({
      publicId: conn.public_id,
      ownerUserId: OWNER,
    });
    expect(out).toEqual({ publicId: conn.public_id, revoked: true });
    expect(await grantOf(OWNER)).toBeNull();
    expect((await keyRow(pair.access_token)).is_active).toBe(false);
    expect(await deadAtDoor(pair.access_token)).toBe(true);
    const next = await refresh(pair.refresh_token, APP);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.synap_acts_as).toBe("agent");
    const preview = await (
      await hub(next.body.access_token, "/__probe/preview", {
        workspaceId: CONTENT,
      })
    ).json();
    expect(preview).toEqual({ decision: "propose" });
  });

  it("A10: a pending ask is withdrawn by the revoke", async () => {
    pair = await approvedPair();
    // A waiting ask, then the revoke.
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, workspace_id, status, data, created_by)
       values ($1,'app',$2,'actAsPerson',null,'pending','{}'::jsonb,$3)`,
      [randomUUID(), conn.id, OWNER]
    );
    await revokeAppActsAsPerson({
      publicId: conn.public_id,
      ownerUserId: OWNER,
    });
    expect(
      (
        await q(
          `select status from proposals where target_id = $1 and proposal_type = 'actAsPerson' and status = 'pending'`,
          [conn.id]
        )
      ).rows
    ).toHaveLength(0);
  });

  it("A10: revoking the APP clears the grant, so reconnecting starts as the agent", async () => {
    pair = await approvedPair();
    await revokeApp({ publicId: conn.public_id, ownerUserId: OWNER });
    const again = await connectApp(OWNER, APP_TICKED);
    expect(again.synap_acts_as).toBe("agent");
    expect(await grantOf(OWNER)).toBeNull();
  });
});

describe("A7: the approval is ONE person's connection, never another member's", () => {
  it("MEMBER connecting the same app is its agent, though OWNER approved theirs", async () => {
    // OWNER's connection approved (the suite above left it agent: approve again).
    let owner = await connectApp(OWNER, APP_TICKED);
    const conn = await connectionOf(OWNER, APP);
    if (owner.synap_acts_as === "agent") {
      const asked = await ask(owner.access_token, conn.public_id);
      await approveAsPerson(asked.body.proposalId);
      owner = (await refresh(owner.refresh_token, APP)).body;
    }
    expect(owner.synap_acts_as).toBe("person");
    const member = await connectApp(MEMBER, [
      { permission: CREATE, workspaceId: CONTENT },
    ]);
    expect(member.synap_acts_as).toBe("agent");
    expect(await keyRow(member.access_token)).toMatchObject({
      key_type: "hub_inbound",
      linked_user_id: MEMBER,
    });
  });

  it("a person cannot approve an ask on someone else's connection", async () => {
    const member = await connectApp(MEMBER, [
      { permission: CREATE, workspaceId: CONTENT },
    ]);
    const memberConn = await connectionOf(MEMBER, APP);
    const asked = await ask(member.access_token, memberConn.public_id);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await expect(approveAsPerson(asked.body.proposalId, OWNER)).rejects.toThrow(
      /Only the person who connected this app/
    );
    expect(await grantOf(MEMBER)).toBeNull();
  });
});

/** Consent only (no exchange): a re-consent's new approval. */
async function consentApp(
  person: string,
  approved: Array<{ permission: string; workspaceId: string | null }>
) {
  await decideOAuthAuthorization(
    { ...appParams(), approve: true, approved },
    person,
    { authenticated: true, userId: person } as never
  );
}
