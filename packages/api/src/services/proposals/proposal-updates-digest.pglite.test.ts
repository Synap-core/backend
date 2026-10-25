/**
 * proposalUpdates (ticket 437d7370) — driven through the REAL query on the REAL
 * `proposals` table (PGlite), then through the adapter's real merge.
 *
 * Pinned: only THIS agent's decided proposals (approved / rejected /
 * approval_failed, with the reason), only those decided since its last call,
 * bounded at 10 with the remainder delivered on the next call (never dropped),
 * one cursor per session, and a failed read that moves no cursor.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    failNext: false,
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
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = (await h.init()) as { select: (...a: unknown[]) => unknown };
  // A db whose `select` can be told to fail once — the failed-read case.
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "select" && h.failNext) {
        h.failNext = false;
        return () => {
          throw new Error("connection reset");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, db, getDb: async () => db };
});

import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import {
  PROPOSAL_UPDATES_MAX,
  resetProposalUpdateCursors,
  takeProposalUpdates,
} from "./proposal-updates-digest.js";

const AGENT = randomUUID();
const OTHER = randomUUID();
const T0 = new Date("2026-10-25T17:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<unknown>;

async function proposal(opts: {
  agent?: string;
  status: string;
  reviewedAt: Date | null;
  reason?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, target_type, target_id, proposal_type, status, agent_user_id, reviewed_at, rejection_reason, data)
     values ($1,'profile',$2,'create',$3,$4,$5,$6,'{}'::jsonb)`,
    [
      id,
      randomUUID(),
      opts.status,
      opts.agent ?? AGENT,
      opts.reviewedAt?.toISOString() ?? null,
      opts.reason ?? null,
    ]
  );
  return id;
}

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(pgliteSchemaDdl([s.proposals!]));
});

beforeEach(async () => {
  await q("delete from proposals");
  resetProposalUpdateCursors();
});

describe("takeProposalUpdates", () => {
  it("reports this agent's decisions since its last call, with the reason, once", async () => {
    // First call establishes the cursor at T0 (nothing decided yet).
    expect(await takeProposalUpdates(AGENT, "s1", T0)).toEqual([]);

    const approved = await proposal({ status: "approved", reviewedAt: at(1) });
    const failed = await proposal({
      status: "approval_failed",
      reviewedAt: at(2),
      reason: "callProvider failed: Hub API error: 401 Unauthorized",
    });
    const rejected = await proposal({
      status: "rejected",
      reviewedAt: at(3),
      reason: "Not this kind",
    });
    // Not reported: still pending, another agent's, decided before the cursor.
    await proposal({ status: "pending", reviewedAt: null });
    await proposal({ agent: OTHER, status: "approved", reviewedAt: at(1) });
    await proposal({ status: "approved", reviewedAt: at(-5) });

    const updates = await takeProposalUpdates(AGENT, "s1", at(4));
    expect(updates!.map((u) => [u.id, u.status])).toEqual([
      [approved, "approved"],
      [failed, "approval_failed"],
      [rejected, "rejected"],
    ]);
    expect(updates![0]).not.toHaveProperty("reason");
    expect(updates![1]!.reason).toContain("401 Unauthorized");
    expect(updates![2]!.reason).toBe("Not this kind");
    expect(updates![0]!.change).toBe("profile/create");
    expect(updates![0]!.reviewUrl).toContain(approved);

    // Told once: the next call has nothing new.
    expect(await takeProposalUpdates(AGENT, "s1", at(5))).toEqual([]);
  });

  it("is bounded, and the remainder arrives on the next call instead of being dropped", async () => {
    await takeProposalUpdates(AGENT, "s1", T0);
    const ids: string[] = [];
    for (let i = 1; i <= PROPOSAL_UPDATES_MAX + 3; i += 1) {
      ids.push(await proposal({ status: "approved", reviewedAt: at(i) }));
    }
    const first = await takeProposalUpdates(AGENT, "s1", at(30));
    expect(first).toHaveLength(PROPOSAL_UPDATES_MAX);
    const second = await takeProposalUpdates(AGENT, "s1", at(31));
    expect([...first!, ...second!].map((u) => u.id)).toEqual(ids);
  });

  it("keeps one cursor per session of the same agent", async () => {
    await takeProposalUpdates(AGENT, "s1", T0);
    await takeProposalUpdates(AGENT, "s2", T0);
    const id = await proposal({ status: "approved", reviewedAt: at(1) });
    expect(
      (await takeProposalUpdates(AGENT, "s1", at(2)))!.map((u) => u.id)
    ).toEqual([id]);
    expect(
      (await takeProposalUpdates(AGENT, "s2", at(2)))!.map((u) => u.id)
    ).toEqual([id]);
  });

  it("a failed read returns null and moves no cursor", async () => {
    await takeProposalUpdates(AGENT, "s1", T0);
    const id = await proposal({ status: "approved", reviewedAt: at(1) });
    h.failNext = true;
    expect(await takeProposalUpdates(AGENT, "s1", at(2))).toBeNull();
    expect(
      (await takeProposalUpdates(AGENT, "s1", at(3)))!.map((u) => u.id)
    ).toEqual([id]);
  });
});
