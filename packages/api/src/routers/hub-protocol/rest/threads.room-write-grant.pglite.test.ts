/**
 * A post in a room needs a WRITE grant, not only a read (plan "The run's room
 * inside the app", lane 1, 9 Nov 2026): `POST /threads/:id/messages` and
 * `.batch` used to floor only on the room's VISIBILITY, so any key that could
 * read a room could write in it — and a person's post answers the session's
 * open question.
 *
 * Driven end to end on PGlite through the REAL doors, keys minted the real
 * way: consent (`decideOAuthAuthorization` → `connectOAuthApp`) → `POST /token`
 * (`oauthApp` → `mintAppOAuthAccessKey` → the person-token door for a Synap
 * app, the app's own agent key for any other) → the token presented to the
 * REAL Hub auth door (`hubAuthMiddleware`: lookup, `resolveKeyIdentity`, W1
 * fence, `runWithGrant`) → the REAL threads routes and the REAL answer loop
 * (`recordOwnerRoomReply`).
 *
 * Four connections of OWNER, each ticking Content OS only:
 *   STUDIO  content-studio.synap.live  person   channel.read + session.update
 *   CRM     crm.synap.live             person   channel.read + entity.deal.update
 *   HUB     hub.synap.live             person   channel.read + message.create
 *   OTHER   studio.example.com         agent    channel.read + session.update
 * and the owner's own AI (Claude Code): an agent key minted by
 * `createNamedAgent`, the "AI — read & propose" preset (no `message.create`).
 *
 * Rows rule out:
 *   - a key that may only READ a session's room posting in it (single and
 *     batch door) — the hole this lane closes;
 *   - the person's official app (session.update) refused in its run's room,
 *     or its post stored as anything but the person's words, or not
 *     answering the open question;
 *   - an agent-acting app's post stored as the person's;
 *   - a room in a space the grant does not tick written;
 *   - a channel that is no session's room written without `message.create`;
 *   - the owner's own AI (`synap session post`) refused in a session's room.
 *
 * Seams replaced, and why: the event store and `auditLog` write through the
 * postgres-js client this harness has not (recorders); `createPendingProposal`
 * inserts on the transaction it is given; the guest check and sub-token
 * mapping are constant answers; the message event, side effects and the AI
 * turn are recorders (a post's fan-out, not its gate).
 *
 * Cannot see: production Postgres; a real Content Studio deployment.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.JWT_SECRET ||= "room-write-grant-test-jwt-secret";
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
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => undefined,
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: async () => false,
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: async () => null,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  return {
    ...actual,
    // The consent files its `app/connect` inside a transaction: the insert
    // runs on that transaction, as the real door does (a PGlite transaction
    // holds the one connection).
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
import { REVERSIBLE_CLASS_PATTERN } from "@synap/governance-policy";
// Registers the grant read provider (as the API does at load).
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import type { HubHono, HubVariables } from "./_shared.js";
import { registerThreadsRoutes } from "./threads.js";
import { oauthApp } from "../../oauth/routes.js";
import {
  decideOAuthAuthorization,
  type AuthorizeParams,
} from "../../oauth/consent.js";
import { computeS256Challenge } from "../../oauth/protocol.js";
import { createNamedAgent } from "../../../services/agent-identity-service.js";
import { passPresenceForAction } from "../../../services/presence/gate.js";

const ISSUER = "https://pod.test.synap.live";
const DOC = "/.well-known/synap-client.json";
const STUDIO = `https://content-studio.synap.live${DOC}`;
const CRM = `https://crm.synap.live${DOC}`;
const HUB = `https://hub.synap.live${DOC}`;
const OTHER = `https://studio.example.com${DOC}`;
const callbackOf = (clientId: string) =>
  `${new URL(clientId).origin}/api/synap/callback`;

const CHANNEL_READ = "channel.read";
const SESSION_UPDATE = "session.update";
const MESSAGE_CREATE = "message.create";
/** Any write: what makes a person token carry `hub-protocol.write`. */
const DEAL_UPDATE = "entity.deal.update";
const DECLARED = [CHANNEL_READ, SESSION_UPDATE, MESSAGE_CREATE, DEAL_UPDATE];

