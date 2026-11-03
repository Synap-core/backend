/**
 * Agents inside a computer (0395, plan "Computer once, agents inside" rev 3,
 * pod document 31470fd5 §10 tests 1-5) through the REAL device door on
 * PGlite, with 0395's unique index applied from the migration file.
 *
 * The 2 Nov incident, pinned: OS user `agent` ran `synap init` on devbox; the
 * page pre-selected "Reconnect devbox" by hostname and approving it revoked
 * the CRM worker's live key and the other seat's computer key.
 *
 *   1. no-cross-rekey — a second seat asking for the same engine is offered
 *      "add", and approving it leaves the running agent's key AND the other
 *      seat's computer key live; the new agent has its own key;
 *   2. two jobs, one engine, one seat coexist; a concurrent insert resolves
 *      to one row per job;
 *   3. two seats, same engine, no job coexist;
 *   4. reconnecting ONE agent leaves its siblings' keys and the other seats'
 *      computer keys untouched, and keeps its permission (D6);
 *   5. an older CLI (no seat, no held keys): "add" while the agent's key was
 *      used in the last 24 h, "reconnect" once it was not.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  approveDecision,
  defaultAgentActions,
  type DeviceRequest,
} from "@synap-core/types/device";
import {
  collectDeviceToken,
  createDeviceRequest,
  decideDeviceRequest,
  getDeviceRequest,
  resetDeviceCodeMissesForTests,
} from "./machine-connect.js";
import { findOrCreateServiceAgentUser } from "./agent-identity-service.js";

const HUMAN = "human-seats";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  here,
  "../../../database/migrations/0395_agents_inside_a_computer.sql"
);

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
        : c.hasDefault &&
            c.default !== undefined &&
            typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : c.default}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

type Start = Partial<Parameters<typeof createDeviceRequest>[0]>;
const start = (hostname: string, over: Start = {}) =>
  createDeviceRequest({
    clientName: "synap-cli",
    hostname,
    platform: "linux",
    agents: ["claude-code"],
    requesterIp: "203.0.113.7",
    userAgent: "synap-cli/2",
    podAdminOrigin: "https://admin.pod.test",
    ...over,
  });

/** The read as a surface gets it (JSON: dates are ISO strings). */
const read = async (userCode: string): Promise<DeviceRequest> =>
  JSON.parse(
    JSON.stringify(await getDeviceRequest({ userCode, personId: HUMAN }))
  );

/** Approve exactly what the page sends with its defaults untouched. */
async function approvePageDefaults(
  res: { user_code: string },
  reuseComputerId: string | null
) {
  const req = await read(res.user_code);
  const decision = approveDecision(req, res.user_code, {
    agents: [],
    actions: defaultAgentActions(req, reuseComputerId),
    reuseComputerId,
    computerName: req.hostname,
  });
  await decideDeviceRequest({ ...decision, personId: HUMAN });
  return req;
}

async function collect(deviceCode: string) {
  await q(`update device_auth_requests set last_polled_at = null`);
  const got = await collectDeviceToken({ deviceCode });
  if (!got.ok) throw new Error(`collect: ${got.error}`);
  return got.body;
}

const keyRow = async (id: string) =>
  (
    await q<{ revoked_at: Date | null; is_active: boolean }>(
      `select revoked_at, is_active from api_keys where id = $1`,
      [id]
    )
  )[0]!;

const liveKeysOf = async (userId: string) =>
  q<{ id: string; instance_id: string | null }>(
    `select id, instance_id from api_keys
      where user_id = $1 and revoked_at is null and is_active = true`,
    [userId]
  );

/**
 * A computer paired before seats, like devbox on 2 Nov: one agent with no
 * seat (the CRM worker, 7455fd94) whose key is in use NOW, and the computer
 * key held by seat `antoine`.
 */
