/**
 * An AI asks for ONE MORE thing (`services/agent-access-ask.ts`) — end to end
 * on PGlite (every @synap/database table): the agent's key at the REAL Hub
 * door (`POST /agents/access-requests`) behind a stand-in for the hub auth
 * door that sets what it sets for an agent key (`userId` = the person the key
 * acts for, `apiKeyId` = the bearer), then the REAL approve door
 * (`applyProposalApproval` → the `agent/connect` executor, `mode: "add"`).
 * Grants are written and read through the real doors (`attachGrantsOrRevoke`,
 * `liveGrantsOfKey`), so the clip to the computer is the real one.
 *
 * Each row rules out a wrong implementation, and each was seen red with its
 * fix reverted (negative control on the same devbox job, branch
 * `negctl/feat/agent-access-ask`):
 *  - ONLY THE KEY THAT ASKED: the approval adds the pair to the asking key,
 *    keeps what that key held, and leaves the agent's other key as it was
 *    (an approval that re-grants every key of the agent, or that replaces
 *    the key's grants, fails);
 *  - CLIP: a pair the computer lacks is cut away after the add (an approval
 *    that skips `clipHostedAgentGrants` leaves the agent above its computer);
 *  - KEY GONE: a key revoked (replaced) before the tap refuses the approval
 *    with ASK_KEY_GONE and writes nothing;
 *  - LIMITS: a permission outside the agent's capability list is refused with
 *    ASK_BEYOND_AGENT_LIMIT when asked (nothing filed) and when approved after
 *    the list was narrowed; a refusal of such a permission is not askable;
 *  - SPACE: a pair with no space is refused at the door (400), by the service
 *    (ASK_NEEDS_SPACE), and at approval for a row that carries one.
 *
 * Seams replaced, as in app-access-ask.pglite.test.ts: the event store and
 * `auditLog` (recorders), `createPendingProposal` (inserts the row,
 * `expiresAt` and the owner kept), `isPodAdmin`.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
    eventRepository: { append: async () => undefined },
    EventRepository: RecordingEventRepository,
  };
});

vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
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
          subjectUserId: input.userId,
          expiresAt: input.expiresAt ?? null,
          revisionHistory: [],
          comments: [],
        })
        .returning();
      return row;
    },
  };
});

import { eq, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { applyProposalApproval } from "../routers/proposals/apply-approval.js";
import { registerAgentsRoutes } from "../routers/hub-protocol/rest/agents.js";
import type {
  HubHono,
  HubVariables,
} from "../routers/hub-protocol/rest/_shared.js";
import { refusalReasonCode } from "../routers/hub-protocol/rest/_presence.js";
import { attachGrantsOrRevoke, liveGrantsOfKey } from "./key-grant.js";
import { REPLACED_FROM_THIS_COMPUTER } from "./agent-connect.js";
import { askableAgentDenial, fileAgentAccessAsk } from "./agent-access-ask.js";

const HUMAN = "human-asks";
const OTHER = "human-other";
const DEVBOX = "machine-devbox";
const CC = "agent-cc-on-devbox";
const FIN = randomUUID();
const OPS = randomUUID();

const NOTE_UPDATE = "entity.note.update";
const NOTE_CREATE = "entity.note.create";
const TASK_CREATE = "entity.task.create";
/** The agent's limits (its capability list): notes only. */
const CC_CAPABILITIES = [NOTE_UPDATE, NOTE_CREATE];

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

async function addUser(
  id: string,
  agentType: string | null,
  host: string | null
) {
  await q(
    `insert into users (id, email, name, user_type, agent_type, host_user_id, created_by_user_id,
       email_verified, timezone, locale, is_personal_agent, created_at, updated_at)
     values ($1, $1 || '@x', $2, $3, $4, $5, $6, true, 'UTC', 'en', false, now(), now())`,
    [
      id,
      agentType === "claude-code" ? "Claude Code" : id,
      agentType ? "agent" : "human",
      agentType,
      host,
      agentType ? HUMAN : null,
    ]
  );
}

