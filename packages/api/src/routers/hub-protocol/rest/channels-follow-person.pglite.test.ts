/**
 * A channel with a person FOLLOWS the person (channels wave, lane A, design
 * d00cd2ac §5-6, founder decision 3), and its messages are read through the
 * channel floor + the key's grant — through the REAL hub auth door (its W1
 * fence + `runWithGrant`), the REAL routes and the grant read seam compiled
 * and run as SQL on PGlite. Only the key lookup and the guest check are
 * stubbed; each key's grant is a real `grants` row read by `GrantRepository`.
 *
 * Rows rule out:
 *   - an app key with `channel.read` in CRM reading the channel of a person
 *     roled OUTSIDE CRM (GET /threads/:id/messages answered 200 to any key
 *     with hub-protocol.read: no visibility check ran, "pre-authorized by
 *     the scope gate");
 *   - a key with no `channel.read` reading any channel's messages;
 *   - the CRM app NOT reading the channel of a person it reads (a person's
 *     external channel is pod-wide, so the space stamp alone never matched);
 *   - paging by id over random UUIDs (a page was a random subset), and a
 *     same-instant tie losing a message between pages;
 *   - a proposal outside the key's grant counted or listed as a proposed
 *     message.
 *
 * Cannot see: production Postgres, a real minted app key.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerThreadsRoutes } from "./threads.js";
import { registerChannelsRoutes } from "./channels.js";
import { registerEntityChannelsRoutes } from "./entity-channels.js";
import type { HubHono, HubVariables } from "./_shared.js";

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
          : c.name === "ephemeral"
            ? " default false"
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the person who connected the app
const AGENT = randomUUID(); // the app's own agent (the key principal)
const CRM = randomUUID();
const OTHER = randomUUID();
const PERSON_KIND = randomUUID();
const ROLE_LEAD = randomUUID();

const LEAD = randomUUID(); // pod-wide person, lead in CRM → the app reads it
const ELSEWHERE = randomUUID(); // pod-wide person, lead in OTHER → it does not
const CH_LEAD = randomUUID(); // LEAD's LinkedIn channel (pod-wide)
const CH_ELSE = randomUUID(); // ELSEWHERE's LinkedIn channel (pod-wide)

// CH_LEAD: one outbound message, then three inbound ones at ONE instant.
const T1 = "2026-11-01T10:00:00.000Z";
const T2 = "2026-11-01T11:00:00.000Z";
const M_OUT = randomUUID();
const TIED = [randomUUID(), randomUUID(), randomUUID()].sort();
const M_ELSE = randomUUID();

const P_CRM = randomUUID(); // a proposed message filed in CRM → the app reads it
const P_OTHER = randomUUID(); // one filed in OTHER → only the owner does

interface Key {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
}
const KEYS = {
  /** The CRM app: reads records, channels and proposals in CRM. */
  crm: {
    id: randomUUID(),
    permissions: ["entity.*.read", "channel.read", "proposal.read"],
    workspaceIds: [CRM],
  },
  /** The same app before it asked for `channel.read`. */
  noChannel: {
    id: randomUUID(),
    permissions: ["entity.*.read", "proposal.read"],
    workspaceIds: [CRM],
  },
  /** The owner, unbounded: the floor alone. */
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id, name) values ($1,$2,'agent',$3,'CRM app')`,
    [AGENT, "app-agent@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [OTHER, "Other"],
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
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id) values
       ($1,'person','Person','kind','system','pod',true,'{}'::jsonb,null),
       ($2,'lead','Lead','role','workspace','workspace',true,'{}'::jsonb,null)`,
    [PERSON_KIND, ROLE_LEAD]
  );
  for (const [id, title, ws] of [
    [LEAD, "Lea Lead", CRM],
    [ELSEWHERE, "Eli Elsewhere", OTHER],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,null,$3,'person',$4,'{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, PERSON_KIND, title]
    );
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
       values ($1,$2,$3,$4,$5,'{}'::jsonb)`,
      [randomUUID(), id, ROLE_LEAD, OWNER, ws]
    );
  }
  for (const [id, entityId, chat] of [
    [CH_LEAD, LEAD, "chat-lead"],
    [CH_ELSE, ELSEWHERE, "chat-else"],
  ] as const) {
    await q(
      `insert into channels (id, user_id, workspace_id, title, channel_type, scope, status,
         context_object_type, context_object_id, external_source, external_channel_id, external_id, metadata, ai_reaction_mode)
       values ($1,$2,null,null,'external','pod','active','entity',$3,'linkedin',$4,$4,
         '{"accountId":"acc-1","participantExternalId":"ACoAAA"}'::jsonb,'when_confident')`,
      [id, OWNER, entityId, chat]
    );
  }
  const msg = (
    id: string,
    channel: string,
    at: string,
    direction: "inbound" | "outbound",
    content: string
  ) =>
    q(
      `insert into messages (id, channel_id, role, author_type, message_category, content, user_id,
         timestamp, hash, ephemeral, direction, delivery_status, external_source, external_message_id)
       values ($1,$2,$3,$4,'chat',$5,$6,$7,$8,false,$9,$10,'linkedin',$11)`,
      [
        id,
        channel,
        direction === "outbound" ? "assistant" : "user",
        direction === "outbound" ? "human" : "external",
        content,
        OWNER,
        at,
        `hash-${id}`,
        direction,
        direction === "outbound" ? "sent" : null,
        `ext-${id}`,
      ]
    );
  await msg(M_OUT, CH_LEAD, T1, "outbound", "Hello Lea");
  for (const [i, id] of TIED.entries())
    await msg(id, CH_LEAD, T2, "inbound", `reply ${i}`);
  await msg(M_ELSE, CH_ELSE, T1, "inbound", "Eli's secret");

  for (const [id, ws, body] of [
    [P_CRM, CRM, "Thanks Lea, shall we talk Tuesday?"],
    [P_OTHER, OTHER, "A draft filed elsewhere"],
  ] as const) {
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status,
         created_by, agent_user_id, subject_user_id, created_at)
       values ($1,$2,'messaging',$3,'messaging.external.send',$4::jsonb,'pending',$5,$5,$6,now())`,
      [
        id,
        ws,
        CH_LEAD,
        JSON.stringify({ channelId: CH_LEAD, body, platform: "linkedin" }),
        AGENT,
        OWNER,
      ]
    );
  }

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, AGENT, OWNER]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: ["hub-protocol.read"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerThreadsRoutes(hub);
  registerEntityChannelsRoutes(hub);
  registerChannelsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

const get = (key: KeyName, path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });

