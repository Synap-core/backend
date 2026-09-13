/**
 * The tighten recommender on its CRON, driven end to end on PGlite.
 *
 * Real: `handleGovernanceTightenScan` (the jobs worker) → the IoC slot filled
 * with the REAL `recommendTightenForAllAgents` (exactly the thunk apps/api
 * registers) → agent enumeration, motif qualification, `hasPendingFinding`
 * dedupe → `insertPendingProposal`. Tables are generated from the Drizzle
 * definitions.
 *
 * The worker is imported through the package door (`@synap/jobs/workers/*`,
 * the `fingerprint-parity.test.ts` precedent), which resolves to jobs' `dist` —
 * so this file needs `@synap/jobs` built after the worker lands.
 *
 * Stubbed, and why: `notifyProposalCreatedOrdered` — the pod-wide bell fan-out
 * with its own suites (importOriginal + spread).
 *
 * NOT covered: the queue/schedule registration (queues-are-created tripwire)
 * and the apps/api boot registration line (typecheck only).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    /** ONE PGlite for every `db` handle — see the client-pg mock below. */
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
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

// SPLIT-BRAIN GUARD. `insertPendingProposal` imports `db` from its own
// `../client-pg.js`, NOT from the `@synap/database` barrel — so mocking only the
// barrel sent the recommender's READS to PGlite and its INSERT to the real
// postgres.js pool (observed: DrizzleQueryError from PostgresJsPreparedQuery).
// Both handles are pinned to the same PGlite instance.
// Both paths: `@synap/database` resolves to `dist` (package exports), and the
// stack only READS as `src` through source maps — so the dist module is the one
// that must be pinned. The src path is kept for a resolver that aliases to src.
// (Factories call into `h`: `vi.mock` is hoisted above any module-level const.)
vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});
vi.mock(
  "../../../notifications/notify-proposal-created-ordered.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    notifyProposalCreatedOrdered: vi.fn(async () => undefined),
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  users,
  proposals,
  governanceRules,
  proposalClusterMutes,
} from "@synap/database";
import { recommendTightenForAllAgents } from "../recommend-tighten.js";
import {
  handleGovernanceTightenScan,
  registerTightenRecommender,
} from "@synap/jobs/workers/governance-tighten-cron.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** The column's DEFAULT, so a door that omits `id` / `status` still inserts. */
function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (type === "jsonb" && d && typeof d === "object" && !("queryChunks" in d)) {
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
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWNER = "owner-1";
const AGENT = "agent-1";

async function findings(): Promise<number> {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from proposals
      where proposal_type in ('governance.tighten_lane', 'governance.advisory')`
  );
  return rows[0]!.n;
}

describe("governance.tighten-scan cron → the real recommender", () => {
  beforeAll(async () => {
    for (const t of [users, proposals, governanceRules, proposalClusterMutes]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, user_type, created_by_user_id) values ($1, 'agent', $2)`,
      [AGENT, OWNER]
    );
    // A motif the humans reject consistently, for a JUDGMENT reason.
    for (let i = 0; i < 6; i++) {
      await q(
        `insert into proposals (id, status, proposal_type, target_type, target_id, data,
           agent_user_id, created_by, reason_code, created_at, updated_at)
         values ($1, 'rejected', 'delete', 'entity', $2, '{}'::jsonb, $3, $4, 'not_relevant', now(), now())`,
        [randomUUID(), randomUUID(), AGENT, OWNER]
      );
    }
  });

  it("an unregistered slot fails the job instead of skipping the tick", async () => {
    await expect(handleGovernanceTightenScan()).rejects.toThrow(
      /registerTightenRecommender/
    );
    expect(await findings()).toBe(0);
  });

  it("files exactly one finding for the rejected motif, and a second tick files none", async () => {
    registerTightenRecommender(() => recommendTightenForAllAgents());

    const first = await handleGovernanceTightenScan();
    expect(first).toMatchObject({ proposalsFiled: 1, agentsFailed: 0 });
    expect(await findings()).toBe(1);

    const { rows } = await q<{
      proposal_type: string;
      data: { targetPattern: string };
    }>(
      `select proposal_type, data from proposals where proposal_type like 'governance.%'`
    );
    expect(rows[0]).toMatchObject({
      proposal_type: "governance.tighten_lane",
      data: { targetPattern: "entity.delete" },
    });

    const second = await handleGovernanceTightenScan();
    expect(second).toMatchObject({ proposalsFiled: 0, agentsFailed: 0 });
    expect(await findings()).toBe(1);
  });
});
