/**
 * `machines.*` — Connected › Computers (MACHINE-IDENTITY-PLAN W5), through the
 * REAL router on PGlite (every @synap/database table). A computer is made the
 * only way one is made: the device flow (create → approve → collect).
 * Stubbed: audit, side effects, the governance verdict (granted).
 *
 * Pinned:
 *   - list: YOUR computers only, each with its key state, access name, and
 *     the agents it hosts named "<agent> on <computer>";
 *   - adminList: every computer with its owner, for a pod admin only;
 *   - rename / setKeyTtl / revoke: a stranger gets NOT_FOUND; a key (no
 *     session) is refused; revoke stops the computer's AND its agents' keys;
 *   - setKeyTtl drives the lifetime the next key gets (`resolveMachineKeyTtlDays`);
 *   - whose computer it is (0388): set at the device approval (default the
 *     person's own), changed by `setBelongsTo` (owner, signed in); leaving
 *     "an agent's" takes back every approval seeded on it.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  /** Who `isPodAdmin` answers yes for. */
  admins: new Set<string>(),
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
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  collectDeviceToken,
  createDeviceRequest,
  decideDeviceRequest,
  getDeviceRequest,
  resolveMachineKeyTtlDays,
} from "../services/machine-connect.js";
import { machineKeyState } from "../services/machine-roster.js";
import { machinesRouter } from "./machines.js";

const HUMAN = "human-computers";
const STRANGER = "human-stranger";
const ADMIN = "human-pod-admin";

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

/** A signed-in person (session), or a key holder (no session). */
const caller = (userId: string, signedIn = true) =>
  machinesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    ...(signedIn ? { session: { id: "s" } } : { keyType: "user_pat" }),
  } as never);

/** Connect a computer for HUMAN through the real device flow. */
async function connectComputer(
  hostname: string,
  agents = ["claude-code"],
  belongsTo?: "person" | "agent" | "shared"
) {
  const res = await createDeviceRequest({
    clientName: "synap-cli",
    hostname,
    platform: "linux",
    agents,
    requesterIp: "203.0.113.9",
    userAgent: "synap-cli/1",
    podAdminOrigin: "https://admin.pod.test",
  });
  const view = await getDeviceRequest({
    userCode: res.user_code,
    personId: HUMAN,
  });
  await decideDeviceRequest({
    requestId: view.requestId,
    userCode: res.user_code,
    personId: HUMAN,
    decision: "approve",
    ...(belongsTo ? { belongsTo } : {}),
  });
  await q(`update device_auth_requests set last_polled_at = null`);
  const got = await collectDeviceToken({ deviceCode: res.device_code });
  if (!got.ok) throw new Error(`collect failed: ${JSON.stringify(got)}`);
  return got.body;
}

let computerId = "";

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  h.admins.add(ADMIN);
  for (const id of [HUMAN, STRANGER, ADMIN])
    await q(
      `insert into users (id, email, user_type, email_verified, timezone, locale, is_personal_agent)
       values ($1, $1 || '@x', 'human', true, 'UTC', 'en', false)`,
      [id]
    );
  computerId = (await connectComputer("devbox")).computer.id;
}, 120_000);

describe("machines.list", () => {
  it("lists your computer with its key, its access and its agents", async () => {
    const list = await caller(HUMAN).list();
    expect(list).toHaveLength(1);
    const [c] = list;
    expect(c).toMatchObject({
      id: computerId,
      name: "devbox",
      hostname: "devbox",
      platform: "linux",
      keyTtlDays: null,
      effectiveKeyTtlDays: 90,
      accessName: "AI — read & propose",
      // A new computer is the person's own unless the approver says so (0388).
      belongsTo: "person",
    });
    expect(c!.key?.state).toBe("active");
    expect(c!.agents.map((a) => a.displayName)).toEqual([
      "Claude Code on devbox",
    ]);
    expect(c!.agents[0]!.key?.state).toBe("active");
  });

  it("never lists a stranger's computer", async () => {
    expect(await caller(STRANGER).list()).toEqual([]);
  });
});

