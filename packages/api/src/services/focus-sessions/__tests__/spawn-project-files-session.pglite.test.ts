/**
 * SPAWN A PROJECT FROM A SESSION files the session into it, and UNDO unfiles
 * it — through the real `spawnProjectFromSession` and `revertConversion` on
 * PGlite (real project row, real session write, real lineage link, real
 * `safeRevert` in-use check).
 *
 * Before 2026-09-24 the spawn never set `session.projectId`, so a new project
 * opened empty while the work that created it sat in Home's "Unfiled".
 *
 * Stubbed: `ProjectRepository.create` (inserts the row directly — the repo's
 * event-store half needs a postgres.js client PGlite is not), the event log and
 * the side-effect bus (their own suites).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = (await h.init()) as {
    insert: (t: unknown) => {
      values: (v: unknown) => {
        returning: () => Promise<Array<{ id: string; name: string }>>;
      };
    };
  };
  class ProjectRepository {
    async create(values: Record<string, unknown>) {
      const schema = await import("@synap/database/schema");
      const [row] = await db
        .insert(schema.projects)
        .values({
          name: values.name,
          description: values.description,
          status: "active",
          userId: values.userId,
          workspaceId: values.workspaceId ?? null,
          metadata: values.metadata,
        })
        .returning();
      return { ...row!, deduped: false };
    }
  }
  class EventRepository {}
  return {
    ...actual,
    db,
    getDb: async () => db,
    sql: undefined,
    ProjectRepository,
    EventRepository,
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { spawnProjectFromSession } from "../spawn-project.js";
import { revertConversion } from "../session-conversion.js";

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
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";

async function seedSession(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, 'Grant file', 'Assemble the Bpifrance grant file', 'active', 'human',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now())`,
    [id, USER]
  );
  return id;
}

const projectOf = async (sessionId: string) =>
  (
    await q<{ project_id: string | null }>(
      `select project_id from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.project_id;

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from projects; delete from links;"
  );
});

describe("spawn a project from a session", () => {
  it("files the spawning session into the new project", async () => {
    const sessionId = await seedSession();
    const res = await spawnProjectFromSession({ sessionId, userId: USER });
    expect(res.status).toBe("spawned");
    if (res.status !== "spawned") return;
    expect(await projectOf(sessionId)).toBe(res.projectId);
  });

  it("undo unfiles it again (and the filing does not count as a use)", async () => {
    const sessionId = await seedSession();
    const res = await spawnProjectFromSession({ sessionId, userId: USER });
    if (res.status !== "spawned") throw new Error("spawn failed");
    const undo = await revertConversion({ sessionId, userId: USER });
    expect(undo).toMatchObject({ ok: true });
    expect(await projectOf(sessionId)).toBeNull();
  });

  it("undo leaves a session the person re-filed elsewhere where they put it", async () => {
    const sessionId = await seedSession();
    const res = await spawnProjectFromSession({ sessionId, userId: USER });
    if (res.status !== "spawned") throw new Error("spawn failed");
    const elsewhere = randomUUID();
    await q(
      `insert into projects (id, user_id, name, status, created_at, updated_at) values ($1, $2, 'Other', 'active', now(), now())`,
      [elsewhere, USER]
    );
    await q(`update focus_sessions set project_id = $1 where id = $2`, [
      elsewhere,
      sessionId,
    ]);
    await revertConversion({ sessionId, userId: USER });
    expect(await projectOf(sessionId)).toBe(elsewhere);
  });
});
