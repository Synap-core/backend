/**
 * What holds a LEAD up, on its flow card (`flow.of`) and in `statusOf`,
 * against real SQL (PGlite, every table). Derived, never stored: the card's
 * blocker comes from THE waiting-on collector (`readWaitingOnSourcesFor`).
 *
 * Rows rule out:
 *  - a ready send draft (a pending `messaging.external.send` proposal, whose
 *    TARGET is the person's channel) missing from the person's card: it is
 *    on the person it names (`data.entityId`), "waiting on you", keyed by its
 *    type;
 *  - a draft written in a company lead's outreach run (the session's
 *    subject) missing from the company's card;
 *  - a HELD send (it goes out once they accept) read as your approval: it
 *    waits on THEM, keyed `not_connected`;
 *  - a lead whose ROLE stands in a step that declares a wait (outreach waits
 *    on their reply) showing no blocker, because only the entity's own
 *    status and kind were read;
 *  - another person's proposal on a lead blocking the reader's card.
 *
 * Only `getEffectiveLifecycle` is stubbed (its own suites prove it).
 * Cannot see: the Hub and MCP doors (their own suites), a real pod's data.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const LEAD = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const COMPANY = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  // Only the lead ROLE has a lifecycle; people and companies have none.
  const lifecycles: Record<string, unknown> = {
    "22222222-2222-4222-8222-222222222222": {
      propertySlug: "leadStage",
      options: [
        { key: "new", category: "open" },
        {
          key: "outreach",
          category: "active",
          waits: { on: "external", waitKind: "their_reply" },
        },
        { key: "engaged", category: "active" },
        { key: "won", category: "done" },
      ],
      unclassified: [],
      initialStatus: "new",
    },
  };
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    countWorkerPendingApprovals: async () => 0,
    countWorkerPendingApprovalsBulk: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, 0])),
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        return lifecycles[profileId] ?? null;
      }
      async getEffectiveLifecycles(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, lifecycles[id] ?? null]));
      }
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { flowOfInput, readFlowOf, type FlowOf } from "../flow-read.js";
import { readStatusOf } from "../../status/status-read.js";

const USER = "user-1";
const OTHER = "user-2";
const WS = "55555555-5555-4555-8555-555555555555";
const ELSEWHERE = "66666666-6666-4666-8666-666666666666";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const read = (input: Record<string, unknown>) =>
  readFlowOf(flowOfInput.parse(input), { userId: USER, workspaceId: null });

async function thing(profileId: string, type: string, title: string) {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, status, workspace_id, properties, created_at)
     values ($1,$2,$3,$4,$5,null,$6,'{}'::jsonb,now())`,
    [id, USER, type, profileId, title, WS]
  );
  return id;
}

async function lead(entityId: string, status: string) {
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, properties, created_at)
     values (gen_random_uuid(),$1,$2,$3,$4,$5,'{}'::jsonb,now())`,
    [entityId, LEAD, USER, WS, status]
  );
}

/** A pending send draft: its target is the person's CHANNEL, not the person. */
async function sendDraft(o: {
  to: string;
  held?: boolean;
  sessionId?: string;
  createdBy?: string;
  workspaceId?: string;
}) {
  const id = randomUUID();
  const channelId = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, session_id, created_at, updated_at)
     values ($1,$2,'messaging',$3,'messaging.external.send',$4::jsonb,'pending',$5,$6,now(),now())`,
    [
      id,
      o.workspaceId ?? WS,
      channelId,
      JSON.stringify({
        body: "Hello",
        platform: "linkedin",
        channelId,
        entityId: o.to,
        ...(o.held
          ? {
              held: {
                errorClass: "not_connected",
                reason: "Ask to connect first.",
                at: new Date().toISOString(),
              },
            }
          : {}),
      }),
      o.createdBy ?? USER,
      o.sessionId ?? null,
    ]
  );
  return id;
}

async function session(subject: string) {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, subject_entity_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1,$2,$3,$4,'Outreach','Reach them','active','user','[]'::jsonb,'{}'::jsonb,now(),now(),now())`,
    [id, USER, WS, subject]
  );
  return id;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human')`,
    [USER]
  );
  for (const [id, slug, kind] of [
    [LEAD, "lead", "role"],
    [PERSON, "person", "kind"],
    [COMPANY, "company", "kind"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1,$2,$2,$3,'workspace')`,
      [id, slug, kind]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at) values ($1,'Sales',$2,'{}'::jsonb,now(),now())`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role, joined_at) values (gen_random_uuid(),$1,$2,'owner',now())`,
    [WS, USER]
  );

  // Ada: a ready draft to her. Cat: a draft held until she accepts.
  // Acme: a draft to Dan (not a lead) written in Acme's outreach run.
  // Bob: his lead stands in outreach, which waits on their reply.
  // Eve: only another person's draft, that the reader cannot see.
  ids.ada = await thing(PERSON, "person", "Ada");
  ids.cat = await thing(PERSON, "person", "Cat");
  ids.acme = await thing(COMPANY, "company", "Acme");
  ids.dan = await thing(PERSON, "person", "Dan");
  ids.bob = await thing(PERSON, "person", "Bob");
  ids.eve = await thing(PERSON, "person", "Eve");
  for (const id of [ids.ada, ids.cat, ids.acme, ids.eve]) await lead(id, "new");
  await lead(ids.bob, "outreach");

  ids.adaDraft = await sendDraft({ to: ids.ada });
  ids.catDraft = await sendDraft({ to: ids.cat, held: true });
  ids.acmeRun = await session(ids.acme);
  ids.acmeDraft = await sendDraft({ to: ids.dan, sessionId: ids.acmeRun });
  // Filed by another person in a space the reader is not a member of.
  await sendDraft({ to: ids.eve, createdBy: OTHER, workspaceId: ELSEWHERE });
});

const card = (f: FlowOf, state: string, id: string) =>
  f.states.find((s) => s.key === state)!.cards.find((c) => c.id === id)!;

describe("flow.of — what holds a lead up", () => {
  it("a ready draft to the person: waiting on you, approve the draft", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(card(f, "new", ids.ada).blocker).toMatchObject({
      blocked: true,
      ball: "me",
      why: {
        reason: "approval",
        waitKind: "approval",
        blockerKey: "messaging.external.send",
      },
      ref: { kind: "proposal", id: ids.adaDraft },
    });
  });

  it("a draft written in a company lead's run is on the company", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(card(f, "new", ids.acme).blocker).toMatchObject({
      blocked: true,
      ball: "me",
      why: { blockerKey: "messaging.external.send" },
      ref: { kind: "proposal", id: ids.acmeDraft },
    });
  });

  it("a held send waits on them, never on your approval", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(card(f, "new", ids.cat).blocker).toMatchObject({
      blocked: true,
      ball: "them",
      why: {
        reason: "external",
        waitKind: "their_reply",
        blockerKey: "not_connected",
      },
      ref: { kind: "proposal", id: ids.catDraft },
    });
  });

  it("a lead whose role stands in a step that waits shows that wait", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(card(f, "outreach", ids.bob).blocker).toMatchObject({
      blocked: true,
      count: 1,
      ball: "them",
      why: { reason: "external", waitKind: "their_reply" },
      unlocks: { to: "engaged" },
    });
  });

  it("another person's draft blocks nothing the reader sees", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(card(f, "new", ids.eve).blocker).toMatchObject({
      blocked: false,
      count: 0,
    });
  });
});

describe("statusOf — the same draft on the person", () => {
  it("returns the draft as the person's blocker, and the held one as theirs", async () => {
    const answers = await readStatusOf(USER, [ids.ada, ids.cat]);
    const blockerOf = (id: string) =>
      (answers.find((a) => a.id === id) as { blocker?: unknown }).blocker;
    expect(blockerOf(ids.ada)).toMatchObject({
      blocked: true,
      ball: "me",
      why: { blockerKey: "messaging.external.send" },
    });
    expect(blockerOf(ids.cat)).toMatchObject({
      blocked: true,
      ball: "them",
      why: { blockerKey: "not_connected" },
    });
  });
});
