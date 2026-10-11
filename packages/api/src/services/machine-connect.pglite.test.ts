/**
 * The device door (MACHINE-IDENTITY-PLAN W2) through its REAL service on
 * PGlite (every @synap/database table). Stubbed: audit, side effects, and the
 * governance verdict of `checkPermissionOrPropose` (asserted CONSULTED, and
 * that a refusal stops the approval).
 *
 * Pinned:
 *   - create answers RFC 8628 §3.2 fields; the row holds no code in clear;
 *   - authorization_pending → slow_down (interval +5) → access_denied /
 *     expired_token, per RFC 8628 §3.5;
 *   - keys are minted ONLY at collection, and only once;
 *   - five wrong codes close a request; five misses lock a person out;
 *   - the computer + its agents are created in one approval: agents are
 *     hosted, ask-first, and never hold more than the computer;
 *   - same hostname → the approver may reuse the computer (old key replaced);
 *   - revoking a computer revokes its agents' keys.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  perm: { granted: true } as Record<string, unknown>,
  permCalls: [] as unknown[],
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
  checkPermissionOrPropose: async (opts: unknown) => {
    h.permCalls.push(opts);
    return h.perm;
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  agentTypeName,
  collectDeviceToken,
  createDeviceRequest,
  decideDeviceRequest,
  getDeviceRequest,
  resetDeviceCodeMissesForTests,
  revokeMachine,
} from "./machine-connect.js";
import { liveGrantsOfKey } from "./key-grant.js";

const HUMAN = "human-device";
const OTHER = "human-other";

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
        : c.hasDefault && c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : c.default}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const start = (hostname = "devbox", agents = ["claude-code"]) =>
  createDeviceRequest({
    clientName: "synap-cli",
    hostname,
    platform: "linux",
    agents,
    requesterIp: "203.0.113.7",
    userAgent: "synap-cli/1",
    podAdminOrigin: "https://admin.pod.test",
  });

const poll = async (deviceCode: string) => {
  await q(`update device_auth_requests set last_polled_at = null`);
  return collectDeviceToken({ deviceCode });
};

const approve = async (
  userCode: string,
  extra: Partial<Parameters<typeof decideDeviceRequest>[0]> = {}
) => {
  const view = await getDeviceRequest({ userCode, personId: HUMAN });
  return decideDeviceRequest({
    requestId: view.requestId,
    userCode,
    personId: HUMAN,
    decision: "approve",
    ...extra,
  });
};

const keysOf = (userId: string) =>
  q<{ id: string; revoked_at: Date | null; key_type: string }>(
    `select id, revoked_at, key_type from api_keys where user_id = $1`,
    [userId]
  );

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const id of [HUMAN, OTHER])
    await q(
      `insert into users (id, email, user_type, email_verified, timezone, locale, is_personal_agent)
       values ($1, $1 || '@x', 'human', true, 'UTC', 'en', false)`,
      [id]
    );
}, 120_000);

beforeEach(() => {
  h.perm = { granted: true };
  h.permCalls = [];
  resetDeviceCodeMissesForTests();
});

describe("create", () => {
  it("answers the RFC 8628 §3.2 fields and stores no code in clear", async () => {
    const res = await start();
    expect(res).toMatchObject({
      verification_uri: "https://admin.pod.test/device",
      expires_in: 600,
      interval: 5,
    });
    expect(res.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.verification_uri_complete).toBe(
      `https://admin.pod.test/device?code=${res.user_code}`
    );
    const rows = await q<Record<string, unknown>>(
      `select * from device_auth_requests`
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(res.device_code);
    expect(dump).not.toContain(res.user_code);
    expect(dump).not.toContain(res.user_code.replace("-", ""));
  });
});

describe("poll (RFC 8628 §3.5)", () => {
  it("pending, then slow_down widening the interval by 5 s", async () => {
    const res = await start("poll-host");
    expect(await collectDeviceToken({ deviceCode: res.device_code })).toEqual({
      ok: false,
      error: "authorization_pending",
    });
    expect(await collectDeviceToken({ deviceCode: res.device_code })).toEqual({
      ok: false,
      error: "slow_down",
      interval: 10,
    });
    expect(await collectDeviceToken({ deviceCode: res.device_code })).toEqual({
      ok: false,
      error: "slow_down",
      interval: 15,
    });
  });

  it("an unknown device code is invalid_grant", async () => {
    expect(await collectDeviceToken({ deviceCode: "nope" })).toEqual({
      ok: false,
      error: "invalid_grant",
    });
  });

  it("an expired request is expired_token, and cannot be decided", async () => {
    const res = await start("expired-host");
    const view = await getDeviceRequest({
      userCode: res.user_code,
      personId: HUMAN,
    });
    await q(
      `update device_auth_requests set expires_at = now() - interval '1 second' where id = $1`,
      [view.requestId]
    );
    expect(await poll(res.device_code)).toEqual({
      ok: false,
      error: "expired_token",
    });
    await expect(
      decideDeviceRequest({
        requestId: view.requestId,
        userCode: res.user_code,
        personId: HUMAN,
        decision: "approve",
      })
    ).rejects.toThrow(/expired/);
  });

  it("denied → access_denied", async () => {
    const res = await start("deny-host");
    await approve(res.user_code, { decision: "deny" });
    expect(await poll(res.device_code)).toEqual({
      ok: false,
      error: "access_denied",
    });
  });
});

describe("wrong codes", () => {
  it("five wrong codes close the request; the terminal then reads access_denied", async () => {
    const res = await start("lock-host");
    const view = await getDeviceRequest({
      userCode: res.user_code,
      personId: HUMAN,
    });
    for (let i = 1; i <= 5; i++) {
      await expect(
        decideDeviceRequest({
          requestId: view.requestId,
          userCode: "ZZZZ-ZZZZ",
          personId: HUMAN,
          decision: "approve",
        })
      ).rejects.toThrow(i < 5 ? /doesn't match/ : /Too many wrong codes/);
    }
    // Even the RIGHT code no longer approves it.
    await expect(
      decideDeviceRequest({
        requestId: view.requestId,
        userCode: res.user_code,
        personId: HUMAN,
        decision: "approve",
      })
    ).rejects.toThrow(/already decided/);
    expect(await poll(res.device_code)).toEqual({
      ok: false,
      error: "access_denied",
    });
  });

  it("five codes that match nothing lock the person out of lookups", async () => {
    for (let i = 0; i < 5; i++)
      await expect(
        getDeviceRequest({ userCode: "QQQQ-QQQQ", personId: OTHER })
      ).rejects.toThrow(/No computer is waiting/);
    const res = await start("lookup-host");
    await expect(
      getDeviceRequest({ userCode: res.user_code, personId: OTHER })
    ).rejects.toThrow(/Too many wrong codes/);
  });
});

describe("approve → collect", () => {
  it("consults governance, and a refusal stops the approval", async () => {
    const res = await start("gov-host");
    h.perm = { denied: true, reason: "Policy says no" };
    await expect(approve(res.user_code)).rejects.toThrow(/Policy says no/);
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      userId: HUMAN,
      subjectType: "apiKey",
      action: "create",
    });
  });

  it("mints ONLY at collection, once; the computer and its agents in one step", async () => {
    const before = (await q<{ n: number }>(`select count(*)::int n from api_keys`))[0]!.n;
    const res = await start("devbox", ["claude-code", "codex"]);
    await approve(res.user_code, { agents: ["claude-code"], computerName: "My devbox" });
    // Approved — and still no key, no computer.
    expect((await q<{ n: number }>(`select count(*)::int n from api_keys`))[0]!.n).toBe(before);
    expect(
      await q(`select id from users where agent_type = 'machine' and created_by_user_id = $1`, [HUMAN])
    ).toHaveLength(0);

    const got = await poll(res.device_code);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const body = got.body;
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toBe(body.computer.apiKey);
    expect(body.expires_in).toBe(90 * 86400);
    expect(body.computer.name).toBe("My devbox");
    expect(body.agents.map((a) => a.agentType)).toEqual(["claude-code"]);
    // The type's name comes from the ONE service-name door (humanized until
    // the registry carries a row for it); the computer suffix is the point.
    expect(body.agents[0]!.displayName).toBe(
      `${agentTypeName("claude-code")} on My devbox`
    );

    // Second collection: gone.
    expect(await poll(res.device_code)).toEqual({ ok: false, error: "expired_token" });

    // Model: a machine principal (origin device), a hosted agent, both ask-first.
    const [machine] = await q<Record<string, any>>(
      `select * from users where id = $1`,
      [body.computer.id]
    );
    expect(machine).toMatchObject({
      user_type: "agent",
      agent_type: "machine",
      created_via: "device",
      created_by_user_id: HUMAN,
    });
    expect(machine!.agent_metadata).toMatchObject({
      hostname: "devbox",
      platform: "linux",
      governancePosture: "ask-first",
    });
    const [agent] = await q<Record<string, any>>(
      `select * from users where id = $1`,
      [body.agents[0]!.agentUserId]
    );
    expect(agent).toMatchObject({ host_user_id: body.computer.id, created_via: "device" });
    expect(agent!.agent_metadata).toMatchObject({ governancePosture: "ask-first" });

    // Keys: the computer's is a user_pat linked to the approver; both live.
    const [mk] = await q<Record<string, any>>(
      `select * from api_keys where id = $1`,
      [body.computer.keyId]
    );
    expect(mk).toMatchObject({ key_type: "user_pat", linked_user_id: HUMAN, is_active: true });
    // Never stored in clear.
    expect(JSON.stringify(await q(`select * from api_keys`))).not.toContain(body.computer.apiKey);

    // The agent never holds more than its computer.
    const machinePerms = new Set(
      (await liveGrantsOfKey(body.computer.keyId)).flatMap((g) => g.permissions)
    );
    const agentPerms = (await liveGrantsOfKey(body.agents[0]!.keyId)).flatMap(
      (g) => g.permissions
    );
    expect(agentPerms.length).toBeGreaterThan(0);
    for (const p of agentPerms) expect(machinePerms.has(p)).toBe(true);
    expect(machinePerms.has("*")).toBe(false);
  });

  it("same hostname: the approver may reuse the computer — its old key is replaced", async () => {
    const [first] = await q<{ id: string }>(
      `select id from users where agent_type = 'machine' and created_by_user_id = $1`,
      [HUMAN]
    );
    const oldKeys = (await keysOf(first!.id)).filter((k) => !k.revoked_at);
    const res = await start("devbox", ["claude-code"]);
    const view = await getDeviceRequest({ userCode: res.user_code, personId: HUMAN });
    expect(view.reusableComputers.map((c) => c.id)).toEqual([first!.id]);
    await approve(res.user_code, { reuseComputerId: first!.id });
    const got = await poll(res.device_code);
    if (!got.ok) throw new Error(got.error);
    expect(got.body.computer.id).toBe(first!.id);
    const keys = await keysOf(first!.id);
    for (const k of oldKeys) expect(keys.find((x) => x.id === k.id)!.revoked_at).not.toBeNull();
    // Same agent principal on the same computer: one "Claude Code on devbox".
    expect(
      await q(`select id from users where host_user_id = $1 and agent_type = 'claude-code'`, [first!.id])
    ).toHaveLength(1);
  });

  it("someone else's computer cannot be reused", async () => {
    const [first] = await q<{ id: string }>(
      `select id from users where agent_type = 'machine' and created_by_user_id = $1`,
      [HUMAN]
    );
    const res = await start("devbox");
    const view = await getDeviceRequest({ userCode: res.user_code, personId: OTHER });
    await expect(
      decideDeviceRequest({
        requestId: view.requestId,
        userCode: res.user_code,
        personId: OTHER,
        decision: "approve",
        reuseComputerId: first!.id,
      })
    ).rejects.toThrow(/not one of yours/);
  });

  it("revoking a computer revokes the keys of the agents it hosts", async () => {
    const [m] = await q<{ id: string }>(
      `select id from users where agent_type = 'machine' and created_by_user_id = $1`,
      [HUMAN]
    );
    const hosted = await q<{ id: string }>(`select id from users where host_user_id = $1`, [m!.id]);
    await revokeMachine({ machineUserId: m!.id, by: HUMAN });
    for (const u of [m!.id, ...hosted.map((x) => x.id)])
      for (const k of await keysOf(u)) expect(k.revoked_at).not.toBeNull();
  });
});
