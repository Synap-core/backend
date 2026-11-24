/**
 * A PLANNED step's playbook run (founder P4; finding 1876c2ca) — on PGlite,
 * through the real doors (`createFocusSession`, `updateFocusSession` →
 * `followPlaybook`, `setSessionStatus` → `setRunStatus`).
 *
 * A step born planned with a playbook gets its run `queued` (held and
 * claimed by its starter), never `running`: it has not started. When the
 * step starts, the session status write moves that run to `running` in the
 * same transaction. A run handed to another agent keeps waiting for its
 * claim. Stubbed as `create-session.playbook-slots.pglite.test.ts`.
 *
 * Each case names the WRONG rule it rules out.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../ensure-session-channel.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureSessionChannel: async () => null,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";
import { updateFocusSession } from "../update-session.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "11111111-1111-4111-8111-111111111111";
const PLAYBOOK = "44444444-4444-4444-8444-444444444444";

const runsOf = async (sessionId: string) =>
  (
    await q<{ status: string; holder: { claimedAt: string | null } }>(
      `select status, holder from playbook_runs where session_id = $1 order by started_at`,
      [sessionId]
    )
  ).rows;

const start = (extra: Record<string, unknown> = {}) =>
  createFocusSession({
    userId: USER,
    goal: `Write the brief ${randomUUID()}`,
    matchTemplate: false,
    forceCreate: true,
    ...extra,
  });

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table the generator cannot express is not read by these doors.
      }
    }
  }
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'a@x.test', 'Antoine', 'human')`,
    [USER]
  );
  await q(
    `insert into playbooks
       (id, workspace_id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, version, status, created_at, updated_at)
     values ($1, null, $2, 'Write a brief', 'Write a brief', 'is-agent',
             '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'active', now(), now())`,
    [PLAYBOOK, USER]
  );
}, 120_000);

describe("a planned step's playbook run waits with it, and starts with it", () => {
  it("born planned with a playbook: the run is queued (claimed), not running; a step born active runs", async () => {
    const planned = await start({
      templateId: PLAYBOOK,
      plannedFor: "2099-01",
    });
    const now = await start({ templateId: PLAYBOOK });
    if (planned.status !== "created" || now.status !== "created") {
      throw new Error("not created");
    }
    expect(planned.session.status).toBe("forming");
    const [run] = await runsOf(planned.session.id);
    // Rules out: "a run is born running whatever its step".
    expect(run?.status).toBe("queued");
    expect(run?.holder.claimedAt).toBeTruthy();
    expect((await runsOf(now.session.id))[0]?.status).toBe("running");
  });

  it("the step starts (a person starts it): its run moves to running in the same write", async () => {
    const planned = await start({
      templateId: PLAYBOOK,
      plannedFor: "2099-01",
    });
    if (planned.status !== "created") throw new Error("not created");
    const res = await updateFocusSession({
      sessionId: planned.session.id,
      userId: USER,
      status: "active",
      expectedStatus: "forming",
    });
    expect(res.status).toBe("updated");
    // Rules out: "the run stays queued after its step started".
    expect((await runsOf(planned.session.id))[0]?.status).toBe("running");
  });

  it("a planned step that FOLLOWS a playbook gets its run queued too", async () => {
    const planned = await start({ plannedFor: "2099-01" });
    if (planned.status !== "created") throw new Error("not created");
    expect(planned.session.status).toBe("forming");
    await updateFocusSession({
      sessionId: planned.session.id,
      userId: USER,
      followPlaybookId: PLAYBOOK,
    });
    expect((await runsOf(planned.session.id)).map((r) => r.status)).toEqual([
      "queued",
    ]);
  });
});