type Msg = { id: string; content: string; direction: string | null };
async function messageIds(res: Response): Promise<string[]> {
  expect(res.status).toBe(200);
  return ((await res.json()) as Msg[]).map((m) => m.id);
}

describe("GET /threads/:id/messages — the channel floor and the key's grant", () => {
  it("control: the owner, unbounded, reads both channels", async () => {
    expect(
      await messageIds(await get("full", `/threads/${CH_LEAD}/messages`))
    ).toEqual([M_OUT, ...TIED]);
    expect(
      await messageIds(await get("full", `/threads/${CH_ELSE}/messages`))
    ).toEqual([M_ELSE]);
  });

  it("the CRM app reads the channel of the person it reads (a pod-wide channel follows its person)", async () => {
    const res = await get("crm", `/threads/${CH_LEAD}/messages`);
    expect(await messageIds(res)).toEqual([M_OUT, ...TIED]);
  });

  it("SECURITY: the CRM app gets 404 on the channel of a person outside its space", async () => {
    const res = await get("crm", `/threads/${CH_ELSE}/messages`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain("Eli's secret");
  });

  it("SECURITY: a key without channel.read gets 404 on any channel", async () => {
    for (const ch of [CH_LEAD, CH_ELSE]) {
      expect((await get("noChannel", `/threads/${ch}/messages`)).status).toBe(
        404
      );
    }
  });

  it("each message carries its direction and delivery", async () => {
    const res = await get("full", `/threads/${CH_LEAD}/messages`);
    const rows = (await res.json()) as Array<
      Msg & { deliveryStatus: string | null; externalMessageId: string }
    >;
    expect(rows[0]).toMatchObject({
      id: M_OUT,
      direction: "outbound",
      deliveryStatus: "sent",
      externalMessageId: `ext-${M_OUT}`,
    });
    expect(rows[1]).toMatchObject({
      direction: "inbound",
      deliveryStatus: null,
    });
  });
});

describe("GET /threads/:id/messages?limit&before — chronological pages", () => {
  it("limit: the newest N, oldest first; no limit keeps every message", async () => {
    expect(
      await messageIds(
        await get("full", `/threads/${CH_LEAD}/messages?limit=2`)
      )
    ).toEqual([TIED[1], TIED[2]]);
  });

  it("the next page, by the id the last page ended on, loses no message of the same instant", async () => {
    const page2 = await messageIds(
      await get(
        "full",
        `/threads/${CH_LEAD}/messages?limit=2&before=${encodeURIComponent(T2)}&beforeId=${TIED[1]}`
      )
    );
    expect(page2).toEqual([M_OUT, TIED[0]]);
    const page3 = await messageIds(
      await get(
        "full",
        `/threads/${CH_LEAD}/messages?limit=2&before=${encodeURIComponent(T1)}&beforeId=${M_OUT}`
      )
    );
    expect(page3).toEqual([]);
  });

  it("before alone: strictly before the instant", async () => {
    expect(
      await messageIds(
        await get(
          "full",
          `/threads/${CH_LEAD}/messages?limit=10&before=${encodeURIComponent(T2)}`
        )
      )
    ).toEqual([M_OUT]);
  });
});

describe("GET /entities/:id/channels — a person's channels", () => {
  it("the CRM app reads LEAD's channel: tool, account, chat id, last message, unread, its proposed messages", async () => {
    const res = await get("crm", `/entities/${LEAD}/channels`);
    expect(res.status).toBe(200);
    const { channels } = (await res.json()) as {
      channels: Array<Record<string, unknown>>;
    };
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      id: CH_LEAD,
      provider: "linkedin",
      accountId: "acc-1",
      externalId: "chat-lead",
      title: "Lea Lead",
      participant: { name: "Lea Lead", externalId: "ACoAAA" },
      lastMessage: { content: "reply 2", at: T2, direction: "inbound" },
      unread: 3,
      // Only the proposal filed in CRM: the one in OTHER is outside the grant.
      pendingProposals: 1,
    });
  });

  it("control: the owner counts both proposed messages", async () => {
    const res = await get("full", `/entities/${LEAD}/channels`);
    const { channels } = (await res.json()) as {
      channels: Array<{ pendingProposals: number }>;
    };
    expect(channels[0]?.pendingProposals).toBe(2);
  });

  it("a person outside the app's space is a 404, never an empty list", async () => {
    expect((await get("crm", `/entities/${ELSEWHERE}/channels`)).status).toBe(
      404
    );
  });

  it("a key that never asked for channel.read is refused at the fence", async () => {
    const res = await get("noChannel", `/entities/${LEAD}/channels`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "GRANT_DOOR_UNSUPPORTED"
    );
  });
});

describe("GET /channels/:id/proposed-messages", () => {
  it("the CRM app reads the proposed message filed in CRM, with who drafted it and where to review it", async () => {
    const res = await get("crm", `/channels/${CH_LEAD}/proposed-messages`);
    expect(res.status).toBe(200);
    const { proposed } = (await res.json()) as {
      proposed: Array<Record<string, unknown>>;
    };
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      proposalId: P_CRM,
      text: "Thanks Lea, shall we talk Tuesday?",
      draftedBy: { agentUserId: AGENT, name: "CRM app" },
    });
    expect(String(proposed[0]!.reviewUrl)).toContain(`/open/${P_CRM}`);
  });

  it("a channel outside the app's reach is a 404", async () => {
    expect(
      (await get("crm", `/channels/${CH_ELSE}/proposed-messages`)).status
    ).toBe(404);
  });
});