async function addKey(userId: string, instanceLabel: string | null) {
  const id = randomUUID();
  await q(
    `insert into api_keys (id, user_id, linked_user_id, key_name, key_prefix, key_hash,
       key_type, scope, is_active, usage_count, instance_label, created_at)
     values ($1, $2, $3, 'k', 'synap_', $4, 'hub_inbound',
       '{hub-protocol.read,hub-protocol.write}', true, 0, $5, now())`,
    [id, userId, HUMAN, `hash-${id}`, instanceLabel]
  );
  return id;
}

const mint = (apiKeyId: string, principal: string, permissions: string[]) =>
  attachGrantsOrRevoke({
    apiKeyId,
    principalUserId: principal,
    onBehalfOf: HUMAN,
    grants: [{ permissions }],
    expiresAt: null,
    createdBy: HUMAN,
  });

/** A key's live reach, one `<permission>@<space or *>` per pair. */
const reach = async (keyId: string) =>
  (await liveGrantsOfKey(keyId))
    .flatMap((g) =>
      g.permissions.flatMap((p) =>
        (g.workspaceIds ?? ["*"]).map(
          (w) => `${p}@${w === FIN ? "FIN" : w === OPS ? "OPS" : w}`
        )
      )
    )
    .sort();

const setCapabilities = (agent: string, capabilities: string[]) =>
  q(`update users set agent_metadata = $1::jsonb where id = $2`, [
    JSON.stringify({ capabilities }),
    agent,
  ]);

let devboxKey: string;
let ccKey: string;
let ccOtherKey: string;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await addUser(HUMAN, null, null);
  await addUser(OTHER, null, null);
  await addUser(DEVBOX, "machine", null);
  await addUser(CC, "claude-code", DEVBOX);
  // HUMAN owns Finance; in Ops (OTHER's space) HUMAN only reads.
  for (const [id, name, owner] of [
    [FIN, "Finance", HUMAN],
    [OPS, "Ops", OTHER],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1, $2, $3)`, [
      id,
      name,
      owner,
    ]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, owner]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'viewer')`,
    [randomUUID(), OPS, HUMAN]
  );
}, 120_000);

beforeEach(async () => {
  await q(`delete from pod_settings`);
  // Not a proof-of-presence suite (presence.pglite.test.ts owns the gate).
  await h.client!.exec(
    `insert into pod_settings (settings) values ('{"presence":{"mode":"report","changedBy":"test","changedAt":"2026-11-05T00:00:00.000Z"}}'::jsonb)`
  );
  await q(`delete from proposals`);
  await q(`delete from grants`);
  await q(`delete from api_keys`);
  await setCapabilities(CC, CC_CAPABILITIES);
  // The computer reads everything and changes notes, anywhere; it cannot
  // create notes. The agent runs on it with two keys (two connections).
  devboxKey = await addKey(DEVBOX, null);
  await mint(devboxKey, DEVBOX, ["entity.read", NOTE_UPDATE]);
  ccKey = await addKey(CC, "devbox");
  ccOtherKey = await addKey(CC, "devbox-2");
  await mint(ccKey, CC, ["entity.read"]);
  await mint(ccOtherKey, CC, ["entity.read"]);
});

/** The hub door as an agent key reaches it (what `hubAuthMiddleware` sets). */
function hubApp(apiKeyId: string, userId = HUMAN): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("apiKeyId", apiKeyId);
    c.set("agentUserId", CC);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerAgentsRoutes(app);
  return app;
}

async function ask(
  apiKeyId: string,
  requests: Array<{ permission: string; workspaceId?: string }>
): Promise<{ status: number; body: any }> {
  const res = await hubApp(apiKeyId).request("/agents/access-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests, reason: "To fix the typo you asked" }),
  });
  return { status: res.status, body: await res.json() };
}

async function approve(proposalId: string) {
  const row = await (h.db as any).query.proposals.findFirst({
    where: (p: any, { eq: e }: any) => e(p.id, proposalId),
  });
  return applyProposalApproval({
    proposal: row,
    userId: HUMAN,
    input: { proposalId },
    ctx: {
      authenticated: true,
      userId: HUMAN,
      session: { id: "s" },
    } as never,
  });
}

