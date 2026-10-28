/**
 * A key never carries a privileged scope its minter could not exercise
 * (pre-launch audit F7, 2026-10-28; rule: `services/privileged-mint.ts`).
 *
 * THE DEFECT. `apiKeys.create`, `createForWorkspace` and `rotate` accepted any
 * scope in `API_KEY_SCOPES`. A member minted `setup.agent`, then through
 * `/setup/agent {linkedUserId: <another human>}` got an ACTIVE agent key that
 * reads as that human; or minted `providers.write` and repointed the pod's AI
 * provider over Hub REST.
 *
 * Through the REAL procedures on PGlite. Stubbed: the db handle, the
 * governance gate (granted) and who is a pod admin (`isPodAdmin`, the one
 * predicate the rule reads). Each refusal asserts NOTHING was minted, not only
 * the error: a door that threw after inserting would otherwise pass.
 *
 * Negative control: remove the `assertMayMintScopes` calls (or make
 * `privilegedScopesBeyond` return []) and every refusal here fails.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  podAdmins: new Set<string>(),
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

vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async (userId: string) => h.podAdmins.has(userId)),
}));

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { PRIVILEGED_MINT_SCOPES } from "@synap/database/schema";
import { apiKeysRouter } from "./api-keys.js";

const MEMBER = "member-1";
const ADMIN = "admin-1";
const WS = randomUUID();
const FULL = { permissions: ["*"] };

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "usage_count"
        ? " default 0"
        : c.name === "created_at"
          ? " default now()"
          : c.name === "is_active"
            ? " default true"
            : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const caller = (
  userId: string,
  workspaceId?: string,
  extra: Record<string, unknown> = {}
) =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    ...(workspaceId ? { workspaceId } : {}),
    ...extra,
  } as never);

/** A browser (Kratos) session signed in `minutesAgo` minutes ago. */
const browser = (userId: string, minutesAgo: number) => ({
  sessionKind: "kratos",
  session: {
    identity: { id: userId, traits: { email: `${userId}@x.test` } },
    active: true,
    authenticated_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  },
});

const keyCount = async () =>
  (await h.client!.query<{ n: number }>(`select count(*)::int n from api_keys`))
    .rows[0]!.n;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `insert into workspaces (id, name) values ($1, 'Team space')`,
    [WS]
  );
  for (const u of [MEMBER, ADMIN]) {
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), WS, u]
    );
  }
});

beforeEach(() => {
  h.podAdmins = new Set([ADMIN]);
});

describe("apiKeys.create — privileged scopes need a pod admin", () => {
  it("non-vacuity: the derived privileged set is the four authority scopes", () => {
    expect([...PRIVILEGED_MINT_SCOPES].sort()).toEqual([
      "box.runner",
      "hub-protocol.admin",
      "providers.write",
      "setup.agent",
    ]);
  });

  it.each(PRIVILEGED_MINT_SCOPES as readonly string[])(
    "a member asking for %s is refused and nothing is minted",
    async (scope) => {
      const before = await keyCount();
      await expect(
        caller(MEMBER).create({
          keyName: "escalate",
          scope: ["hub-protocol.read", scope],
          grant: FULL,
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining(scope),
      });
      expect(await keyCount()).toBe(before);
    }
  );

  it("control: the same member mints ordinary scopes", async () => {
    const res = await caller(MEMBER).create({
      keyName: "ordinary",
      scope: ["hub-protocol.read", "hub-protocol.write"],
      grant: FULL,
    });
    expect(res.status).toBe("created");
  });

  it("control: a pod admin mints setup.agent", async () => {
    const before = await keyCount();
    const res = await caller(ADMIN).create({
      keyName: "operator",
      scope: ["setup.agent"],
      grant: FULL,
    });
    expect(res.status).toBe("created");
    expect(await keyCount()).toBe(before + 1);
  });
});

describe("apiKeys.createForWorkspace — a workspace admin is not a pod admin", () => {
  it("a member who owns the workspace is refused providers.write", async () => {
    const before = await keyCount();
    await expect(
      caller(MEMBER, WS).createForWorkspace({
        name: "provider writer",
        scopes: ["providers.write"],
        grant: FULL,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await keyCount()).toBe(before);
  });

  it("control: the pod admin mints it in the same workspace", async () => {
    const res = await caller(ADMIN, WS).createForWorkspace({
      name: "provider writer",
      scopes: ["providers.write"],
      grant: FULL,
    });
    expect(res.status).toBe("created");
  });
});

describe("apiKeys.rotate — a privileged key is not renewed for a non-admin", () => {
  it("an admin's setup.agent key, rotated after demotion, is refused and stays the only key", async () => {
    const minted = await caller(ADMIN).create({
      keyName: "was-admin",
      scope: ["setup.agent"],
      grant: FULL,
    });
    h.podAdmins = new Set();
    const before = await keyCount();
    await expect(
      caller(ADMIN).rotate({ keyId: minted.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await keyCount()).toBe(before);
    const old = (
      await h.client!.query<{ is_active: boolean }>(
        `select is_active from api_keys where id = $1`,
        [minted.id]
      )
    ).rows[0];
    expect(old?.is_active).toBe(true);
  });
});

/**
 * F7 addendum: the generic credential step-up constrains only a phone's
 * device session, so a pod admin's stale (or stolen) BROWSER session minted
 * privileged scopes with no prompt. A privileged mint now needs a fresh
 * credential for every session kind. Negative control: drop
 * `assertFreshForPrivilegedMint` from `assertMayMintScopes` and the stale
 * cases mint.
 */
describe("a privileged mint needs a fresh sign-in, whatever the session", () => {
  it("a pod admin's browser session signed in 2 hours ago is refused, nothing minted", async () => {
    const before = await keyCount();
    await expect(
      caller(ADMIN, undefined, browser(ADMIN, 120)).create({
        keyName: "stale",
        scope: ["setup.agent"],
        grant: FULL,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Sign in again"),
    });
    expect(await keyCount()).toBe(before);
  });

  it("a pod admin's stale browser session cannot createForWorkspace providers.write either", async () => {
    const before = await keyCount();
    await expect(
      caller(ADMIN, WS, browser(ADMIN, 120)).createForWorkspace({
        name: "stale provider writer",
        scopes: ["providers.write"],
        grant: FULL,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await keyCount()).toBe(before);
  });

  it("a stale phone device session is refused", async () => {
    const before = await keyCount();
    await expect(
      caller(ADMIN, undefined, {
        sessionKind: "person_device",
        session: {
          identity: { id: ADMIN, traits: { email: "a@x.test" } },
          active: true,
          device: {
            id: "dev-1",
            clientId: "relay",
            authTime: new Date(Date.now() - 3_600_000),
          },
        },
      }).create({ keyName: "phone", scope: ["setup.agent"], grant: FULL })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await keyCount()).toBe(before);
  });

  it("control: the same admin signed in 5 minutes ago mints it", async () => {
    const before = await keyCount();
    const res = await caller(ADMIN, undefined, browser(ADMIN, 5)).create({
      keyName: "fresh",
      scope: ["setup.agent"],
      grant: FULL,
    });
    expect(res.status).toBe("created");
    expect(await keyCount()).toBe(before + 1);
  });

  it("control: a stale session still mints ORDINARY scopes (no step-up for them)", async () => {
    const res = await caller(MEMBER, undefined, browser(MEMBER, 120)).create({
      keyName: "ordinary stale",
      scope: ["hub-protocol.read"],
      grant: FULL,
    });
    expect(res.status).toBe("created");
  });
});
