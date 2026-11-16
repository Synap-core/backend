/**
 * Keep or drop ONE candidate of a pending prospect list from a pod app (wave
 * plan dbc8803a §2 "Keep or drop", lane B): Hub REST
 * `POST /proposals/:id/items/:itemRef/reject` and `/restore`, which delegate
 * to the in-pod `proposals.rejectItem` / `restoreItem`.
 *
 * Rows rule out:
 *   - an app key with no `proposal.reject` dropping an item (the in-pod
 *     door's floor must hold over REST);
 *   - a key allowed in ANOTHER space dropping an item of a CRM proposal (an
 *     app key is scoped to its space);
 *   - a drop that does not persist on the row, or a restore that leaves it;
 *   - a drop on a proposal that is no longer pending.
 *
 * Driven through the REAL hub auth door and the real route on PGlite, with
 * the harness of `proposals.fenced-key.pglite.test.ts` (same stubs, same
 * reasons). Cannot see: production Postgres, a real minted app token.
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
  db: null as unknown,
  getApiKeyStatus: vi.fn(),
  runResolvedSkill: vi.fn(),
  /** A no-op event log (it appends over its own connection). Never thenable. */
  noopEvents: () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "then"
            ? undefined
            : async () => ({ id: globalThis.crypto.randomUUID() }),
      }
    ),
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
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: h.noopEvents(),
    EventRepository: class {
      constructor() {
        return h.noopEvents();
      }
    },
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => ({ id: globalThis.crypto.randomUUID() })),
}));
// The proposal ROW, in the columns the review reads; the door's verdict is real.
vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: {
    userId: string;
    workspaceId?: string | null;
    targetType: string;
    targetId: string;
    proposalType: string;
    data: Record<string, unknown>;
    agentUserId?: string | null;
    createdBy?: string | null;
  }) => {
    const id = globalThis.crypto.randomUUID();
    await h.client!.query(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, agent_user_id)
       values ($1,$2,$3,$4,$5,$6::jsonb,'pending',$7,$8,$9)`,
      [
        id,
        input.workspaceId ?? null,
        input.targetType,
        input.targetId,
        input.proposalType,
        JSON.stringify(input.data),
        input.createdBy ?? input.userId,
        input.userId,
        input.agentUserId ?? null,
      ]
    );
    return { proposal: { id } };
  },
}));
vi.mock(
  "../../../services/capabilities/execute-capability.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    runResolvedSkill: (...a: unknown[]) => h.runResolvedSkill(...a),
    assertApprovalTargetResolves: async () => null,
  })
);
// The run's recall deposit embeds its result; no provider in a test.
vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: async () => new Array(1536).fill(0),
}));
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
import { registerProposalsRoutes } from "./proposals.js";
import { registerCapabilityExecutors } from "../../proposals/executors/capability.js";
import { proposalExecRegistry } from "../../proposals/execution-registry.js";
import type { HubHono, HubVariables } from "./_shared.js";

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

const OWNER = randomUUID(); // the person who connected the app (pod owner)
const AGENT = randomUUID(); // the app's own agent
const TEAMMATE = randomUUID(); // another member, with a skill of their own
const CRM = randomUUID();
const BRAND = randomUUID(); // the owner's other space, never granted to the app
const PERSON_KIND = randomUUID();
const COMPANY_KIND = randomUUID();

const IN_CRM = randomUUID(); // a person in CRM
const ACME = randomUUID(); // a company in CRM
const IN_BRAND = randomUUID(); // a person in Brand
const POD_WIDE = randomUUID(); // a pod-wide person

const SKILL_POD = randomUUID(); // pod skill, approved
const SKILL_FOREIGN = randomUUID(); // TEAMMATE's own skill (user scope)
const SKILL_DISABLED = randomUUID(); // pod skill, installed but not enabled

interface Key {
  id: string;
  permissions: string[];
  workspaceIds: string[] | null;
  principal: string;
  person: string;
}
const KEYS = {
  /** The CRM app's person token, allowed to drop items in CRM. */
  crmReviewer: {
    id: randomUUID(),
    permissions: ["entity.*.read", "proposal.reject"],
    workspaceIds: [CRM],
    principal: OWNER,
    person: OWNER,
  },
  /** The CRM app with no decision right. */
  crmNoReject: {
    id: randomUUID(),
    permissions: ["entity.*.read", "entity.*.update"],
    workspaceIds: [CRM],
    principal: OWNER,
    person: OWNER,
  },
  /** A key allowed to drop items, but in Brand only. */
  brandReviewer: {
    id: randomUUID(),
    permissions: ["entity.*.read", "proposal.reject"],
    workspaceIds: [BRAND],
    principal: OWNER,
    person: OWNER,
  },
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
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "app-agent@example.test", OWNER]
  );
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    TEAMMATE,
    "teammate@example.test",
  ]);
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), TEAMMATE]
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [BRAND, "Brand"],
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
       ($2,'company','Company','kind','system','pod',true,'{}'::jsonb,null)`,
    [PERSON_KIND, COMPANY_KIND]
  );
  for (const [id, ws, kind, kindId] of [
    [IN_CRM, CRM, "person", PERSON_KIND],
    [ACME, CRM, "company", COMPANY_KIND],
    [IN_BRAND, BRAND, "person", PERSON_KIND],
    [POD_WIDE, null, "person", PERSON_KIND],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,$5,'e','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, kindId, kind]
    );
  }
  for (const [id, scope, userId, approved] of [
    [SKILL_POD, "pod", OWNER, true],
    [SKILL_FOREIGN, "user", TEAMMATE, true],
    [SKILL_DISABLED, "pod", OWNER, false],
  ] as const) {
    await q(
      `insert into skills (id, name, scope, user_id, workspace_id, status, approved, kind, metadata)
       values ($1,$2,$3,$4,null,'active',$5,'code','{}'::jsonb)`,
      [id, `skill_${id.slice(0, 8)}`, scope, userId, approved]
    );
  }
  for (const k of Object.values(KEYS)) {
    // The act-as link a minted key carries: the key's principal acts for its person.
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.principal, k.person]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        k.principal,
        k.person,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
  registerCapabilityExecutors();
}, 120_000);