/** The typed reason a refusal carries (`refusalReasonCode`, the Hub's reader). */
async function reasonOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return refusalReasonCode(err) ?? `untyped: ${(err as Error).message}`;
  }
  return "no refusal";
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      id,
    ])
  )[0]?.status;

describe("ONLY THE KEY THAT ASKED — an approval adds to that key alone", () => {
  it("adds the pair to the asking key and keeps what it held", async () => {
    const r = await ask(ccKey, [{ permission: NOTE_UPDATE, workspaceId: FIN }]);
    expect(r.status).toBe(201);
    expect(r.body.pairs).toEqual([
      expect.objectContaining({
        permission: NOTE_UPDATE,
        workspaceId: FIN,
        workspaceName: "Finance",
        state: "asked",
      }),
    ]);
    const card = (
      await q<{ data: { name: string } }>(
        `select data from proposals where id = $1`,
        [r.body.id]
      )
    )[0]!.data;
    expect(card.name).toBe("Claude Code on devbox");

    await approve(r.body.id);
    expect(await statusOf(r.body.id)).toBe("approved");
    // Added, and what the key held is kept (an approval that replaces the
    // key's grants loses `entity.read`).
    expect(await reach(ccKey)).toEqual(
      ["entity.read@*", `${NOTE_UPDATE}@FIN`].sort()
    );
  });

  it("the agent's other key does not get it", async () => {
    const r = await ask(ccKey, [{ permission: NOTE_UPDATE, workspaceId: FIN }]);
    await approve(r.body.id);
    expect(await reach(ccOtherKey)).toEqual(["entity.read@*"]);
  });

  it("the same pair asked twice is one open ask; once given, it reads given", async () => {
    const first = await ask(ccKey, [
      { permission: NOTE_UPDATE, workspaceId: FIN },
    ]);
    const again = await ask(ccKey, [
      { permission: NOTE_UPDATE, workspaceId: FIN },
    ]);
    expect(again.status).toBe(200);
    expect(again.body.pairs[0]).toMatchObject({
      state: "open",
      askId: first.body.id,
    });
    await approve(first.body.id);
    const after = await ask(ccKey, [
      { permission: NOTE_UPDATE, workspaceId: FIN },
    ]);
    expect(after.body.pairs[0].state).toBe("given");
  });
});

describe("CLIP — never more than its computer", () => {
  it("a pair the computer lacks is cut away after the add", async () => {
    // Inside the agent's limits and the person's reach, but the computer
    // cannot create notes.
    const r = await ask(ccKey, [{ permission: NOTE_CREATE, workspaceId: FIN }]);
    expect(r.status).toBe(201);
    const result = await approve(r.body.id);
    expect(await reach(ccKey)).not.toContain(`${NOTE_CREATE}@FIN`);
    // The approval says it added nothing, and why.
    expect(JSON.stringify(result)).toContain("its computer does not have");
  });
});

describe("KEY GONE — a key replaced before the tap asks again", () => {
  it("refuses the approval with ASK_KEY_GONE and writes nothing", async () => {
    const r = await ask(ccKey, [{ permission: NOTE_UPDATE, workspaceId: FIN }]);
    expect(r.status).toBe(201);
    await revokeApiKeys(h.db as never, {
      where: eq(schema.apiKeys.id, ccKey),
      reason: REPLACED_FROM_THIS_COMPUTER,
    });
    expect(await reasonOf(approve(r.body.id))).toBe("ASK_KEY_GONE");
    // Recorded as a failed approval (never approved); nothing was added.
    expect(await statusOf(r.body.id)).not.toBe("approved");
    const live = await q<{ permissions: string[] }>(
      `select permissions from grants where api_key_id = $1 and revoked_at is null`,
      [ccKey]
    );
    expect(live.flatMap((g) => g.permissions)).not.toContain(NOTE_UPDATE);
    expect(await reach(ccOtherKey)).toEqual(["entity.read@*"]);
  });
});

