/**
 * Box runs on PGlite, through the real migration (0356) and the real service:
 * the queue, the lease and the evidence a computer reports.
 *
 * Rows chosen to rule out a wrong rule:
 *   - two computers of the same person lease at once: exactly ONE gets the run
 *     (a lease that only checked status in its pick would hand it to both);
 *   - a LEASED run whose lease expired is re-leased (attempt 2) and the first
 *     lease's heartbeat is refused — re-lease without a fresh lease id would
 *     let the dead provisioner keep writing;
 *   - a RUNNING run whose lease expired is NOT re-leased (the script may have
 *     had side effects), reads `stalled`, and is failed as INFRA past grace;
 *   - finish by a computer that does not hold the lease is refused, and a
 *     second finish on the same lease is refused (single-shot);
 *   - a computer never sees another person's queue;
 *   - FIFO by queued_at.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  proven: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../capabilities/execute-capability.js", () => ({
  markSkillProven: async (id: string) => {
    h.proven.push(id);
  },
}));

import {
  enqueueBoxRun,
  finishBoxRun,
  heartbeatBoxRun,
  leaseBoxRun,
  stopBoxRun,
  boxRunReadStatus,
  type BoxRunner,
} from "./box-runs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0356 = readFileSync(
  resolve(HERE, "../../../../database/migrations/0356_box_runs.sql"),
  "utf8"
);

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const OTHER_PERSON = "person-b";
const MACHINE_1: BoxRunner = {
  machineUserId: "machine-1",
  ownerUserId: PERSON,
};
const MACHINE_2: BoxRunner = {
  machineUserId: "machine-2",
  ownerUserId: PERSON,
};
const STRANGER: BoxRunner = {
  machineUserId: "machine-x",
  ownerUserId: OTHER_PERSON,
};
const SKILL = randomUUID();

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TABLE skills (id uuid PRIMARY KEY, name text NOT NULL, code text,
      metadata jsonb DEFAULT '{}'::jsonb, proven_at timestamptz);
  `);
  await h.client!.exec(M0356);
  await q(
    `INSERT INTO skills (id, name, code, metadata) VALUES ($1, $2, $3, $4)`,
    [
      SKILL,
      "chart_csv",
      "import pandas\nprint('hi')",
      JSON.stringify({
        box: {
          language: "python",
          packages: [{ name: "pandas", version: "2.2.3" }],
          hosts: ["API.Example.com"],
        },
      }),
    ]
  );
}, 60_000);

beforeEach(async () => {
  await q(`DELETE FROM box_runs`);
  h.proven = [];
});

async function queue(userId = PERSON) {
  const out = await enqueueBoxRun({
    skillId: SKILL,
    parameters: { csv: "a,b" },
    userId,
    agentUserId: "agent-1",
  });
  if (!out.ok) throw new Error(out.error);
  return out.run;
}

async function expireLease(id: string, secondsAgo: number) {
  await q(
    `UPDATE box_runs SET lease_expires_at = now() - ($2 || ' seconds')::interval WHERE id = $1`,
    [id, String(secondsAgo)]
  );
}

describe("enqueue", () => {
  it("snapshots the approved script, normalised, and hands back a queued handle", async () => {
    const out = await enqueueBoxRun({
      skillId: SKILL,
      parameters: undefined,
      userId: PERSON,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result).toMatchObject({
      status: "queued",
      boxRunId: out.run.id,
    });
    expect(out.run.status).toBe("queued");
    expect(out.run.spec).toMatchObject({
      name: "chart_csv",
      language: "python",
      entrypoint: "main.py",
      code: "import pandas\nprint('hi')",
      packages: [{ name: "pandas", version: "2.2.3" }],
      hosts: ["api.example.com"],
      limits: { wallSeconds: 900, cpus: 2, memoryMb: 2048 },
    });
    // An edit after queueing never changes what the queued run executes.
    await q(`UPDATE skills SET code = 'evil()' WHERE id = $1`, [SKILL]);
    const leased = await leaseBoxRun(MACHINE_1);
    expect(leased?.script.code).toBe("import pandas\nprint('hi')");
    await q(`UPDATE skills SET code = $2 WHERE id = $1`, [
      SKILL,
      "import pandas\nprint('hi')",
    ]);
  });

  it("refuses a skill with no valid box declaration", async () => {
    const bad = randomUUID();
    await q(
      `INSERT INTO skills (id, name, code, metadata) VALUES ($1, 'x', 'print(1)', '{}')`,
      [bad]
    );
    const out = await enqueueBoxRun({
      skillId: bad,
      parameters: {},
      userId: PERSON,
    });
    expect(out).toMatchObject({ ok: false });
  });
});

describe("lease", () => {
  it("is FIFO and floors on the computer's own person", async () => {
    const first = await queue();
    await new Promise((r) => setTimeout(r, 5));
    const second = await queue();
    await queue(OTHER_PERSON);
    expect(await leaseBoxRun(STRANGER)).toMatchObject({ attempt: 1 });
    const a = await leaseBoxRun(MACHINE_1);
    // One lease takes ONE run, never the queue.
    const leased = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM box_runs WHERE user_id = $1 AND status = 'leased'`,
      [PERSON]
    );
    expect(leased.rows[0].n).toBe(1);
    const b = await leaseBoxRun(MACHINE_1);
    expect(a?.id).toBe(first.id);
    expect(b?.id).toBe(second.id);
    expect(await leaseBoxRun(MACHINE_1)).toBeNull();
    expect(a?.heartbeatIntervalSeconds).toBe(30);
    expect(a?.parameters).toEqual({ csv: "a,b" });
  });

  it("two computers lease at once: exactly one wins", async () => {
    const run = await queue();
    const [x, y] = await Promise.all([
      leaseBoxRun(MACHINE_1),
      leaseBoxRun(MACHINE_2),
    ]);
    const winners = [x, y].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(run.id);
    const [row] = (
      await q<{ attempt: number }>(
        `SELECT attempt FROM box_runs WHERE id = $1`,
        [run.id]
      )
    ).rows;
    expect(row.attempt).toBe(1);
  });

  it("an expired LEASED run is re-leasable; the old lease is then refused", async () => {
    const run = await queue();
    const first = await leaseBoxRun(MACHINE_1);
    expect(await leaseBoxRun(MACHINE_2)).toBeNull(); // live lease holds
    await expireLease(run.id, 5);
    const second = await leaseBoxRun(MACHINE_2);
    expect(second).toMatchObject({ id: run.id, attempt: 2 });
    expect(second!.leaseId).not.toBe(first!.leaseId);
    const stale = await heartbeatBoxRun({
      runId: run.id,
      leaseId: first!.leaseId,
      phase: "setup",
      runner: MACHINE_1,
    });
    expect(stale).toEqual({ ok: false, code: "LEASE_LOST" });
  });

  it("an expired RUNNING run is never re-leased: stalled, then failed as INFRA past grace", async () => {
    const run = await queue();
    const lease = await leaseBoxRun(MACHINE_1);
    const hb = await heartbeatBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      phase: "running",
      runner: MACHINE_1,
    });
    expect(hb).toMatchObject({ ok: true, stopRequested: false });
    await expireLease(run.id, 10);
    expect(await leaseBoxRun(MACHINE_2)).toBeNull();
    const [row] = (
      await q<{ status: "running"; lease_expires_at: Date }>(
        `SELECT status, lease_expires_at FROM box_runs WHERE id = $1`,
        [run.id]
      )
    ).rows;
    expect(
      boxRunReadStatus({
        status: row.status,
        leaseExpiresAt: new Date(row.lease_expires_at),
      })
    ).toBe("stalled");
    await expireLease(run.id, 600);
    expect(await leaseBoxRun(MACHINE_2)).toBeNull();
    const [after] = (
      await q<{
        status: string;
        evidence: { verdict: string; infraReason: string };
      }>(`SELECT status, evidence FROM box_runs WHERE id = $1`, [run.id])
    ).rows;
    expect(after.status).toBe("failed");
    expect(after.evidence).toMatchObject({
      verdict: "infra",
      infraReason: "heartbeat lost",
    });
  });
});

describe("finish", () => {
  it("is refused for a computer that does not hold the lease, and is single-shot", async () => {
    const run = await queue();
    const lease = await leaseBoxRun(MACHINE_1);
    const evidence = {
      verdict: "done" as const,
      exitCode: 0,
      durationMs: 1200,
      log: { head: "hi\n", tail: "", totalBytes: 3, truncated: false },
    };
    const byOther = await finishBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      runner: MACHINE_2,
      ...evidence,
    });
    expect(byOther).toEqual({ ok: false, code: "LEASE_LOST" });
    const byStranger = await finishBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      runner: STRANGER,
      ...evidence,
    });
    expect(byStranger).toEqual({ ok: false, code: "NOT_FOUND" });
    const done = await finishBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      runner: MACHINE_1,
      ...evidence,
      blockedEgress: [
        {
          host: "10.10.0.10",
          port: 4000,
          phase: "run",
          reason: "not declared",
        },
      ],
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.run.status).toBe("done");
    expect(done.run.evidence).toMatchObject({
      verdict: "done",
      exitCode: 0,
      log: { head: "hi\n" },
      blockedEgress: [{ host: "10.10.0.10", port: 4000 }],
    });
    expect(h.proven).toEqual([SKILL]);
    const again = await finishBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      runner: MACHINE_1,
      ...evidence,
    });
    expect(again).toEqual({ ok: false, code: "LEASE_LOST" });
  });

  it("stores timeout/infra as failed with the verdict kept, and caps the log", async () => {
    const run = await queue();
    const lease = await leaseBoxRun(MACHINE_1);
    const out = await finishBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      runner: MACHINE_1,
      verdict: "infra",
      infraReason: "clone failed",
      exitCode: null,
      durationMs: null,
      log: { head: "x".repeat(70 * 1024) },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.run.status).toBe("failed");
    expect(out.run.error).toMatch(/clone failed/);
    expect(out.run.evidence?.log.head.length).toBe(64 * 1024);
    expect(out.run.evidence?.log.truncated).toBe(true);
    expect(h.proven).toEqual([]);
  });
});

describe("stop", () => {
  it("stops a queued run at once, and tells a running one through its heartbeat", async () => {
    const queued = await queue();
    expect(await stopBoxRun({ runId: queued.id, userId: OTHER_PERSON })).toBe(
      "not_found"
    );
    expect(await stopBoxRun({ runId: queued.id, userId: PERSON })).toBe(
      "stopped"
    );
    expect(await leaseBoxRun(MACHINE_1)).toBeNull();

    const run = await queue();
    const lease = await leaseBoxRun(MACHINE_1);
    expect(await stopBoxRun({ runId: run.id, userId: PERSON })).toBe(
      "stop_requested"
    );
    const hb = await heartbeatBoxRun({
      runId: run.id,
      leaseId: lease!.leaseId,
      phase: "running",
      runner: MACHINE_1,
    });
    expect(hb).toMatchObject({ ok: true, stopRequested: true });
  });
});