async function devboxBeforeSeats(hostname: string) {
  const res = await start(hostname);
  await decideDeviceRequest({
    requestId: (await read(res.user_code)).requestId,
    userCode: res.user_code,
    personId: HUMAN,
    decision: "approve",
  });
  const body = await collect(res.device_code);
  const machineId = body.computer.id;
  const crm = body.agents[0]!;
  await q(
    `update api_keys set instance_id = $2, instance_label = 'antoine', last_used_at = now()
      where id = $1`,
    [body.computer.keyId, `seat-antoine-${hostname}`.padEnd(24, "0")]
  );
  await q(`update api_keys set last_used_at = now() where id = $1`, [
    crm.keyId,
  ]);
  return {
    machineId,
    crmAgentId: crm.agentUserId,
    crmKeyId: crm.keyId,
    antoineComputerKeyId: body.computer.keyId,
  };
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // 0395's identity index, as the migration writes it (absent on a branch
  // without the migration: the identity tests then fail on their asserts).
  if (existsSync(MIGRATION)) {
    const sql = readFileSync(MIGRATION, "utf8");
    const index = sql.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_service_agent_identity_unique[\s\S]*?;/
    );
    if (index) await h.client!.exec(index[0]);
  }
  await q(
    `insert into users (id, email, user_type, email_verified, timezone, locale, is_personal_agent)
     values ($1, $1 || '@x', 'human', true, 'UTC', 'en', false)`,
    [HUMAN]
  );
}, 120_000);

beforeEach(() => {
  resetDeviceCodeMissesForTests();
});

describe("1. no-cross-rekey: a second OS user adds its own agent", () => {
  it("is offered 'add', and approving it re-keys nobody else", async () => {
    const devbox = await devboxBeforeSeats("devbox-1");

    // OS user `agent` runs `synap init` on devbox.
    const res = await start("devbox-1", {
      seat: "agent",
      seatId: "seat-agent-devbox-1-000000",
    });
    const req = await read(res.user_code);
    const computer = req.reusableComputers.find(
      (c) => c.id === devbox.machineId
    );
    // The hostname still finds the computer — but the agent row is "add".
    expect(computer?.recommended).toEqual([
      {
        rowKey: "claude-code:",
        action: "add",
        agentId: null,
        reason: "in-use",
      },
    ]);
    await approvePageDefaults(res, devbox.machineId);
    const body = await collect(res.device_code);

    // The running CRM worker's key and seat antoine's computer key: live.
    expect(await keyRow(devbox.crmKeyId)).toMatchObject({
      revoked_at: null,
      is_active: true,
    });
    expect(await keyRow(devbox.antoineComputerKeyId)).toMatchObject({
      revoked_at: null,
      is_active: true,
    });
    // A NEW agent for seat `agent`, with its own key; the computer reused.
    expect(body.computer.id).toBe(devbox.machineId);
    const added = body.agents[0]!;
    expect(added.agentUserId).not.toBe(devbox.crmAgentId);
    expect(added).toMatchObject({ action: "added", seat: "agent" });
    const [row] = await q<{ host_user_id: string; host_seat: string }>(
      `select host_user_id, host_seat from users where id = $1`,
      [added.agentUserId]
    );
    expect(row).toEqual({ host_user_id: devbox.machineId, host_seat: "agent" });
    expect((await keyRow(added.keyId)).revoked_at).toBeNull();
    // This seat's computer key is its own instance.
    const [ck] = await q<{ instance_id: string; instance_label: string }>(
      `select instance_id, instance_label from api_keys where id = $1`,
      [body.computer.keyId]
    );
    expect(ck).toEqual({
      instance_id: "seat-agent-devbox-1-000000",
      instance_label: "agent",
    });
  });
});

describe("2. two jobs, one engine, one seat", () => {
  it("the CRM worker and the dev worker are two agents with their own keys", async () => {
    const res = await start("devbox-2", {
      seat: "antoine",
      seatId: "seat-antoine-devbox-2-0000",
      agents: [],
      rows: [
        {
          agentType: "claude-code",
          role: "crm-worker",
          roleLabel: "CRM worker",
        },
        {
          agentType: "claude-code",
          role: "dev-worker",
          roleLabel: "Dev worker",
        },
      ],
    });
    const req = await read(res.user_code);
    expect(req.rows?.map((r) => r.key)).toEqual([
      "claude-code:crm-worker",
      "claude-code:dev-worker",
    ]);
    await approvePageDefaults(res, null);
    const body = await collect(res.device_code);
    expect(body.agents.map((a) => [a.role, a.name])).toEqual([
      ["crm-worker", "CRM worker"],
      ["dev-worker", "Dev worker"],
    ]);
    expect(body.agents[0]!.displayName).toBe(
      "CRM worker · Claude Code on devbox-2"
    );
    const [crm, dev] = body.agents;
    expect(crm!.agentUserId).not.toBe(dev!.agentUserId);
    expect(await liveKeysOf(crm!.agentUserId)).toHaveLength(1);
    expect(await liveKeysOf(dev!.agentUserId)).toHaveLength(1);
  });

  it("a concurrent insert of one job resolves to one row per job", async () => {
    const [machine] = await q<{ id: string }>(
      `select id from users where agent_type = 'machine' and agent_metadata->>'hostname' = 'devbox-2'`
    );
    const one = (role: string) =>
      findOrCreateServiceAgentUser({
        creatorId: HUMAN,
        agentType: "codex",
        label: role,
        hostUserId: machine!.id,
        hostSeat: "antoine",
        agentRole: role,
      });
    const got = await Promise.all([
      one("crm-worker"),
      one("crm-worker"),
      one("dev-worker"),
      one("dev-worker"),
    ]);
    expect(got[0]!.agentUserId).toBe(got[1]!.agentUserId);
    expect(got[2]!.agentUserId).toBe(got[3]!.agentUserId);
    expect(got[0]!.agentUserId).not.toBe(got[2]!.agentUserId);
    const rows = await q<{ agent_role: string; n: number }>(
      `select agent_role, count(*)::int n from users
        where host_user_id = $1 and agent_type = 'codex' group by agent_role order by agent_role`,
      [machine!.id]
    );
    expect(rows).toEqual([
      { agent_role: "crm-worker", n: 1 },
      { agent_role: "dev-worker", n: 1 },
    ]);
  });
});

