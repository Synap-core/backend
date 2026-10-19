/**
 * PROVIDE asks, answered — the server doors every surface shares, through the
 * REAL services against PGlite:
 *
 *   - SECRET: handing a secret over grants the agent that POSED the ask (read
 *     from the durable `slot_asked` record, never from the client) a 60-minute
 *     session read, through the one grant writer; the receipt says so. An
 *     agent the pod cannot name gets nothing, and neither does a stale asker,
 *     a person, a key without `vault.grant`, or someone else's secret. A
 *     refused answer takes back the read it wrote. The read is redeemable by
 *     that agent only, and not once it expired (the real resolver).
 *   - OPTIONS: what the person can hand over, owner-floored.
 *   - FILE LANDING (P3): the session's space, else the project's home, else
 *     refused in words.
 *   - CONNECT-AND-ANSWER: a pending intent is answered once by the new
 *     connection row — through the real reconciler too — and never by someone
 *     else's connection, another provider, a re-asked slot or an expired one.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  db: null as unknown,
  keyDenial: null as string | null,
  writable: new Set<string>(),
  integrations: [] as Array<{
    uniqueKey: string;
    provider: string;
    displayName: string;
  }>,
  forceAnswerRefusal: false,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const schema = await import("@synap/database/schema");
  h.db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      notifications: actual.notifications as never,
      notificationPreferences: actual.notificationPreferences as never,
      users: actual.users as never,
      channels: actual.channels as never,
      channelMembers: actual.channelMembers as never,
      messages: actual.messages as never,
      apiKeys: actual.apiKeys as never,
      sessionEvaluations: actual.sessionEvaluations as never,
      vaultGrants: schema.vaultGrants as never,
      secrets: schema.secrets as never,
    },
  });
  return {
    ...actual,
    db: h.db,
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
    encryptServerSide: () => ({ encryptedData: "x", iv: "x", authTag: "x" }),
  };
});
// The REAL redeem resolver reads through the database package's own client,
// whose `execute` returns postgres-js's row list (PGlite's carries `.rows`).
vi.mock(
  "../../../../../database/dist/client-pg.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getDb: async () =>
      new Proxy(h.db as Record<string | symbol, unknown>, {
        get(target, prop) {
          if (prop === "execute") {
            return async (query: unknown) =>
              (
                (await (
                  target.execute as (q: unknown) => Promise<{ rows: unknown[] }>
                ).call(target, query)) as { rows: unknown[] }
              ).rows;
          }
          const value = target[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  })
);
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../utils/channel-visibility.js", async () => {
  const { sql } = await import("drizzle-orm");
  return { channelVisibilityWhere: () => sql`true` };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => true,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: async () => undefined,
}));
vi.mock("../../../utils/grant-write-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  grantWriteDenial: async () => h.keyDenial,
}));
vi.mock("../../../routers/file-upload.js", () => ({
  canWriteWorkspace: async (_userId: string, workspaceId: string) =>
    h.writable.has(workspaceId),
}));
vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBroker: async () => ({
    ok: true,
    broker: {
      listIntegrationsResult: async () => ({
        ok: true,
        integrations: h.integrations,
      }),
    },
  }),
}));
vi.mock("../../event-sync/connection-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enqueueConnectionSync: async () => undefined,
}));
// The commit's own refusals are pinned by the answer-slot suites; here only
// WHAT the answer door does after one matters.
vi.mock("../answer-slot.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.answerExpectedOutput as (p: unknown) => Promise<unknown>;
  return {
    ...actual,
    answerExpectedOutput: async (p: unknown) =>
      h.forceAnswerRefusal ? { status: "ask_changed" } : real(p),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  notificationPreferences,
  users,
  channels,
  channelMembers,
  messages,
  apiKeys,
  sessionEvaluations,
  findRedeemableGrant,
} from "@synap/database";
import {
  secrets,
  entities,
  events,
  vaultGrants,
  workspaces,
  projects,
  capabilities,
  links,
  tools,
} from "@synap/database/schema";
import { askFingerprint, type Ask } from "@synap-core/types/ask";
import { answerSessionSlot } from "../session-answer.js";
import { slotAskedEventData } from "../slot-asked-event.js";
import {
  loadOwedProvideAsk,
  readProvideOptions,
  resolveProvideFileLanding,
  type ProvideOptions,
} from "../provide-options.js";
import {
  answerPendingProvideConnects,
  matchIntegration,
  recordProvideConnectIntent,
  sameService,
} from "../provide-connect.js";
import { syncNangoConnectionsToRegistry } from "../../capabilities/capability-nango-sync.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
} from "../lifecycle-events.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const LABEL = "Stripe key";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const dflt =
      c.name === "created_at" || c.name === "timestamp"
        ? " default now()"
        : c.name === "use_count" || c.name === "access_count"
          ? " default 0"
          : c.name === "metadata"
            ? " default '{}'::jsonb"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const secretAsk = (name = "STRIPE_KEY"): Ask => ({
  mode: "provide",
  provide: { kind: "secret", name },
});
const slotFor = (ask: Ask, label = LABEL) => ({
  kind: "document",
  label,
  owner: "human",
  blockedReason: "credential",
  why: "Needed for the export",
  owedSince: "2026-10-19T09:00:00.000Z",
  ask,
});

async function seedSession(
  slots: unknown[],
  opts: { workspaceId?: string | null; projectId?: string | null } = {}
): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Export', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, workspace_id, project_id, created_at, updated_at, started_at)
     values ($1, $2, 'Export', 'Export', 'active', $3::jsonb, $4, '{}'::jsonb, '[]'::jsonb, $5, $6, $7, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      JSON.stringify(slots),
      [AGENT],
      channelId,
      opts.workspaceId ?? null,
      opts.projectId ?? null,
    ]
  );
  return { sessionId, channelId };
}

/** The durable record of the ask as posed — what the block door writes. */
async function recordAsked(
  sessionId: string,
  ask: Ask,
  agentUserId: string | null,
  label = LABEL
): Promise<void> {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, source) values ($1, now(), $2, $3, $4, $5::jsonb, $6, 'intelligence')`,
    [
      randomUUID(),
      FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
      sessionId,
      FOCUS_SESSION_SUBJECT_TYPE,
      JSON.stringify(
        slotAskedEventData(sessionId, slotFor(ask, label) as never, agentUserId)
      ),
      OWNER,
    ]
  );
}

async function seedSecret(p: {
  userId: string;
  name?: string;
  capabilityId?: string;
  isPodWide?: boolean;
  accountHint?: string;
  mode?: "server" | "client";
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into secrets (id, user_id, name, type, encrypted_data, iv, auth_tag, encryption_mode, capability_id, is_pod_wide, account_hint, is_favorite, access_count, has_totp, is_shared, is_default, auth_fail_count, encryption_version, created_at, updated_at)
     values ($1, $2, $3, 'api_key', 'x', 'x', 'x', $4, $5, $6, $7, false, 0, false, false, false, 0, 1, now(), now())`,
    [
      id,
      p.userId,
      p.name ?? "STRIPE_KEY",
      p.mode ?? "server",
      p.capabilityId ?? null,
      p.isPodWide ?? false,
      p.accountHint ?? null,
    ]
  );
  return id;
}