describe("LIMITS — an ask never widens the agent's capability list", () => {
  it("a permission outside the list is refused when asked, and nothing is filed", async () => {
    const r = await ask(ccKey, [{ permission: TASK_CREATE, workspaceId: FIN }]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ASK_BEYOND_AGENT_LIMIT");
    expect(await q(`select id from proposals`)).toEqual([]);
  });

  it("a list narrowed after the ask refuses the approval", async () => {
    const r = await ask(ccKey, [{ permission: NOTE_UPDATE, workspaceId: FIN }]);
    expect(r.status).toBe(201);
    await setCapabilities(CC, [NOTE_CREATE]);
    expect(await reasonOf(approve(r.body.id))).toBe("ASK_BEYOND_AGENT_LIMIT");
    expect(await reach(ccKey)).toEqual(["entity.read@*"]);
  });

  it("a full list (`*`) may ask for anything the person can give", async () => {
    await setCapabilities(CC, ["*"]);
    const r = await ask(ccKey, [{ permission: TASK_CREATE, workspaceId: FIN }]);
    expect(r.status).toBe(201);
  });

  it("a refusal is askable only inside the limits", async () => {
    expect(
      await askableAgentDenial({
        action: NOTE_UPDATE,
        workspaceId: FIN,
        apiKeyId: ccKey,
        callerUserId: HUMAN,
      })
    ).toEqual({ permission: NOTE_UPDATE, workspaceId: FIN });
    expect(
      await askableAgentDenial({
        action: TASK_CREATE,
        workspaceId: FIN,
        apiKeyId: ccKey,
        callerUserId: HUMAN,
      })
    ).toBeNull();
    // A computer's own key is not an agent's: never askable here.
    expect(
      await askableAgentDenial({
        action: NOTE_UPDATE,
        workspaceId: FIN,
        apiKeyId: devboxKey,
        callerUserId: HUMAN,
      })
    ).toBeNull();
  });
});

describe("SPACE — every pair names a space, reads included", () => {
  it("the door refuses a pair with no space (400)", async () => {
    const r = await ask(ccKey, [{ permission: "entity.note.read" }]);
    expect(r.status).toBe(400);
    expect(await q(`select id from proposals`)).toEqual([]);
  });

  it("the service refuses it with ASK_NEEDS_SPACE", async () => {
    expect(
      await reasonOf(
        fileAgentAccessAsk({
          apiKeyId: ccKey,
          callerUserId: HUMAN,
          pairs: [{ permission: "entity.note.read", workspaceId: null }],
        })
      )
    ).toBe("ASK_NEEDS_SPACE");
  });

  it("an ask row that carries a placeless pair is refused at approval", async () => {
    const r = await ask(ccKey, [{ permission: NOTE_UPDATE, workspaceId: FIN }]);
    // A row filed by hand (or by an older door) with a pod-wide pair.
    const placeless = [{ permission: "entity.note.read", workspaceId: null }];
    await q(
      `update proposals set data = jsonb_set(jsonb_set(data, '{requests}', $1::jsonb), '{asked}', $1::jsonb) where id = $2`,
      [JSON.stringify(placeless), r.body.id]
    );
    expect(await reasonOf(approve(r.body.id))).toBe("ASK_NEEDS_SPACE");
    expect(await reach(ccKey)).toEqual(["entity.read@*"]);
  });
});

describe("WHO MAY ASK, AND FOR WHAT", () => {
  it("a write where the person only reads is refused with ASK_NOT_ON_OFFER", async () => {
    const r = await ask(ccKey, [{ permission: NOTE_UPDATE, workspaceId: OPS }]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("ASK_NOT_ON_OFFER");
  });

  it("a computer's own key cannot ask here (NOT_AN_AGENT_KEY)", async () => {
    const r = await ask(devboxKey, [
      { permission: NOTE_UPDATE, workspaceId: FIN },
    ]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("NOT_AN_AGENT_KEY");
  });

  it("a key does not ask for another person", async () => {
    const res = await hubApp(ccKey, OTHER).request("/agents/access-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [{ permission: NOTE_UPDATE, workspaceId: FIN }],
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "NOT_AN_AGENT_KEY"
    );
  });
});
