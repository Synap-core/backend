/**
 * BEHAVIOURAL test for the TRUE ONE-SHOT governance backfill.
 *
 * NOT a source/AST test. Source-text assertions in this repo have been proven to
 * pin PRESENCE, not EXECUTION (a `false &&` inserted into a guarded branch left
 * 25 such tests green). So this file RUNS `backfillGovernanceRules` — twice, and
 * across a floor change — against an in-memory Postgres stand-in and measures
 * the ROWS it produced.
 *
 * The stand-in (`makeFakeDb`) is not a hardcoded script: it stores real rows and
 * EVALUATES the drizzle `SQL` condition objects the code actually builds
 * (`and` / `eq` / `isNull` / `inArray`) against those rows, so the insert guard,
 * the scope match and the cleanup filter all do real work here. `transaction()`
 * is a real mutex + snapshot/rollback, standing in for
 * `pg_advisory_xact_lock` + COMMIT/ROLLBACK.
 *
 * @see backfill-governance-rules.ts — the TRUE ONE-SHOT header note.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Column, Param, getTableColumns, is } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// The MOVING FLOOR. `filterUncoveredActions` reads `DEFAULT_AUTO_APPROVE` at
// call time through its default parameter, so replacing it with a MUTABLE array
// lets a test simulate exactly what commit `d2e4a549` did: remove an action from
// the code floor between two boots.
// ---------------------------------------------------------------------------
const MUTABLE_FLOOR: string[] = [];

vi.mock("@synap/governance-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/governance-policy")>();
  return { ...actual, DEFAULT_AUTO_APPROVE: MUTABLE_FLOOR };
});

const { DEFAULT_AUTO_APPROVE: REAL_FLOOR } = await vi.importActual<
  typeof import("@synap/governance-policy")
>("@synap/governance-policy");

const { backfillGovernanceRules } =
  await import("./backfill-governance-rules.js");
const { governanceRules } = await import("../schema/governance-rules.js");
const { users } = await import("../schema/users.js");
const { workspaces } = await import("../schema/workspaces.js");
const { podSettings } = await import("../schema/pod-settings.js");

// ---------------------------------------------------------------------------
// Condition evaluator — runs a drizzle `SQL` predicate against a plain JS row.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/** db-column-name → JS property name, per table. */
const propMaps = new Map<unknown, Record<string, string>>();
function propMap(table: PgTable): Record<string, string> {
  let m = propMaps.get(table);
  if (!m) {
    m = {};
    for (const [prop, col] of Object.entries(getTableColumns(table))) {
      m[(col as any).name] = prop;
    }
    propMaps.set(table, m);
  }
  return m;
}

const isSql = (x: any): boolean => !!x && Array.isArray(x?.queryChunks);
const chunkText = (c: any): string | null =>
  !isSql(c) && !is(c, Column) && !is(c, Param) && Array.isArray(c?.value)
    ? c.value.join("")
    : null;
const paramValue = (c: any): unknown => (is(c, Param) ? (c as any).value : c);

function evalCond(cond: any, row: any, table: PgTable): boolean {
  if (cond === undefined || cond === null) return true;
  const map = propMap(table);
  const chunks = (cond.queryChunks as any[]).filter((c) => {
    const t = chunkText(c);
    return !(
      t !== null &&
      (t.trim() === "" || t.trim() === "(" || t.trim() === ")")
    );
  });

  // Boolean combinator level: `(a and b and c)` / `(a or b)`.
  const joiners = chunks
    .map((c) => chunkText(c)?.trim())
    .filter((t): t is string => t === "and" || t === "or");
  if (joiners.length > 0) {
    const operands = chunks.filter((c) => isSql(c));
    const results = operands.map((o) => evalCond(o, row, table));
    return joiners[0] === "or" ? results.some(Boolean) : results.every(Boolean);
  }

  // A single nested SQL wrapper (`and(x)` with one operand) — unwrap.
  if (chunks.length === 1 && isSql(chunks[0])) {
    return evalCond(chunks[0], row, table);
  }

  // Leaf: COL <op> [params]
  const col = chunks.find((c) => is(c, Column)) as any;
  if (!col) throw new Error("fake db: unsupported condition (no column)");
  const prop = map[col.name];
  const actualValue = row[prop];
  const op = chunks
    .map((c) => chunkText(c)?.trim())
    .filter((t): t is string => !!t)
    .join(" ");

  if (op === "is null")
    return actualValue === null || actualValue === undefined;
  if (op === "is not null")
    return actualValue !== null && actualValue !== undefined;
  if (op === "=") {
    const p = chunks.find((c) => is(c, Param));
    return actualValue === paramValue(p);
  }
  if (op === "in") {
    const arr = chunks.find((c) => Array.isArray(c)) as any[];
    return arr.map(paramValue).includes(actualValue);
  }
  throw new Error(`fake db: unsupported operator "${op}"`);
}

