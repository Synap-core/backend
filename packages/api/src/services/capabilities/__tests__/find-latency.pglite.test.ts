/**
 * MEASUREMENT (not a gate): how long one `findByIntent` takes, per depth,
 * cold and warm, on a REAL Postgres (PGlite, in process), every catalog real
 * except the record index (stubbed at `searchCollection`: Typesense is not
 * here) and the IS manifest fetch (no IS in a test: it degrades to []).
 *
 * It prints one `FIND-LATENCY` line per case (median of RUNS) for the
 * intent-bar W1 report. It asserts only what the cache promises (a warm call
 * reads the registry 0 times) and that every block answered, never a time:
 * a timing assertion on a shared box is a flake.
 *
 * WHAT THIS CANNOT SAY, by construction: PGlite is ONE connection in the same
 * process, so parallel arms still run one query at a time here (the win of
 * `Promise.all` needs a pool and a network round trip, i.e. a real pod), and
 * there is no network latency at all. These numbers are the CPU + SQL floor
 * of the path, a lower bound; a real pod's latency stays NEEDS-MEASURE.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});
vi.mock("@synap/intelligence-client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultActiveService: async () => {
      throw new Error("no IS in test");
    },
  };
});
const index = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("@synap/search", () => ({
  searchService: {
    searchCollection: async () => ({
      results: index.ids.map((id, i) => ({
        id,
        collection: "entities",
        document: { id, title: `Deploy contact ${i}`, entityType: "person" },
        textMatch: 1000 - i,
      })),
      found: index.ids.length,
      searchTimeMs: 1,
    }),
  },
}));
const registryReads = vi.hoisted(() => ({ n: 0 }));
vi.mock("../capability-registry.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const list = actual.listCapabilities as (...a: unknown[]) => unknown;
  return {
    ...actual,
    listCapabilities: (...a: unknown[]) => {
      registryReads.n += 1;
      return list(...a);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import { findByIntent, type FindDepth } from "../find-intent.js";
import { invalidateCapabilityReadCaches } from "../capability-read-caches.js";

const U = randomUUID();
const SPACES = [randomUUID(), randomUUID(), randomUUID()];
const N = 30;
const RUNS = 7;

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.init();
  const tables = Object.values(schema).filter((t) => {
    try {
      getTableConfig(t as PgTable);
      return true;
    } catch {
      return false;
    }
  }) as PgTable[];
  for (const t of tables) {
    await h.client!.exec(pgliteSchemaDdl([t])).catch(() => undefined);
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1,'u@x','U','human')`,
    [U]
  );
  for (const [i, ws] of SPACES.entries()) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `Space ${i} deploy`, U]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, U]
    );
  }
  for (let i = 0; i < N; i++) {
    const ws = SPACES[i % SPACES.length];
    await q(
      `insert into skills (id, name, slug, kind, status, approved, scope, workspace_id, user_id, description, metadata, tags, topics)
       values ($1,$2,$3,'code','active',true,'pod',null,$4,'Deploys a thing','{}'::jsonb,'{}','{}')`,
      [randomUUID(), `Deploy step ${i}`, `team/deploy-${i}`, U]
    );
    await q(
      `insert into automations (id, workspace_id, created_by, name, description, trigger_type, status) values ($1,$2,$3,$4,'Runs the deploy','cron','active')`,
      [randomUUID(), ws, U, `Nightly deploy ${i}`]
    );
    await q(
      `insert into focus_sessions (id, workspace_id, user_id, title, goal, status) values ($1,$2,$3,$4,'ship it','active')`,
      [randomUUID(), ws, U, `Deploy session ${i}`]
    );
    await q(
      `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,$3,$4,'markdown')`,
      [randomUUID(), U, ws, `Deploy notes ${i}`]
    );
    await q(
      `insert into views (id, workspace_id, user_id, type, name) values ($1,$2,$3,'kanban',$4)`,
      [randomUUID(), ws, U, `Deploy board ${i}`]
    );
    await q(
      `insert into playbooks (id, created_by, workspace_id, name, description, goal_template, status, scope, params) values ($1,$2,$3,$4,'How we deploy','Deploy it','active','session','[]'::jsonb)`,
      [randomUUID(), U, ws, `Deploy playbook ${i}`]
    );
    const entity = randomUUID();
    index.ids.push(entity);
    await q(
      `insert into entities (id, user_id, workspace_id, type, title) values ($1,$2,$3,'person',$4)`,
      [entity, U, ws, `Deploy contact ${i}`]
    );
  }
}, 180_000);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]! * 10) / 10;
}

async function time(
  label: string,
  run: () => Promise<unknown>,
  before?: () => void
): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    before?.();
    const t0 = performance.now();
    await run();
    xs.push(performance.now() - t0);
  }
  const m = median(xs);
  console.log(`FIND-LATENCY ${label}: median ${m} ms over ${RUNS} runs`);
  return m;
}

const call = (depth: FindDepth, catalogs?: string[]) =>
  findByIntent({
    intent: "deploy",
    workspaceId: null,
    userId: U,
    depth,
    ...(catalogs ? { catalogs } : {}),
  });

describe("find latency (PGlite floor; see the docblock for what it cannot say)", () => {
  it("every block answers (no arm failed), so the timings time real work", async () => {
    invalidateCapabilityReadCaches();
    const r = await call("full");
    for (const [k, v] of Object.entries(r)) {
      if (v && typeof v === "object" && "error" in v)
        throw new Error(`${k} failed: ${(v as { error: string }).error}`);
    }
    expect(
      r.entities && "matches" in r.entities && r.entities.matches.length
    ).toBeGreaterThan(0);
    expect(r.playbooks?.candidates.length).toBeGreaterThan(0);
  });

  it("a warm call reads the registry 0 times", async () => {
    invalidateCapabilityReadCaches();
    await call("full");
    const before = registryReads.n;
    await call("full");
    await call("instant");
    expect(registryReads.n).toBe(before);
  });

  it("measures each arm alone, then the whole door per depth, cold and warm", async () => {
    for (const arm of [
      "capabilities",
      "intents",
      "playbooks",
      "spaces",
      "entities",
      "skills",
      "automations",
      "sessions",
      "goals",
      "projects",
      "views",
      "documents",
    ]) {
      await time(
        `arm ${arm} (cold registry)`,
        () => call("full", [arm]),
        invalidateCapabilityReadCaches
      );
    }
    await time(
      "full, cold registry",
      () => call("full"),
      invalidateCapabilityReadCaches
    );
    await time("full, warm registry", () => call("full"));
    await time(
      "instant, cold registry",
      () => call("instant"),
      invalidateCapabilityReadCaches
    );
    await time("instant, warm registry", () => call("instant"));
  }, 300_000);
});