const grantsFor = async (secretId: string) =>
  (
    await q<{
      id: string;
      granted_to: string | null;
      workspace_id: string | null;
      scope: string;
      expires_at: string | null;
      revoked_at: string | null;
      created_by: string;
    }>(
      `select id, granted_to, workspace_id, scope, expires_at, revoked_at, created_by from vault_grants where grantable_id = $1`,
      [secretId]
    )
  ).rows;

const answerSecret = (sessionId: string, secretId: string, userId = OWNER) =>
  answerSessionSlot({
    sessionId,
    userId,
    expectedLabel: LABEL,
    value: {
      type: "provide",
      ref: { kind: "secret", vaultRef: `vault://${secretId}` },
    },
  });

const slotOf = async (sessionId: string) =>
  (
    await q<{ expected_outputs: Array<Record<string, unknown>> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.expected_outputs.find((s) => s.label === LABEL)!;

describe("provide asks — the server doors", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      notifications,
      notificationPreferences,
      users,
      channels,
      channelMembers,
      messages,
      apiKeys,
      sessionEvaluations,
      secrets,
      entities,
      events,
      vaultGrants,
      workspaces,
      projects,
      capabilities,
      links,
      tools,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
        ($2, 'o@example.test', 'Other', 'UTC', 'human', null),
        ($3, 'r@example.test', 'Researcher', 'UTC', 'agent', 'researcher'),
        ($4, 'w@example.test', 'Writer', 'UTC', 'agent', 'writer')`,
      [OWNER, OTHER, AGENT, OTHER_AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.keyDenial = null;
    h.writable.clear();
    h.integrations = [];
    h.forceAnswerRefusal = false;
  });

  // ── secret: one act of consent ──────────────────────────────────────────

  describe("a handed-over secret", () => {
    it("grants the agent that posed the ask a 60-minute session read, and the receipt says so", async () => {
      const secretId = await seedSecret({ userId: OWNER });
      const { sessionId, channelId } = await seedSession([
        slotFor(secretAsk()),
      ]);
      await recordAsked(sessionId, secretAsk(), AGENT);

      const before = Date.now();
      const r = await answerSecret(sessionId, secretId);
      expect(r.status).toBe("answered");
      if (r.status !== "answered") return;
      expect(r.secretGrant).toMatchObject({
        status: "granted",
        agentUserId: AGENT,
        agentName: "Researcher",
      });

      const [grant, ...more] = await grantsFor(secretId);
      expect(more).toHaveLength(0);
      expect(grant).toMatchObject({
        granted_to: AGENT,
        workspace_id: null,
        scope: "session",
        revoked_at: null,
        created_by: OWNER,
      });
      const ttl = Date.parse(grant!.expires_at!) - before;
      expect(ttl).toBeGreaterThan(59 * 60_000);
      expect(ttl).toBeLessThanOrEqual(60 * 60_000 + 5_000);

      const receipt =
        'Stored the secret "STRIPE_KEY" in the vault · Researcher can read it for 60 minutes, in this session';
      expect((r.answer as { text: string }).text).toBe(receipt);
      const room = await q<{ content: string }>(
        `select content from messages where channel_id = $1`,
        [channelId]
      );
      expect(room.rows.map((m) => m.content)).toEqual([receipt]);
      expect(JSON.stringify(room.rows)).not.toContain(secretId);
    });

    it("the read is the asking agent's alone, and ends when it expires", async () => {
      const secretId = await seedSecret({ userId: OWNER });
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      await recordAsked(sessionId, secretAsk(), AGENT);
      await answerSecret(sessionId, secretId);

      await expect(
        findRedeemableGrant("secret", secretId, { agentUserId: AGENT })
      ).resolves.toMatchObject({ ok: true });
      await expect(
        findRedeemableGrant("secret", secretId, { agentUserId: OTHER_AGENT })
      ).resolves.toEqual({ ok: false, code: "no_grant" });

      await q(
        `update vault_grants set expires_at = now() - interval '1 minute' where grantable_id = $1`,
        [secretId]
      );
      await expect(
        findRedeemableGrant("secret", secretId, { agentUserId: AGENT })
      ).resolves.toEqual({ ok: false, code: "grant_expired" });
    });

    it.each([
      ["no record of who asked", null, "none"],
      ["a person posed the ask", null, "person"],
      ["the record names a person, not an agent", OTHER, "agent"],
      ["only an OLDER ask was posed by an agent", AGENT, "stale"],
    ] as const)(
      "agent unknown (%s): no read, the hand-over stands and says so",
      async (_case, asker, shape) => {
        const secretId = await seedSecret({ userId: OWNER });
        const { sessionId } = await seedSession([
          slotFor(secretAsk("STRIPE_KEY")),
        ]);
        if (shape === "person") await recordAsked(sessionId, secretAsk(), null);
        if (shape === "agent") await recordAsked(sessionId, secretAsk(), asker);
        if (shape === "stale") {
          await recordAsked(sessionId, secretAsk("OLD_KEY"), asker);
        }

        const r = await answerSecret(sessionId, secretId);
        expect(r.status).toBe("answered");
        if (r.status !== "answered") return;
        expect(r.secretGrant).toEqual({
          status: "refused",
          reason: "agent_unknown",
        });
        expect(await grantsFor(secretId)).toHaveLength(0);
        expect((r.answer as { text: string }).text).toBe(
          'Stored the secret "STRIPE_KEY" in the vault · No agent can read it yet'
        );
        // The reference itself was handed over.
        expect((await slotOf(sessionId)).answer).toMatchObject({
          value: {
            type: "provide",
            ref: { kind: "secret", vaultRef: `vault://${secretId}` },
          },
        });
      }
    );

    it("wrong owner: someone else's session or someone else's secret grants nothing", async () => {
      const mine = await seedSecret({ userId: OWNER });
      const theirs = await seedSecret({ userId: OTHER });
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      await recordAsked(sessionId, secretAsk(), AGENT);

      expect(await answerSecret(sessionId, mine, OTHER)).toEqual({
        status: "not_found",
      });
      expect(await answerSecret(sessionId, theirs)).toMatchObject({
        status: "ask_invalid",
        code: "provide_unreachable",
      });
      expect(await grantsFor(mine)).toHaveLength(0);
      expect(await grantsFor(theirs)).toHaveLength(0);
    });

    it("a key that may not grant vault access hands over without a read", async () => {
      h.keyDenial = 'This key\'s grant does not allow "vault.grant".';
      const secretId = await seedSecret({ userId: OWNER });
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      await recordAsked(sessionId, secretAsk(), AGENT);
      const r = await answerSecret(sessionId, secretId);
      expect(r).toMatchObject({
        status: "answered",
        secretGrant: { status: "refused", reason: "key_not_allowed" },
      });
      expect(await grantsFor(secretId)).toHaveLength(0);
    });

    it("a legacy client-encrypted secret is never granted (the pod cannot read it)", async () => {
      const secretId = await seedSecret({ userId: OWNER, mode: "client" });
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      await recordAsked(sessionId, secretAsk(), AGENT);
      const r = await answerSecret(sessionId, secretId);
      expect(r).toMatchObject({
        status: "answered",
        secretGrant: { status: "refused", reason: "not_grantable" },
      });
      expect(await grantsFor(secretId)).toHaveLength(0);
    });

    it("an answer refused at the commit takes back the read it wrote", async () => {
      const secretId = await seedSecret({ userId: OWNER });
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      await recordAsked(sessionId, secretAsk(), AGENT);
      h.forceAnswerRefusal = true;
      expect(await answerSecret(sessionId, secretId)).toEqual({
        status: "ask_changed",
      });
      const [grant] = await grantsFor(secretId);
      expect(grant?.revoked_at).not.toBeNull();
      await expect(
        findRedeemableGrant("secret", secretId, { agentUserId: AGENT })
      ).resolves.toMatchObject({ ok: false });
    });
  });

  // ── options ─────────────────────────────────────────────────────────────

  describe("provideOptions", () => {
    const options = async (sessionId: string, userId = OWNER) => {
      const owed = await loadOwedProvideAsk({
        sessionId,
        userId,
        expectedLabel: LABEL,
      });
      if ("status" in owed) return owed;
      return readProvideOptions(owed, userId);
    };

    it("secret: the person's own readable entries by name, and who would read it", async () => {
      const name = `KEY_${randomUUID().slice(0, 6)}`;
      const own = await seedSecret({ userId: OWNER, name });
      await seedSecret({ userId: OTHER, name });
      await seedSecret({ userId: OWNER, name, mode: "client" });
      await seedSecret({ userId: OWNER, name, capabilityId: randomUUID() });
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      await recordAsked(sessionId, secretAsk(), AGENT);

      const o = (await options(sessionId)) as ProvideOptions;
      expect(o.kind).toBe("secret");
      if (o.kind !== "secret") return;
      expect(o.secret.rows.filter((r) => r.name === name)).toEqual([
        { ref: `vault://${own}`, name, type: "api_key" },
      ]);
      expect(JSON.stringify(o)).not.toContain('"x"');
      expect(o.secret.grant).toEqual({
        status: "will_grant",
        agentName: "Researcher",
        minutes: 60,
      });
      expect(o.askFingerprint).toBe(askFingerprint(secretAsk()));
    });

    it("refuses another person's session, a stale fingerprint and a non-provide ask", async () => {
      const { sessionId } = await seedSession([slotFor(secretAsk())]);
      expect(await options(sessionId, OTHER)).toEqual({ status: "not_found" });
      expect(
        await loadOwedProvideAsk({
          sessionId,
          userId: OWNER,
          expectedLabel: LABEL,
          askFingerprint: "stale",
        })
      ).toEqual({ status: "ask_changed" });
      const confirm = await seedSession([slotFor({ mode: "confirm" })]);
      expect(await options(confirm.sessionId)).toMatchObject({
        status: "ask_invalid",
      });
    });

    it("connection: usable rows for THIS service only, with account hints; several ⇒ confirm", async () => {
      h.integrations = [
        {
          uniqueKey: "google-mail",
          provider: "google-mail",
          displayName: "Gmail",
        },
      ];
      const gmailCap = randomUUID();
      const toolId = randomUUID();
      await q(
        `insert into capabilities (id, created_by, name, approved, metadata, created_at, updated_at) values ($1, $2, 'Mail', true, '{}'::jsonb, now(), now())`,
        [gmailCap, OWNER]
      );
      await q(
        `insert into tools (id, credential_ref, config) values ($1, 'nango://google-mail', '{}'::jsonb)`,
        [toolId]
      );
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1, 'tool', $2, 'capability', $3, 'member_of')`,
        [randomUUID(), toolId, gmailCap]
      );
      const stripeCap = randomUUID();
      await q(
        `insert into capabilities (id, created_by, name, approved, metadata, created_at, updated_at) values ($1, $2, 'Stripe', true, '{}'::jsonb, now(), now())`,
        [stripeCap, OWNER]
      );
      const a = await seedSecret({
        userId: OWNER,
        capabilityId: gmailCap,
        accountHint: "conn-a",
      });
      const shared = await seedSecret({
        userId: OTHER,
        capabilityId: gmailCap,
        isPodWide: true,
      });
      await seedSecret({ userId: OTHER, capabilityId: gmailCap }); // their private one
      await seedSecret({ userId: OWNER, capabilityId: stripeCap }); // another service

      const ask: Ask = {
        mode: "provide",
        provide: { kind: "connection", service: "gmail" },
      };
      const { sessionId } = await seedSession([slotFor(ask)]);
      const o = (await options(sessionId)) as ProvideOptions;
      expect(o.kind).toBe("connection");
      if (o.kind !== "connection") return;
      expect(o.connection.rows.map((r) => r.id).sort()).toEqual(
        [a, shared].sort()
      );
      expect(o.connection.rows.find((r) => r.id === a)?.accountHint).toBe(
        "conn-a"
      );
      expect(o.connection).toMatchObject({
        serviceName: "Gmail",
        providerId: "google-mail",
        connectable: true,
        unavailable: null,
        confirmAccount: true,
      });

      // Matched by the capability's name too (a pure-vault connection).
      const stripe = await seedSession([
        slotFor({
          mode: "provide",
          provide: { kind: "connection", service: "stripe" },
        }),
      ]);
      const s = (await options(stripe.sessionId)) as ProvideOptions;
      expect(s.kind === "connection" && s.connection).toMatchObject({
        rows: [expect.objectContaining({ podWide: false })],
        connectable: false,
        unavailable: "not_offered",
        confirmAccount: false,
      });
    });
  });

  // ── file landing (P3) ───────────────────────────────────────────────────

  describe("where a file lands", () => {
    async function space(name: string): Promise<string> {
      const id = randomUUID();
      await q(
        `insert into workspaces (id, owner_id, name, created_at, updated_at) values ($1, $2, $3, now(), now())`,
        [id, OWNER, name]
      );
      return id;
    }

    it("the session's own space first", async () => {
      const ws = await space("Research");
      h.writable.add(ws);
      expect(
        await resolveProvideFileLanding({
          userId: OWNER,
          session: { workspaceId: ws, projectId: null },
        })
      ).toEqual({
        status: "ready",
        workspaceId: ws,
        workspaceName: "Research",
        projectId: null,
        via: "session_space",
      });
    });

    it("no session space: the project's home space, filed into the project", async () => {
      const home = await space("Client work");
      h.writable.add(home);
      const projectId = randomUUID();
      await q(
        `insert into projects (id, user_id, workspace_id, name, created_at, updated_at) values ($1, $2, $3, 'Acme', now(), now())`,
        [projectId, OWNER, home]
      );
      expect(
        await resolveProvideFileLanding({
          userId: OWNER,
          session: { workspaceId: null, projectId },
        })
      ).toEqual({
        status: "ready",
        workspaceId: home,
        workspaceName: "Client work",
        projectId,
        via: "project_home",
      });
    });

    it("refuses with words: neither a space nor a home, or a space the person can't write", async () => {
      const homeless = randomUUID();
      await q(
        `insert into projects (id, user_id, workspace_id, name, created_at, updated_at) values ($1, $2, null, 'Loose', now(), now())`,
        [homeless, OWNER]
      );
      for (const session of [
        { workspaceId: null, projectId: null },
        { workspaceId: null, projectId: homeless },
      ]) {
        expect(
          await resolveProvideFileLanding({ userId: OWNER, session })
        ).toMatchObject({
          status: "refused",
          message: expect.stringContaining("nowhere to save the file"),
        });
      }
      const readOnly = await space("Shared");
      expect(
        await resolveProvideFileLanding({
          userId: OWNER,
          session: { workspaceId: readOnly, projectId: null },
        })
      ).toMatchObject({
        status: "refused",
        message: expect.stringContaining("You can't add files to Shared"),
      });
    });
  });

  // ── connect-and-answer ──────────────────────────────────────────────────

  describe("connect-and-answer", () => {
    const connAsk: Ask = {
      mode: "provide",
      provide: { kind: "connection", service: "gmail" },
    };
    async function pending(opts: { startedMinutesAgo?: number } = {}) {
      const { sessionId } = await seedSession([slotFor(connAsk)]);
      await recordProvideConnectIntent({
        sessionId,
        userId: OWNER,
        label: LABEL,
        provider: "google-mail",
        askFingerprint: askFingerprint(connAsk),
      });
      if (opts.startedMinutesAgo) {
        await q(
          `update focus_sessions set metadata = jsonb_set(metadata, ARRAY['provideConnect', $2, 'startedAt'], to_jsonb($3::text)) where id = $1`,
          [
            sessionId,
            LABEL.toLowerCase(), // the intent key: the normalized label
            new Date(
              Date.now() - opts.startedMinutesAgo * 60_000
            ).toISOString(),
          ]
        );
      }
      return sessionId;
    }
    const intents = async (sessionId: string) =>
      (
        await q<{ m: Record<string, unknown> | null }>(
          `select metadata -> 'provideConnect' as m from focus_sessions where id = $1`,
          [sessionId]
        )
      ).rows[0]!.m ?? {};
    const conn = (userId = OWNER) =>
      seedSecret({ userId, capabilityId: randomUUID(), accountHint: "c" });
    // Each case counts only the intents it left.
    beforeEach(async () => {
      await q(
        `update focus_sessions set metadata = metadata - 'provideConnect'`
      );
    });

    it("the new connection answers the waiting slot, once", async () => {
      const sessionId = await pending();
      const connectionId = await conn();
      expect(
        await answerPendingProvideConnects({
          userId: OWNER,
          provider: "google-mail",
          connectionId,
        })
      ).toBe(1);
      expect((await slotOf(sessionId)).answer).toMatchObject({
        text: "Connected Gmail",
        value: { type: "provide", ref: { kind: "connection", connectionId } },
      });
      expect(await intents(sessionId)).toEqual({});
      // A second reconcile finds nothing waiting.
      expect(
        await answerPendingProvideConnects({
          userId: OWNER,
          provider: "google-mail",
          connectionId: await conn(),
        })
      ).toBe(0);
    });

    it("someone else's connection, or another provider, answers nothing", async () => {
      const sessionId = await pending();
      expect(
        await answerPendingProvideConnects({
          userId: OTHER,
          provider: "google-mail",
          connectionId: await conn(OTHER),
        })
      ).toBe(0);
      expect(
        await answerPendingProvideConnects({
          userId: OWNER,
          provider: "slack",
          connectionId: await conn(),
        })
      ).toBe(0);
      expect((await slotOf(sessionId)).answer).toBeUndefined();
      expect(Object.keys(await intents(sessionId))).toHaveLength(1);
    });

    it("a re-asked slot is not answered with the stale intent", async () => {
      const sessionId = await pending();
      // The agent re-asked for a different account kind meanwhile.
      const reasked = slotFor({
        mode: "provide",
        provide: { kind: "connection", service: "google-workspace" },
      });
      await q(
        `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
        [sessionId, JSON.stringify([reasked])]
      );
      expect(
        await answerPendingProvideConnects({
          userId: OWNER,
          provider: "google-mail",
          connectionId: await conn(),
        })
      ).toBe(0);
      expect((await slotOf(sessionId)).answer).toBeUndefined();
      expect(await intents(sessionId)).toEqual({});
    });

    it("an expired intent is dropped unanswered", async () => {
      const sessionId = await pending({ startedMinutesAgo: 31 });
      expect(
        await answerPendingProvideConnects({
          userId: OWNER,
          provider: "google-mail",
          connectionId: await conn(),
        })
      ).toBe(0);
      expect((await slotOf(sessionId)).answer).toBeUndefined();
      expect(await intents(sessionId)).toEqual({});
    });

    it("through the real reconciler: mirroring the new connection answers the slot", async () => {
      const sessionId = await pending();
      const cap = randomUUID();
      const toolId = randomUUID();
      await q(
        `insert into tools (id, credential_ref, config) values ($1, 'nango://google-mail', '{}'::jsonb)`,
        [toolId]
      );
      await q(
        `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1, 'tool', $2, 'capability', $3, 'member_of')`,
        [randomUUID(), toolId, cap]
      );
      await syncNangoConnectionsToRegistry(cap, OWNER, [
        {
          connectionId: "nango-conn-1",
          provider: "google-mail",
          userId: OWNER,
          createdAt: null,
        },
      ]);
      const [row] = (
        await q<{ id: string }>(
          `select id from secrets where capability_id = $1 and account_hint = 'nango-conn-1'`,
          [cap]
        )
      ).rows;
      expect(row).toBeDefined();
      expect((await slotOf(sessionId)).answer).toMatchObject({
        value: {
          type: "provide",
          ref: { kind: "connection", connectionId: row!.id },
        },
      });
    });
  });

  // ── which integration is the asked service (S2) ─────────────────────────

  it("the ask's service meets the broker's integration key through the service registry", () => {
    expect(sameService("gmail", "google-mail")).toBe(true);
    expect(sameService("Stripe", "stripe")).toBe(true);
    expect(sameService("gmail", "slack")).toBe(false);
    expect(sameService("", "")).toBe(false);
    const integrations = [
      { uniqueKey: "stripe-live", provider: "stripe", displayName: "Stripe" },
      {
        uniqueKey: "google-mail",
        provider: "google-mail",
        displayName: "Gmail",
      },
    ];
    expect(matchIntegration("gmail", integrations)?.uniqueKey).toBe(
      "google-mail"
    );
    expect(matchIntegration("stripe", integrations)?.uniqueKey).toBe(
      "stripe-live"
    );
    expect(matchIntegration("notion", integrations)).toBeNull();
  });
});
