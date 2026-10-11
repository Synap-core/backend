/**
 * `machines.*` — Connected › Computers (MACHINE-IDENTITY-PLAN W5), through the
 * REAL router on PGlite (every @synap/database table). A computer is made the
 * only way one is made: the device flow (create → approve → collect).
 * Stubbed: audit, side effects, the governance verdict (granted).
 *
 * Pinned:
 *   - list: YOUR computers only, each with its key state, access name, and
 *     the agents it hosts named "<agent> on <computer>";
 *   - rename / setKeyTtl / revoke: a stranger gets NOT_FOUND; a key (no
 *     session) is refused; revoke stops the computer's AND its agents' keys;
 *   - setKeyTtl drives the lifetime the next key gets (`resolveMachineKeyTtlDays`).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

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
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => false,
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
async function connectComputer(hostname: string, agents = ["claude-code"]) {
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
  for (const id of [HUMAN, STRANGER])
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
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
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