beforeEach(() => {
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: key.principal,
        linkedUserId: key.person,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
  h.runResolvedSkill.mockReset();
  h.runResolvedSkill.mockResolvedValue({ kind: "run", result: { ok: true } });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerProposalsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const SCOUT = randomUUID(); // the agent that built the prospect list

async function seedList(
  status = "pending",
  workspaceId: string = CRM
): Promise<string> {
  const id = randomUUID();
  const data = {
    operations: [
      { op: "create", ref: "$op0", profileSlug: "person", title: "Marie" },
      { op: "create", ref: "$op1", profileSlug: "person", title: "Paul" },
    ],
  };
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, subject_user_id, agent_user_id)
     values ($1,$2,'entity',$7,'composite',$3::jsonb,$4,$5,$6,$5)`,
    [id, workspaceId, JSON.stringify(data), status, SCOUT, OWNER, id]
  );
  return id;
}

const itemDoor = (
  key: KeyName,
  proposalId: string,
  itemRef: string,
  act: "reject" | "restore",
  body?: Record<string, unknown>
) => {
  const text = body ? JSON.stringify(body) : "";
  return app().request(
    `/api/hub/proposals/${proposalId}/items/${encodeURIComponent(itemRef)}/${act}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer synap_${key}`,
        ...(body
          ? {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(text)),
            }
          : {}),
      },
      ...(body ? { body: text } : {}),
    }
  );
};

async function dispositions(id: string) {
  const [row] = (
    await q<{ data: Record<string, unknown> }>(
      `select data from proposals where id=$1`,
      [id]
    )
  ).rows;
  return (row!.data.dispositions ?? {}) as Record<string, unknown>;
}

describe("a pod app keeps or drops one candidate of a pending list", () => {
  it("drop: the item's disposition is written at once; the other items and the proposal stay pending", async () => {
    const id = await seedList();
    const res = await itemDoor("crmReviewer", id, "$op0", "reject", {
      reason: "Not a fit",
    });
    const out = await json(res);
    expect(res.status, JSON.stringify(out)).toBe(200);
    expect(out).toEqual({ success: true, proposalId: id, itemRef: "$op0" });
    expect(await dispositions(id)).toEqual({
      $op0: { status: "reject", reason: "Not a fit" },
    });
    const [row] = (
      await q<{ status: string }>(`select status from proposals where id=$1`, [
        id,
      ])
    ).rows;
    expect(row!.status).toBe("pending");
  });

  it("keep (restore): the drop is undone", async () => {
    const id = await seedList();
    expect((await itemDoor("crmReviewer", id, "$op1", "reject")).status).toBe(
      200
    );
    const res = await itemDoor("crmReviewer", id, "$op1", "restore");
    expect(res.status, JSON.stringify(await json(res))).toBe(200);
    expect(await dispositions(id)).toEqual({});
  });

  it("a key without the decision right is refused (403) and nothing is written", async () => {
    const id = await seedList();
    const res = await itemDoor("crmNoReject", id, "$op0", "reject");
    expect(res.status).toBe(403);
    expect(await dispositions(id)).toEqual({});
  });

  it("a key allowed only in another space is refused on a CRM proposal, and nothing is written", async () => {
    const id = await seedList();
    for (const act of ["reject", "restore"] as const) {
      const res = await itemDoor("brandReviewer", id, "$op0", act);
      expect(res.status, act).toBe(403);
    }
    expect(await dispositions(id)).toEqual({});
  });

  it("a decided proposal is not pending any more: 409, nothing written", async () => {
    const id = await seedList("approved");
    const res = await itemDoor("crmReviewer", id, "$op0", "reject");
    expect(res.status).toBe(409);
    expect(await dispositions(id)).toEqual({});
  });
});