describe("machines.adminList", () => {
  it("a pod admin sees every member's computer, with its owner", async () => {
    const list = await caller(ADMIN).adminList();
    expect(list).toHaveLength(1);
    const [c] = list;
    // The same view the owner reads, plus who owns it.
    expect(c).toMatchObject({
      ...(await caller(HUMAN).list())[0],
      owner: { id: HUMAN, name: `${HUMAN}@x` },
    });
    // The admin's own floored list stays empty: they own no computer.
    expect(await caller(ADMIN).list()).toEqual([]);
  });

  it("is forbidden to anyone who is not a pod admin, the owner included", async () => {
    await expect(caller(HUMAN).adminList()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller(STRANGER).adminList()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("machines.rename", () => {
  it("renames your computer; its agents follow the new name", async () => {
    await caller(HUMAN).rename({ machineId: computerId, name: "Build box" });
    const [c] = await caller(HUMAN).list();
    expect(c!.name).toBe("Build box");
    expect(c!.agents[0]!.displayName).toBe("Claude Code on Build box");
  });

  it("a stranger gets NOT_FOUND; a key is refused", async () => {
    await expect(
      caller(STRANGER).rename({ machineId: computerId, name: "mine" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(HUMAN, false).rename({ machineId: computerId, name: "mine" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Manage a computer while signed in.",
    });
  });
});

describe("machines.setKeyTtl", () => {
  it("sets the computer's own lifetime, then clears it back to the pod default", async () => {
    await caller(HUMAN).setKeyTtl({ machineId: computerId, keyTtlDays: 30 });
    expect(await resolveMachineKeyTtlDays(computerId)).toBe(30);
    expect((await caller(HUMAN).list())[0]).toMatchObject({
      keyTtlDays: 30,
      effectiveKeyTtlDays: 30,
    });
    await caller(HUMAN).setKeyTtl({ machineId: computerId, keyTtlDays: null });
    expect(await resolveMachineKeyTtlDays(computerId)).toBe(90);
  });

  it("refuses a lifetime outside the bounds, and a stranger", async () => {
    await expect(
      caller(HUMAN).setKeyTtl({ machineId: computerId, keyTtlDays: 1 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller(STRANGER).setKeyTtl({ machineId: computerId, keyTtlDays: 30 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("machines.setRunsScripts", () => {
  const liveScopes = async () =>
    (
      await q<{ scope: string[] }>(
        `select scope from api_keys where user_id = $1 and revoked_at is null`,
        [computerId]
      )
    ).map((r) => r.scope);

  it("puts box.runner on the computer's live key and records it; off takes it away", async () => {
    expect((await liveScopes()).length).toBeGreaterThan(0);
    expect((await liveScopes()).every((s) => !s.includes("box.runner"))).toBe(
      true
    );
    await expect(
      caller(HUMAN).setRunsScripts({ machineId: computerId, enabled: true })
    ).resolves.toMatchObject({ status: "updated", runsScripts: true });
    // Twice on is still one scope, never a duplicate.
    await caller(HUMAN).setRunsScripts({
      machineId: computerId,
      enabled: true,
    });
    for (const s of await liveScopes()) {
      expect(s.filter((x) => x === "box.runner")).toHaveLength(1);
      expect(s).toContain("hub-protocol.write");
    }
    expect((await caller(HUMAN).list())[0]).toMatchObject({
      runsScripts: true,
    });
    await caller(HUMAN).setRunsScripts({
      machineId: computerId,
      enabled: false,
    });
    expect((await liveScopes()).every((s) => !s.includes("box.runner"))).toBe(
      true
    );
    expect((await caller(HUMAN).list())[0]).toMatchObject({
      runsScripts: false,
    });
  });

  it("a stranger gets NOT_FOUND; a key is refused", async () => {
    await expect(
      caller(STRANGER).setRunsScripts({ machineId: computerId, enabled: true })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(HUMAN, false).setRunsScripts({
        machineId: computerId,
        enabled: true,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("machines.revoke", () => {
  it("a stranger and a key cannot revoke", async () => {
    await expect(
      caller(STRANGER).revoke({ machineId: computerId })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(HUMAN, false).revoke({ machineId: computerId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("revokes the computer AND its agents' keys; both stay listed", async () => {
    const res = await caller(HUMAN).revoke({ machineId: computerId });
    expect(res).toMatchObject({ status: "revoked", revokedKeys: 2 });
    const [c] = await caller(HUMAN).list();
    expect(c!.key?.state).toBe("revoked");
    expect(c!.accessName).toBeNull();
    expect(c!.agents.map((a) => a.key?.state)).toEqual(["revoked"]);
  });
});

describe("machines.setBelongsTo", () => {
  const seedRow = async (machineId: string) =>
    q(
      `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by)
       values (gen_random_uuid(), 'agent', $1, 'pod', 'action', 'channel.create', 'auto', 'system:host-seed:' || gen_random_uuid())`,
      [machineId]
    );
  const liveSeeds = async (machineId: string) =>
    (
      await q<{ n: number }>(
        `select count(*)::int as n from governance_rules
         where agent_user_id = $1 and created_by like 'system:host-seed:%' and revoked_at is null`,
        [machineId]
      )
    )[0]!.n;

  it("the device approval sets it, and the owner changes it", async () => {
    const box = (await connectComputer("agent-box", ["claude-code"], "agent"))
      .computer.id;
    const read = async () =>
      (await caller(HUMAN).list()).find((c) => c.id === box)!.belongsTo;
    expect(await read()).toBe("agent");
    await expect(
      caller(HUMAN).setBelongsTo({ machineId: box, belongsTo: "shared" })
    ).resolves.toMatchObject({ status: "updated", belongsTo: "shared" });
    expect(await read()).toBe("shared");
  });

  it("leaving an agent's takes back every approval seeded on it; staying keeps them", async () => {
    const box = (await connectComputer("seeded-box", ["claude-code"], "agent"))
      .computer.id;
    await seedRow(box);
    await caller(HUMAN).setBelongsTo({ machineId: box, belongsTo: "agent" });
    expect(await liveSeeds(box)).toBe(1);
    const res = await caller(HUMAN).setBelongsTo({
      machineId: box,
      belongsTo: "person",
    });
    expect(res).toMatchObject({ seedsRevoked: 1 });
    expect(await liveSeeds(box)).toBe(0);
  });

  it("a stranger gets NOT_FOUND, a key is refused, an unknown value is refused", async () => {
    await expect(
      caller(STRANGER).setBelongsTo({
        machineId: computerId,
        belongsTo: "agent",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(HUMAN, false).setBelongsTo({
        machineId: computerId,
        belongsTo: "agent",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller(HUMAN).setBelongsTo({
        machineId: computerId,
        belongsTo: "own" as never,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("machineKeyState", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const day = 86_400_000;
  it("reads each state from the key's own stamps", () => {
    expect(machineKeyState(null, now)).toBe("none");
    expect(
      machineKeyState(
        {
          isActive: true,
          revokedAt: null,
          expiresAt: new Date(now + 30 * day),
        },
        now
      )
    ).toBe("active");
    expect(
      machineKeyState(
        { isActive: true, revokedAt: null, expiresAt: new Date(now + 3 * day) },
        now
      )
    ).toBe("expiring");
    expect(
      machineKeyState(
        { isActive: true, revokedAt: null, expiresAt: new Date(now - day) },
        now
      )
    ).toBe("expired");
    expect(
      machineKeyState(
        { isActive: false, revokedAt: new Date(now), expiresAt: null },
        now
      )
    ).toBe("revoked");
  });
});