describe("3. two seats, same engine, no job", () => {
  it("each OS user gets its own Claude Code on the computer; both keys stay live", async () => {
    const first = await start("devbox-3", {
      seat: "antoine",
      seatId: "seat-antoine-devbox-3-0000",
    });
    await approvePageDefaults(first, null);
    const a = await collect(first.device_code);

    const second = await start("devbox-3", {
      seat: "agent",
      seatId: "seat-agent-devbox-3-000000",
    });
    const req = await read(second.user_code);
    expect(req.reusableComputers[0]!.recommended).toEqual([
      expect.objectContaining({ action: "add", reason: "other-seat" }),
    ]);
    await approvePageDefaults(second, a.computer.id);
    const b = await collect(second.device_code);

    expect(b.agents[0]!.agentUserId).not.toBe(a.agents[0]!.agentUserId);
    expect(await liveKeysOf(a.agents[0]!.agentUserId)).toHaveLength(1);
    expect(await liveKeysOf(b.agents[0]!.agentUserId)).toHaveLength(1);
    // One live computer key per seat.
    expect(
      (await liveKeysOf(a.computer.id)).map((k) => k.instance_id).sort()
    ).toEqual(["seat-agent-devbox-3-000000", "seat-antoine-devbox-3-0000"]);
    // Names carry the seat once the computer has two.
    expect(b.agents[0]!.displayName).toBe("Claude Code on devbox-3 · agent");
  });
});