const OWNER = randomUUID();
const CONTENT = randomUUID();
const FINANCE = randomUUID();
/** A run's room in Content OS, and its session. */
const ROOM = randomUUID();
const SESSION = randomUUID();
/** A run's room in Finance (no connection ticks Finance). */
const FINANCE_ROOM = randomUUID();
const FINANCE_SESSION = randomUUID();
/** A plain conversation in Content OS: no session's room. */
const THREAD = randomUUID();

const TICKED: Record<string, string[]> = {
  [STUDIO]: [CHANNEL_READ, SESSION_UPDATE],
  [CRM]: [CHANNEL_READ, DEAL_UPDATE],
  [HUB]: [CHANNEL_READ, MESSAGE_CREATE],
  [OTHER]: [CHANNEL_READ, SESSION_UPDATE],
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
      c.name === "created_at" ||
      c.name === "updated_at" ||
      c.name === "timestamp"
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

/** A session room, as `ensureSessionChannel` mints it, and its session. */
async function seedRun(room: string, session: string, workspaceId: string) {
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, context_object_type, context_object_id, metadata)
     values ($1,$2,$3,'group','workspace','active','Run','focus_session',$4,'{}'::jsonb)`,
    [room, OWNER, workspaceId, session]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, channel_id, goal, status, expected_outputs, metadata)
     values ($1,$2,$3,$4,'Make a carousel','active','[]'::jsonb,'{}'::jsonb)`,
    [session, OWNER, workspaceId, room]
  );
}