// ---------------------------------------------------------------------------
// The in-memory Postgres stand-in.
// ---------------------------------------------------------------------------

interface FakeStore {
  governanceRules: any[];
  users: any[];
  workspaces: any[];
  podSettings: any[];
}

const TABLE_KEYS = new Map<unknown, keyof FakeStore>();

function makeFakeDb(initial: Partial<FakeStore>) {
  const store: FakeStore = {
    governanceRules: [],
    users: [],
    workspaces: [],
    podSettings: [],
    ...initial,
  };
  TABLE_KEYS.set(governanceRules, "governanceRules");
  TABLE_KEYS.set(users, "users");
  TABLE_KEYS.set(workspaces, "workspaces");
  TABLE_KEYS.set(podSettings, "podSettings");

  /** Tables SELECTed since the last `resetProbes()` — proves what was READ. */
  const selectedTables: string[] = [];
  /** Raw SQL text passed to `db.execute` — proves the advisory lock is taken. */
  const executed: string[] = [];
  /** Set by a test to make a specific table's SELECT throw (partial-run case). */
  let failOnSelect: keyof FakeStore | null = null;

  let idSeq = 0;
  const key = (t: PgTable) => {
    const k = TABLE_KEYS.get(t);
    if (!k) throw new Error("fake db: unknown table");
    return k;
  };

  const rowsOf = (t: PgTable, cond?: unknown) => {
    const k = key(t);
    selectedTables.push(k);
    if (failOnSelect === k) throw new Error("simulated crash mid-backfill");
    const all = store[k];
    return cond === undefined
      ? [...all]
      : all.filter((r) => evalCond(cond, r, t));
  };

  const thenable = (produce: () => any[]) => ({
    then: (res: (r: any[]) => unknown, rej?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(produce()).then(res, rej);
      } catch (e) {
        return rej ? Promise.resolve(rej(e)) : Promise.reject(e);
      }
    },
  });

  const handle: any = {
    execute: async (q: any) => {
      executed.push(
        (q?.queryChunks ?? []).map((c: any) => chunkText(c) ?? "").join("?")
      );
      return [];
    },

    select: (_proj?: unknown) => ({
      from: (t: PgTable) => {
        const base: any = thenable(() => rowsOf(t));
        base.where = (cond: unknown) => thenable(() => rowsOf(t, cond));
        base.orderBy = () => ({
          limit: (n: number) => thenable(() => rowsOf(t).slice(0, n)),
        });
        return base;
      },
    }),

    insert: (t: PgTable) => ({
      values: async (vals: any) => {
        const k = key(t);
        for (const v of Array.isArray(vals) ? vals : [vals]) {
          store[k].push({
            id: `row-${++idSeq}`,
            revokedAt: null,
            sourceProposalId: null,
            workspaceId: null,
            agentUserId: null,
            createdAt: new Date(idSeq),
            ...v,
          });
        }
      },
    }),

    update: (t: PgTable) => ({
      set: (patch: any) => ({
        where: async (cond: unknown) => {
          const k = key(t);
          for (const row of store[k]) {
            if (!evalCond(cond, row, t)) continue;
            for (const [prop, value] of Object.entries(patch)) {
              if (!isSql(value)) {
                row[prop] = value;
                continue;
              }
              // Mini `jsonb_set(col, '{path}', <json param>, true)` emulation,
              // driven by the ACTUAL emitted SQL: take the path literal out of
              // the string chunks and the object out of the bound param.
              const text = (value as any).queryChunks
                .map((c: any) => chunkText(c) ?? "")
                .join(" ");
              const path = /'\{([A-Za-z0-9_]+)\}'/.exec(text)?.[1];
              const jsonParam = (value as any).queryChunks
                .map(paramValue)
                .find((v: any) => typeof v === "string" && v.startsWith("{"));
              if (!path || !jsonParam) {
                throw new Error("fake db: unsupported jsonb update");
              }
              row[prop] = {
                ...(row[prop] ?? {}),
                [path]: JSON.parse(jsonParam),
              };
            }
          }
        },
      }),
    }),

    // Real mutex + snapshot/rollback: the stand-in for
    // `pg_advisory_xact_lock` + COMMIT/ROLLBACK.
    transaction: async (fn: (tx: any) => any) => {
      const release = await acquire();
      const snapshot: FakeStore = {
        governanceRules: store.governanceRules.map((r) => ({ ...r })),
        users: store.users.map((r) => ({ ...r })),
        workspaces: store.workspaces.map((r) => ({ ...r })),
        podSettings: store.podSettings.map((r) => ({
          ...r,
          settings: { ...r.settings },
        })),
      };
      try {
        return await fn(handle);
      } catch (err) {
        store.governanceRules = snapshot.governanceRules;
        store.users = snapshot.users;
        store.workspaces = snapshot.workspaces;
        store.podSettings = snapshot.podSettings;
        throw err;
      } finally {
        release();
      }
    },
  };

  let chain: Promise<void> = Promise.resolve();
  function acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const wait = chain;
    chain = chain.then(() => next);
    return wait.then(() => release);
  }

  return {
    db: handle,
    store,
    executed,
    selectedTables,
    resetProbes: () => {
      selectedTables.length = 0;
      executed.length = 0;
    },
    setFailOnSelect: (k: keyof FakeStore | null) => {
      failOnSelect = k;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "agent-1";
const WS_ID = "ws-1";

/** An agent whose legacy JSONB widening list is `patterns`. */
const agentRow = (patterns: string[]) => ({
  id: AGENT_ID,
  userType: "agent",
  agentMetadata: { autoApproveFor: patterns },
});

const workspaceRow = (patterns: string[]) => ({
  id: WS_ID,
  settings: { aiGovernance: { autoApproveFor: patterns } },
});

const agentRulePatterns = (store: FakeStore) =>
  store.governanceRules
    .filter((r) => r.principalKind === "agent")
    .map((r) => r.targetPattern);

const converged = (store: FakeStore) =>
  store.podSettings[0]?.settings?.governanceRulesBackfill?.convergedAt;

beforeEach(() => {
  MUTABLE_FLOOR.length = 0;
  MUTABLE_FLOOR.push(...REAL_FLOOR);
});

// ---------------------------------------------------------------------------

describe("backfillGovernanceRules — first run on a never-converged pod", () => {
  it("seeds the genuine widenings and stamps the converged marker", async () => {
    const f = makeFakeDb({
      users: [agentRow(["channel.create", "entity.create"])],
      workspaces: [workspaceRow(["playbook.create"])],
    });

    const result = await backfillGovernanceRules(f.db);

    expect(result.skipped).toBe(false);
    // `entity.create` is floor-covered → NOT seeded. `channel.create` is not.
    expect(result.agentRulesInserted).toBe(1);
    expect(result.workspaceRulesInserted).toBe(1);
    expect(agentRulePatterns(f.store)).toEqual(["channel.create"]);
    expect(f.store.governanceRules).toHaveLength(2);
    expect(converged(f.store)).toEqual(expect.any(String));
    // The advisory lock really is taken.
    expect(f.executed.join(" ")).toContain("pg_advisory_xact_lock");
  });

  it("merges the marker into an EXISTING pod_settings row without clobbering siblings", async () => {
    const f = makeFakeDb({
      users: [agentRow(["channel.create"])],
      podSettings: [
        { id: "pod-1", settings: { catalogSyncStamps: { "a::b": 1 } } },
      ],
    });

    await backfillGovernanceRules(f.db);

    expect(converged(f.store)).toEqual(expect.any(String));
    expect(f.store.podSettings[0].settings.catalogSyncStamps).toEqual({
      "a::b": 1,
    });
    expect(f.store.podSettings).toHaveLength(1);
  });
});

describe("backfillGovernanceRules — second boot after convergence", () => {
  it("does not read the legacy JSONB and inserts nothing", async () => {
    const f = makeFakeDb({
      users: [agentRow(["channel.create"])],
      workspaces: [workspaceRow(["playbook.create"])],
    });

    await backfillGovernanceRules(f.db);
    const afterFirst = f.store.governanceRules.length;
    f.resetProbes();

    const second = await backfillGovernanceRules(f.db);

    expect(second.skipped).toBe(true);
    expect(second.agentRulesInserted).toBe(0);
    expect(second.workspaceRulesInserted).toBe(0);
    expect(f.store.governanceRules).toHaveLength(afterFirst);
    // The whole point: the stale JSONB sources were never touched.
    expect(f.selectedTables).not.toContain("users");
    expect(f.selectedTables).not.toContain("workspaces");
  });
});

describe("🔴 REGRESSION — a tightened floor stays tightened", () => {
  it("does NOT re-grant an action REMOVED from DEFAULT_AUTO_APPROVE after convergence", async () => {
    // Boot 1: the floor still contains `profile.create` (pre-`d2e4a549`), so the
    // agent's legacy JSONB entry is floor-covered and correctly seeds NO rule.
    MUTABLE_FLOOR.push("profile.create");
    const f = makeFakeDb({ users: [agentRow(["profile.create"])] });

    const first = await backfillGovernanceRules(f.db);
    expect(first.skipped).toBe(false);
    expect(agentRulePatterns(f.store)).toEqual([]);

    // `d2e4a549`: the action is REMOVED from the code floor (a tightening).
    MUTABLE_FLOOR.splice(MUTABLE_FLOOR.indexOf("profile.create"), 1);

    // Boot 2 must NOT mint a pod-wide auto rule that hands it straight back.
    const second = await backfillGovernanceRules(f.db);

    expect(second.skipped).toBe(true);
    expect(agentRulePatterns(f.store)).toEqual([]);
    expect(f.store.governanceRules).toHaveLength(0);
  });
});

describe("backfillGovernanceRules — a partial run never marks converged", () => {
  it("rolls back and retries on the next boot", async () => {
    const f = makeFakeDb({
      users: [agentRow(["channel.create"])],
      workspaces: [workspaceRow(["playbook.create"])],
    });

    // Crash AFTER the workspace pass has already inserted a row.
    f.setFailOnSelect("users");
    await expect(backfillGovernanceRules(f.db)).rejects.toThrow(
      "simulated crash mid-backfill"
    );

    expect(converged(f.store)).toBeUndefined();
    expect(f.store.governanceRules).toHaveLength(0); // rolled back with the marker

    // Next boot: retries in full.
    f.setFailOnSelect(null);
    const retry = await backfillGovernanceRules(f.db);
    expect(retry.skipped).toBe(false);
    expect(retry.workspaceRulesInserted).toBe(1);
    expect(retry.agentRulesInserted).toBe(1);
    expect(converged(f.store)).toEqual(expect.any(String));
  });
});

describe("backfillGovernanceRules — two boots racing", () => {
  it("inserts each rule exactly once", async () => {
    const f = makeFakeDb({
      users: [agentRow(["channel.create"])],
      workspaces: [workspaceRow(["playbook.create"])],
    });

    const [a, b] = await Promise.all([
      backfillGovernanceRules(f.db),
      backfillGovernanceRules(f.db),
    ]);

    expect(f.store.governanceRules).toHaveLength(2);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
  });
});
