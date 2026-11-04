/**
 * A space-less PERSON'S CONVERSATION follows its person for a pod MEMBER too
 * (founder decision d7, 2026-11-03, channels wave d00cd2ac): the one channel
 * floor (`channelVisibilityWhere`, `canUserSeeChannel`, the realtime audience)
 * compiled and run as SQL on PGlite, with the REAL registered entity floor
 * (`utils/object-room-floors.ts`).
 *
 * Before d7, branch 4 handed every space-less EXTERNAL channel to the whole
 * pod, so on a team pod a member read another member's LinkedIn DMs. Rows
 * rule out:
 *   - a member reading the conversation of a person they cannot read;
 *   - a member reading a DM whose sender was never identified (no person);
 *   - the conversation of a person they CAN read (a lead roled in their space)
 *     being hidden from them (the decision is "follow", not "owner only");
 *   - a space-less bridge channel (no person, no account) losing its
 *     team visibility (it is not a person's conversation);
 *   - the realtime audience disagreeing with the read rule.
 *
 * And the same for a conversation STAMPED WITH A SPACE (every creator stamps
 * one: `accountHomeWorkspace`): the space's membership is not the rule, the
 * person is. Rows rule out:
 *   - a member of the channel's space who cannot read the person reading it;
 *   - a member who CAN read the person (from another space) being refused;
 *   - a bridge channel in a space (no person) losing its team visibility;
 *   - the realtime audience following the space instead of the person.
 *
 * Cannot see: production Postgres.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { channels } from "@synap/database/schema";
import {
  canUserSeeChannel,
  channelVisibilityWhere,
  listChannelAudienceUserIds,
} from "@synap/database/channel-visibility";
// Registers the entity floor the channel rule follows (as the API does at load).
import "../utils/object-room-floors.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // connected the account; owns every channel below
const MATE = randomUUID(); // a member of CRM
const OUTSIDER = randomUUID(); // a pod member in no space
const PEER = randomUUID(); // a member of HOME only
const CRM = randomUUID();
const HOME = randomUUID(); // the account's home space (OWNER, PEER)
const PERSON_KIND = randomUUID();
const ROLE_LEAD = randomUUID();

const LEAD = randomUUID(); // pod-wide person, lead in CRM → MATE reads it
const PRIVATE = randomUUID(); // pod-wide person with no role → OWNER only

const CH_LEAD = randomUUID(); // LEAD's LinkedIn conversation (no space)
const CH_PRIVATE = randomUUID(); // PRIVATE's conversation (no space)
const CH_UNBOUND = randomUUID(); // a DM whose sender was never identified
const CH_BRIDGE = randomUUID(); // a Discord bridge: no person, no account
const CH_ADDED = randomUUID(); // PRIVATE's, with OUTSIDER added as a member
const CH_HOME_LEAD = randomUUID(); // LEAD's conversation, stamped HOME
const CH_HOME_PRIVATE = randomUUID(); // PRIVATE's conversation, stamped HOME
const CH_HOME_BRIDGE = randomUUID(); // a Discord bridge in HOME (no person)

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function visibleTo(userId: string): Promise<Set<string>> {
  const rows = await (
    h.db as {
      select: (s: unknown) => {
        from: (t: unknown) => {
          where: (w: unknown) => Promise<Array<{ id: string }>>;
        };
      };
    }
  )
    .select({ id: channels.id })
    .from(channels)
    .where(channelVisibilityWhere(userId));
  return new Set(rows.map((r) => r.id));
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const [id, role] of [
    [OWNER, "owner"],
    [MATE, "member"],
    [OUTSIDER, "member"],
    [PEER, "member"],
  ] as const) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      id,
      `${id}@example.test`,
    ]);
    await q(
      `insert into pod_members (id, user_id, pod_role) values ($1,$2,$3)`,
      [randomUUID(), id, role]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'CRM',$2,'{}'::jsonb)`,
    [CRM, OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Home',$2,'{}'::jsonb)`,
    [HOME, OWNER]
  );
  for (const [ws, user, role] of [
    [CRM, OWNER, "owner"],
    [CRM, MATE, "editor"],
    [HOME, OWNER, "owner"],
    [HOME, PEER, "editor"],
  ] as const) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
      [randomUUID(), ws, user, role]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, ROLE_LEAD]
  );
  for (const [id, title] of [
    [LEAD, "Lea Lead"],
    [PRIVATE, "Pia Private"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,'person',$4,'{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, PERSON_KIND, title]
    );
  }
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
     values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
    [randomUUID(), LEAD, ROLE_LEAD, OWNER, CRM]
  );

  const channel = (
    id: string,
    person: string | null,
    metadata: string,
    source: string,
    workspace: string | null = null
  ) =>
    q(
      `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
         context_object_type, context_object_id, external_source, external_id, metadata)
       values ($1,$2,$8,'c','external',$9,'active',$3,$4,$5,$6,$7::jsonb)`,
      [
        id,
        OWNER,
        person ? "entity" : null,
        person,
        source,
        `x-${id}`,
        metadata,
        workspace,
        workspace ? "workspace" : "pod",
      ]
    );
  await channel(CH_LEAD, LEAD, '{"accountId":"acc-1"}', "linkedin");
  await channel(CH_PRIVATE, PRIVATE, '{"accountId":"acc-1"}', "linkedin");
  await channel(CH_UNBOUND, null, '{"accountId":"acc-1"}', "linkedin");
  await channel(CH_BRIDGE, null, "{}", "discord");
  await channel(CH_ADDED, PRIVATE, '{"accountId":"acc-1"}', "linkedin");
  await channel(CH_HOME_LEAD, LEAD, '{"accountId":"acc-1"}', "linkedin", HOME);
  await channel(
    CH_HOME_PRIVATE,
    PRIVATE,
    '{"accountId":"acc-1"}',
    "linkedin",
    HOME
  );
  await channel(CH_HOME_BRIDGE, null, "{}", "discord", HOME);
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1,$2,$3,'user','member')`,
    [randomUUID(), CH_ADDED, OUTSIDER]
  );
});

describe("a space-less person's conversation follows its person (decision d7)", () => {
  it("its owner reads every one of them", async () => {
    const mine = await visibleTo(OWNER);
    for (const id of [CH_LEAD, CH_PRIVATE, CH_UNBOUND, CH_BRIDGE, CH_ADDED])
      expect(mine.has(id)).toBe(true);
  });

  it("a member reads the conversation of a person they read (a lead in their space)", async () => {
    expect((await visibleTo(MATE)).has(CH_LEAD)).toBe(true);
    expect(await canUserSeeChannel(h.db as never, CH_LEAD, MATE)).toBe(true);
  });

  it("a member never reads the conversation of a person they cannot read", async () => {
    expect((await visibleTo(MATE)).has(CH_PRIVATE)).toBe(false);
    expect((await visibleTo(OUTSIDER)).has(CH_LEAD)).toBe(false);
    expect(await canUserSeeChannel(h.db as never, CH_LEAD, OUTSIDER)).toBe(
      false
    );
  });

  it("a DM with no person is its owner's only", async () => {
    expect((await visibleTo(MATE)).has(CH_UNBOUND)).toBe(false);
    expect((await visibleTo(OUTSIDER)).has(CH_UNBOUND)).toBe(false);
  });

  it("an explicit member still reads it", async () => {
    expect(await canUserSeeChannel(h.db as never, CH_ADDED, OUTSIDER)).toBe(
      true
    );
  });

  it("a space-less bridge channel (no person, no account) stays team-visible", async () => {
    expect((await visibleTo(MATE)).has(CH_BRIDGE)).toBe(true);
    expect((await visibleTo(OUTSIDER)).has(CH_BRIDGE)).toBe(true);
  });

  it("the realtime audience is the read rule's", async () => {
    const lead = await listChannelAudienceUserIds(h.db as never, CH_LEAD);
    expect(new Set(lead)).toEqual(new Set([OWNER, MATE]));
    const unbound = await listChannelAudienceUserIds(h.db as never, CH_UNBOUND);
    expect(unbound).toEqual([OWNER]);
    const bridge = await listChannelAudienceUserIds(h.db as never, CH_BRIDGE);
    expect(new Set(bridge)).toEqual(new Set([OWNER, MATE, OUTSIDER, PEER]));
  });
});

describe("a person's conversation stamped with a space still follows its person", () => {
  it("a member of its space who cannot read the person does not see it", async () => {
    expect((await visibleTo(PEER)).has(CH_HOME_PRIVATE)).toBe(false);
    expect((await visibleTo(PEER)).has(CH_HOME_LEAD)).toBe(false);
    expect(await canUserSeeChannel(h.db as never, CH_HOME_PRIVATE, PEER)).toBe(
      false
    );
  });

  it("a member who reads the person sees it, from another space", async () => {
    expect((await visibleTo(MATE)).has(CH_HOME_LEAD)).toBe(true);
    expect(await canUserSeeChannel(h.db as never, CH_HOME_LEAD, MATE)).toBe(
      true
    );
    expect((await visibleTo(MATE)).has(CH_HOME_PRIVATE)).toBe(false);
  });

  it("its owner still reads every one of them", async () => {
    const mine = await visibleTo(OWNER);
    for (const id of [CH_HOME_LEAD, CH_HOME_PRIVATE, CH_HOME_BRIDGE])
      expect(mine.has(id)).toBe(true);
  });

  it("a bridge channel in a space (no person) stays visible to that space", async () => {
    expect((await visibleTo(PEER)).has(CH_HOME_BRIDGE)).toBe(true);
    expect((await visibleTo(MATE)).has(CH_HOME_BRIDGE)).toBe(false);
  });

  it("the realtime audience is the person's readers, not the space's members", async () => {
    const lead = await listChannelAudienceUserIds(h.db as never, CH_HOME_LEAD);
    expect(new Set(lead)).toEqual(new Set([OWNER, MATE]));
    const priv = await listChannelAudienceUserIds(
      h.db as never,
      CH_HOME_PRIVATE
    );
    expect(priv).toEqual([OWNER]);
    const bridge = await listChannelAudienceUserIds(
      h.db as never,
      CH_HOME_BRIDGE
    );
    expect(new Set(bridge)).toEqual(new Set([OWNER, PEER]));
  });
});