beforeAll(async () => {
  process.env.PUBLIC_URL = ISSUER;
  process.env.POD_ADMIN_URL = "https://admin.pod.test.synap.live";
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // Not a proof-of-presence suite: this pod CHOSE `report`, so the consent
  // applies without a proof (presence.pglite.test.ts owns the gate).
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1,'owner@x','Ada','human')`,
    [OWNER]
  );
  for (const [ws, name] of [
    [CONTENT, "Content OS"],
    [FINANCE, "Finance"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  // The pod default (0282): agents act on reversible writes.
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
     values ($1,'any','pod','action',$2,'auto','system:reversible-default')`,
    [randomUUID(), REVERSIBLE_CLASS_PATTERN]
  );
  // Fresh metadata-document cache rows: `resolveCimdClient` serves them.
  for (const clientId of [STUDIO, CRM, HUB, OTHER]) {
    await q(
      `insert into oauth_clients (client_id, client_kind, client_name, redirect_uris, scopes,
         requested_permissions, requested_templates, metadata_fetched_at, metadata_expires_at, created_at)
       values ($1, 'cimd', 'Room app', $2, '{}', $3, '{}', now(), now() + interval '1 hour', now())`,
      [clientId, [callbackOf(clientId)], DECLARED]
    );
  }
  await seedRun(ROOM, SESSION, CONTENT);
  await seedRun(FINANCE_ROOM, FINANCE_SESSION, FINANCE);
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, scope, status, title, metadata)
     values ($1,$2,$3,'thread','workspace','active','Notes','{}'::jsonb)`,
    [THREAD, OWNER, CONTENT]
  );
}, 180_000);

// ─── keys, minted the real way ───────────────────────────────────────────────

const params = (clientId: string): AuthorizeParams => ({
  clientId,
  redirectUri: callbackOf(clientId),
  responseType: "code",
  scope: DECLARED.join(" "),
  state: "st",
  codeChallenge: CHALLENGE,
  codeChallengeMethod: "S256",
});

/** OWNER's consent for what `TICKED` names in Content OS → the /token answer. */
async function connect(clientId: string) {
  const { redirectTo } = await decideOAuthAuthorization(
    {
      ...params(clientId),
      approve: true,
      approved: TICKED[clientId]!.map((permission) => ({
        permission,
        workspaceId: CONTENT,
      })),
    },
    OWNER,
    { authenticated: true, userId: OWNER } as never
  );
  const code = new URL(redirectTo).searchParams.get("code")!;
  const res = await oauthApp.request("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: callbackOf(clientId),
      code_verifier: VERIFIER,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    access_token: string;
    synap_acts_as: "person" | "agent";
  };
}

const keyRow = async (plain: string) =>
  (
    await q<{ user_id: string; key_type: string; scope: string[] }>(
      `select user_id, key_type, scope from api_keys where key_lookup_hash = $1`,
      [createHash("sha256").update(plain).digest("hex")]
    )
  ).rows[0]!;

const appAgentOf = async (clientId: string) =>
  (
    await q<{ agent_user_id: string | null }>(
      `select agent_user_id from apps where owner_user_id = $1 and oauth_client_id = $2 and revoked_at is null`,
      [OWNER, clientId]
    )
  ).rows[0]!.agent_user_id;

// ─── the Hub door ────────────────────────────────────────────────────────────

function hubApp() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerThreadsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

async function post(bearer: string, channelId: string, body: unknown) {
  const res = await hubApp().request(
    `/api/hub/threads/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function postBatch(bearer: string, channelId: string, items: unknown[]) {
  const res = await hubApp().request(
    `/api/hub/threads/${channelId}/messages.batch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: items }),
    }
  );
  return { status: res.status, body: (await res.json()) as any };
}

const messagesIn = async (channelId: string) =>
  (
    await q<{
      id: string;
      content: string;
      user_id: string;
      author_type: string;
      routed_teammate_id: string | null;
      metadata: Record<string, any> | null;
    }>(
      `select id, content, user_id, author_type, routed_teammate_id, metadata from messages where channel_id = $1`,
      [channelId]
    )
  ).rows;

// ─── the rows ────────────────────────────────────────────────────────────────

describe("a post in a room needs a write grant, not only a read", () => {
  const token: Record<string, string> = {};
  /** The owner's own AI, as `synap init` connects Claude Code. */
  let claude: { agentUserId: string; apiKey: string };
  beforeAll(async () => {
    for (const clientId of [STUDIO, CRM, HUB, OTHER]) {
      token[clientId] = (await connect(clientId)).access_token;
    }
    const { pass } = await passPresenceForAction({
      userId: OWNER,
      path: "agentUsers.create",
      input: {},
    });
    claude = await createNamedAgent({
      name: "Claude Code",
      agentType: "claude",
      createdByUserId: OWNER,
      presence: pass,
    });
  }, 120_000);

  it("the keys are what production mints: the person's for a Synap app, the app's agent's for any other", async () => {
    for (const clientId of [STUDIO, CRM, HUB]) {
      const row = await keyRow(token[clientId]!);
      expect(row).toMatchObject({ user_id: OWNER, key_type: "app_person" });
      // Every one may write SOMETHING: a refusal below is the grant's verdict
      // on the room, never the key's missing `hub-protocol.write` scope.
      expect(row.scope).toContain("hub-protocol.write");
    }
    const other = await keyRow(token[OTHER]!);
    expect(other.key_type).toBe("hub_inbound");
    expect(other.user_id).toBe(await appAgentOf(OTHER));
  });

  it("the agent-acting app asks in the run's room: stored as its agent, never as the person", async () => {
    const res = await post(token[OTHER]!, ROOM, {
      role: "assistant",
      content: "Which pillar is this carousel for?",
      userId: OWNER,
      kind: "question",
    });
    expect(res.status).toBe(200);
    const [row] = (await messagesIn(ROOM)).filter(
      (m) => m.id === res.body.messageId
    );
    expect(row).toMatchObject({
      user_id: OWNER,
      author_type: "ai_agent",
      routed_teammate_id: await appAgentOf(OTHER),
    });
  });

  it("the person's official app writes in its run's room as the person, and its words answer the open question", async () => {
    const res = await post(token[STUDIO]!, ROOM, {
      role: "user",
      content: "The craft pillar.",
      userId: OWNER,
    });
    expect(res.status).toBe(200);
    const rows = await messagesIn(ROOM);
    const mine = rows.find((m) => m.id === res.body.messageId)!;
    expect(mine).toMatchObject({
      user_id: OWNER,
      author_type: "human",
      routed_teammate_id: null,
    });
    const question = rows.find((m) => m.author_type === "ai_agent")!;
    expect(question.metadata?.roomPost?.answer).toMatchObject({
      messageId: mine.id,
      answeredBy: OWNER,
    });
  });

  it("a key that may only READ the room cannot write in it — single and batch door, nothing stored", async () => {
    const before = (await messagesIn(ROOM)).length;
    const single = await post(token[CRM]!, ROOM, {
      role: "user",
      content: "Also add a slide on pricing.",
      userId: OWNER,
    });
    expect(single.status).toBe(403);
    expect(single.body.error).toMatch(/grant does not allow "session\.update"/);
    const batch = await postBatch(token[CRM]!, ROOM, [
      { role: "user", content: "Also add a slide on pricing.", userId: OWNER },
    ]);
    expect(batch.status).toBe(403);
    expect(batch.body.error).toMatch(/grant does not allow "session\.update"/);
    expect(await messagesIn(ROOM)).toHaveLength(before);
  });

  it("a room in a space the grant does not tick is refused", async () => {
    const res = await post(token[STUDIO]!, FINANCE_ROOM, {
      role: "user",
      content: "Hello",
      userId: OWNER,
    });
    expect(res.status).toBe(403);
    expect(await messagesIn(FINANCE_ROOM)).toHaveLength(0);
  });

  it("a channel that is no session's room needs message.create on its space", async () => {
    for (const clientId of [STUDIO, OTHER]) {
      const res = await post(token[clientId]!, THREAD, {
        role: "user",
        content: "A note",
        userId: OWNER,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/grant does not allow "message\.create"/);
    }
    expect(await messagesIn(THREAD)).toHaveLength(0);
    const allowed = await post(token[HUB]!, THREAD, {
      role: "user",
      content: "A note",
      userId: OWNER,
    });
    expect(allowed.status).toBe(200);
    expect(await messagesIn(THREAD)).toHaveLength(1);
  });

  it("the owner's own AI keeps talking in a session's room (session.update), and is refused a plain channel", async () => {
    const grant = (
      await q<{ permissions: string[] }>(
        `select g.permissions from grants g join api_keys k on k.id = g.api_key_id
         where k.key_lookup_hash = $1 and g.revoked_at is null`,
        [createHash("sha256").update(claude.apiKey).digest("hex")]
      )
    ).rows.flatMap((g) => g.permissions);
    // The preset: a session update, no message.create — so the room post
    // below passes on the session's rung, and the plain channel is refused.
    expect(grant).toContain(SESSION_UPDATE);
    expect(grant).not.toContain(MESSAGE_CREATE);
    expect(grant).not.toContain("*");
    const res = await post(claude.apiKey, ROOM, {
      role: "assistant",
      content: "checkpoint: carousel drafted",
      userId: OWNER,
    });
    expect(res.status).toBe(200);
    const [row] = (await messagesIn(ROOM)).filter(
      (m) => m.id === res.body.messageId
    );
    expect(row).toMatchObject({
      author_type: "ai_agent",
      routed_teammate_id: claude.agentUserId,
    });
    const plain = await post(claude.apiKey, THREAD, {
      role: "assistant",
      content: "A note",
      userId: OWNER,
    });
    expect(plain.status).toBe(403);
    expect(plain.body.error).toMatch(/grant does not allow "message\.create"/);
  });
});