describe("4. reconnect one agent", () => {
  it("re-keys only the agent ticked; its sibling, the other seat and its permission are kept", async () => {
    // Seat antoine: CRM worker X and dev worker Y. Seat agent: its own key.
    const first = await start("devbox-4", {
      seat: "antoine",
      seatId: "seat-antoine-devbox-4-0000",
      agents: [],
      rows: [
        {
          agentType: "claude-code",
          role: "crm-worker",
          roleLabel: "CRM worker",
        },
        {
          agentType: "claude-code",
          role: "dev-worker",
          roleLabel: "Dev worker",
        },
      ],
    });
    {
      const req = await read(first.user_code);
      await decideDeviceRequest({
        ...approveDecision(req, first.user_code, {
          agents: [],
          actions: defaultAgentActions(req, null),
          reuseComputerId: null,
          computerName: "devbox-4",
          agentWriteMode: "pod-default",
        }),
        personId: HUMAN,
      });
    }
    const one = await collect(first.device_code);
    const machineId = one.computer.id;
    const [x, y] = one.agents;
    const other = await start("devbox-4", {
      seat: "agent",
      seatId: "seat-agent-devbox-4-000000",
    });
    await approvePageDefaults(other, machineId);
    const agentSeat = await collect(other.device_code);
    // Y works right now; the person later made X "Creates only".
    await q(`update api_keys set last_used_at = now() where id = $1`, [
      y!.keyId,
    ]);
    await q(
      `update users set agent_metadata = agent_metadata || '{"governancePosture":"create-with-undo"}'::jsonb where id = $1`,
      [x!.agentUserId]
    );

    // Seat antoine reconnects the CRM worker only, holding its key.
    const again = await start("devbox-4", {
      seat: "antoine",
      seatId: "seat-antoine-devbox-4-0000",
      agents: [],
      rows: [{ agentType: "claude-code", role: "crm-worker" }],
      held: [{ keyId: x!.keyId, agentUserId: x!.agentUserId }],
    });
    const req = await read(again.user_code);
    const rec = req.reusableComputers.find((c) => c.id === machineId)!;
    expect(rec.recommended).toEqual([
      {
        rowKey: "claude-code:crm-worker",
        action: "reconnect",
        agentId: x!.agentUserId,
        reason: "this-seat",
      },
    ]);
    // The page shows X's current permission, kept unless changed.
    expect(rec.agents?.find((a) => a.id === x!.agentUserId)?.writeMode).toBe(
      "create-with-undo"
    );
    await decideDeviceRequest({
      ...approveDecision(req, again.user_code, {
        agents: [],
        actions: defaultAgentActions(req, machineId),
        reuseComputerId: machineId,
        computerName: "devbox-4",
        // The page's write-mode choice is about ADDED agents: not X's.
        agentWriteMode: "pod-default",
      }),
      personId: HUMAN,
    });
    const back = await collect(again.device_code);

    expect(back.agents).toHaveLength(1);
    expect(back.agents[0]).toMatchObject({
      agentUserId: x!.agentUserId,
      action: "reconnected",
    });
    expect((await keyRow(x!.keyId)).revoked_at).not.toBeNull();
    expect((await keyRow(y!.keyId)).revoked_at).toBeNull();
    expect((await keyRow(agentSeat.computer.keyId)).revoked_at).toBeNull();
    expect((await keyRow(agentSeat.agents[0]!.keyId)).revoked_at).toBeNull();
    // Only antoine's own computer key was replaced.
    expect((await keyRow(one.computer.keyId)).revoked_at).not.toBeNull();
    // D6: the reconnect kept X's permission.
    const [meta] = await q<{ p: string | null }>(
      `select agent_metadata->>'governancePosture' p from users where id = $1`,
      [x!.agentUserId]
    );
    expect(meta!.p).toBe("create-with-undo");
  });
});

describe("5. an older CLI (no seat, no held keys)", () => {
  it("never defaults to reconnect for an agent whose key was used in the last 24 h", async () => {
    const devbox = await devboxBeforeSeats("devbox-5");
    const res = await start("devbox-5"); // today's CLI: hostname + agents only
    const req = await read(res.user_code);
    expect(req.seat ?? null).toBeNull();
    expect(req.reusableComputers[0]!.recommended).toEqual([
      {
        rowKey: "claude-code:",
        action: "add",
        agentId: null,
        reason: "in-use",
      },
    ]);
    // An older page sends no per-row decision: the pod applies the same rule.
    await decideDeviceRequest({
      requestId: req.requestId,
      userCode: res.user_code,
      personId: HUMAN,
      decision: "approve",
      reuseComputerId: devbox.machineId,
    });
    const body = await collect(res.device_code);
    expect((await keyRow(devbox.crmKeyId)).revoked_at).toBeNull();
    expect((await keyRow(devbox.antoineComputerKeyId)).revoked_at).toBeNull();
    expect(body.agents[0]!.agentUserId).not.toBe(devbox.crmAgentId);
    expect(body.agents[0]!.seat).toMatch(/^unnamed:/);
  });

  it("reconnects the agent once its key has not been used for 24 h", async () => {
    const devbox = await devboxBeforeSeats("devbox-5b");
    await q(
      `update api_keys set last_used_at = now() - interval '25 hours' where id = $1`,
      [devbox.crmKeyId]
    );
    const res = await start("devbox-5b");
    const req = await read(res.user_code);
    expect(req.reusableComputers[0]!.recommended).toEqual([
      {
        rowKey: "claude-code:",
        action: "reconnect",
        agentId: devbox.crmAgentId,
        reason: "idle",
      },
    ]);
    await decideDeviceRequest({
      requestId: req.requestId,
      userCode: res.user_code,
      personId: HUMAN,
      decision: "approve",
      reuseComputerId: devbox.machineId,
    });
    const body = await collect(res.device_code);
    expect(body.agents[0]!.agentUserId).toBe(devbox.crmAgentId);
    expect((await keyRow(devbox.crmKeyId)).revoked_at).not.toBeNull();
    // The other seat's computer key, used now, is still not replaced.
    expect((await keyRow(devbox.antoineComputerKeyId)).revoked_at).toBeNull();
  });
});
