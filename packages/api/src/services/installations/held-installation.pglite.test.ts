/**
 * An installation a lifecycle job left in `installing`, `updating` or
 * `removing` heals by itself (finding 36daa4e2). The founder's media-matte
 * was installed and checked on the Mac, but the pod refused the job's finish;
 * the clock later failed the JOB and never touched the installation, so it
 * stayed `installing` for good: the reconciler skips that status, and a
 * person's ask queued nothing (`approved`, jobId null).
 *
 * On PGlite through the real services (lease, finish, reconcile, the ask),
 * with the partial unique index of 0409 that keeps ONE open lifecycle job
 * per installation:
 *   1. a lifecycle job the clock closes (stalled, never started, stopped)
 *      moves its installation to `failed` with the true reason;
 *   2. the reconciler releases a held status with no job open (a row stuck
 *      before 1 existed), then checks it and repairs it; a running job's
 *      installation is never touched, and a second open job is a no-op;
 *   3. a person's ask on a stuck row queues the check now, past the ladder.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tryAgain: [] as string[],
  gate: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

// The "try again" card's own producer is pinned in installations.pglite.test;
// here: whether a closed job reaches it.
vi.mock("./self-heal-notice.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    askToTryAgainIfStopped: async (installationId: string) => {
      h.tryAgain.push(installationId);
      return false;
    },
  };
});

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gate.push(opts);
      return { granted: true };
    },
  };
});

import { finishHostJob, leaseHostJob } from "../host-jobs/host-jobs.js";
import {
  loadPersonsComputer,
  reconcileComputer,
  reconcileInstallation,
} from "./installations.js";
import { requestInstallation } from "./request-installation.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import type { InstallationRow } from "@synap/database/schema";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const MAC = "machine-mac";
const KEY = "media-matte";
const CAP = randomUUID();
const runner = { machineUserId: MAC, ownerUserId: PERSON };

const TOOL = {
  placement: {
    runsOn: ["computer"],
    platforms: [{ os: "darwin", arch: ["arm64"] }],
  },
  install: {
    darwin: {
      steps: [{ kind: "uv", action: "tool-install", package: "matte" }],
    },
  },
  verify: {
    darwin: { command: ["synap-matte", "--version"], expect: { exitCode: 0 } },
  },
  licence: "MIT",
  recipes: [],
};

/** A live installation of the tool on the Mac, approved, in `status`. */
async function installation(status: string, detail?: string): Promise<string> {
  await q(`DELETE FROM host_jobs`);
  await q(`DELETE FROM installations`);
  const id = randomUUID();
  await q(
    `INSERT INTO installations (id, user_id, kind, capability_id, capability_key, machine_user_id, status, status_detail,
       desired_state, approved_at, approved_by, manifest)
     VALUES ($1, $2, 'tool', $3, $4, $5, $6, $7, 'installed', now() - interval '1 day', $2, $8::jsonb)`,
    [id, PERSON, CAP, KEY, MAC, status, detail ?? null, JSON.stringify(TOOL)]
  );
  return id;
}

/** A job of the installation, as the queue holds it. */
async function job(
  installationId: string,
  kind: string,
  status: string,
  extra: {
    attempt?: number;
    leaseExpiresSql?: string;
    finishedSql?: string;
    stopRequested?: boolean;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO host_jobs (id, kind, installation_id, user_id, machine_user_id, spec, parameters, status, attempt,
       lease_id, leased_by, lease_expires_at, stop_requested_at, queued_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{}'::jsonb, $6, $7,
       CASE WHEN $6 IN ('leased','running') THEN gen_random_uuid() END,
       CASE WHEN $6 IN ('leased','running') THEN $5 END,
       ${extra.leaseExpiresSql ?? "NULL"},
       ${extra.stopRequested ? "now() - interval '10 minutes'" : "NULL"},
       now() - interval '1 hour',
       ${extra.finishedSql ?? "NULL"})`,
    [id, kind, installationId, PERSON, MAC, status, extra.attempt ?? 1]
  );
  return id;
}

async function row(id: string) {
  return (
    await q<{ status: string; status_detail: string | null }>(
      `SELECT status, status_detail FROM installations WHERE id = $1`,
      [id]
    )
  ).rows[0]!;
}

async function openJobs(id: string) {
  return (
    await q<{ id: string; kind: string }>(
      `SELECT id, kind FROM host_jobs WHERE installation_id = $1 AND status IN ('queued','leased','running')`,
      [id]
    )
  ).rows;
}

async function full(id: string): Promise<InstallationRow> {
  const { db } = await import("@synap/database");
  const { installations } = await import("@synap/database/schema");
  const { eq } = await import("drizzle-orm");
  const [r] = await db
    .select()
    .from(installations)
    .where(eq(installations.id, id));
  return r as InstallationRow;
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  // The derived DDL carries no index: the two partial uniques this model
  // rests on (0409) are added from the migration itself.
  const m0409 = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../database/migrations/0409_installations.sql"
    ),
    "utf8"
  );
  const uniques = m0409.match(/CREATE UNIQUE INDEX IF NOT EXISTS[^;]+;/g) ?? [];
  expect(uniques).toHaveLength(2);
  for (const ddl of uniques) await h.client!.exec(ddl);
  await q(
    `INSERT INTO users (id, email, name, user_type, agent_type, created_by_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', 'human', NULL, NULL, '{}'::jsonb),
      ($2, 'm@x', 'MacBook-Pro', 'agent', 'machine', $1, $3::jsonb)`,
    [
      PERSON,
      MAC,
      JSON.stringify({
        platform: "darwin",
        arch: "arm64",
        hostsServices: true,
      }),
    ]
  );
  await q(
    `INSERT INTO capabilities (id, created_by, name, template_key, metadata)
     VALUES ($1, $2, 'Matte', $3, $4::jsonb)`,
    [CAP, PERSON, KEY, JSON.stringify({ computer: TOOL })]
  );
}, 60_000);

beforeEach(() => {
  h.tryAgain.length = 0;
  h.gate.length = 0;
});

describe("1. a lifecycle job the clock closes releases its installation", () => {
  it("an install whose computer stopped answering: failed, with the reason, and the ladder's card door asked", async () => {
    const inst = await installation("installing");
    const dead = await job(inst, "install", "running", {
      leaseExpiresSql: "now() - interval '1 hour'",
    });
    expect(await leaseHostJob(runner)).toBeNull();
    const closed = await q<{ status: string }>(
      `SELECT status FROM host_jobs WHERE id = $1`,
      [dead]
    );
    expect(closed.rows[0]!.status).toBe("failed");
    expect(await row(inst)).toEqual({
      status: "failed",
      status_detail:
        "The install did not finish: the computer stopped answering while it ran.",
    });
    expect(h.tryAgain).toEqual([inst]);
  });

  it("an update that stalled is failed too, never left updating", async () => {
    const inst = await installation("updating");
    await job(inst, "update", "running", {
      leaseExpiresSql: "now() - interval '1 hour'",
    });
    await leaseHostJob(runner);
    expect(await row(inst)).toEqual({
      status: "failed",
      status_detail:
        "The update did not finish: the computer stopped answering while it ran.",
    });
  });

  it("an install the computer never picked up, and one a person stopped", async () => {
    const unstarted = await installation("installing");
    await job(unstarted, "install", "leased", {
      attempt: 3,
      leaseExpiresSql: "now() - interval '1 minute'",
    });
    await leaseHostJob(runner);
    expect(await row(unstarted)).toEqual({
      status: "failed",
      status_detail:
        "The install did not start: the computer never picked it up.",
    });

    const stopped = await installation("installing");
    await job(stopped, "install", "leased", {
      leaseExpiresSql: "now() - interval '1 minute'",
      stopRequested: true,
    });
    h.tryAgain.length = 0;
    await leaseHostJob(runner);
    expect(await row(stopped)).toEqual({
      status: "failed",
      status_detail: "The install was stopped.",
    });
    // A person's stop is their call: no card, and nothing runs by itself.
    expect(h.tryAgain).toEqual([]);
    await reconcileComputer(runner);
    expect(await openJobs(stopped)).toEqual([]);
  });

  it("a verify the clock closes moves no lifecycle", async () => {
    const inst = await installation("installed");
    await job(inst, "verify", "running", {
      leaseExpiresSql: "now() - interval '1 hour'",
    });
    await leaseHostJob(runner);
    expect((await row(inst)).status).toBe("installed");
  });
});

describe("2. the reconciler releases a held status no job will finish", () => {
  it("finding 36daa4e2: installing, its job long failed, nothing open → failed, checked, recorded installed", async () => {
    const inst = await installation("installing", "needs 3.0 GB free");
    await job(inst, "install", "failed", {
      finishedSql: "now() - interval '2 hours'",
    });
    await reconcileComputer(runner);
    expect(await row(inst)).toEqual({
      status: "failed",
      status_detail: "The install ended without its result reaching the pod.",
    });
    // A check first: the tool may well be there.
    expect((await openJobs(inst)).map((j) => j.kind)).toEqual(["verify"]);
    const leased = (await leaseHostJob(runner))!;
    expect(leased.kind).toBe("verify");
    const fin = await finishHostJob({
      jobId: leased.id,
      leaseId: leased.leaseId,
      runner,
      verdict: "done",
      durationMs: 900,
      observed: { observedVersion: "0.1.0", verify: { ok: true, exitCode: 0 } },
    });
    expect(fin).toMatchObject({ ok: true, installationStatus: "installed" });
    expect(await row(inst)).toEqual({
      status: "installed",
      status_detail: null,
    });
  });

  it("an updating and a removing with nothing open are released the same way", async () => {
    const upd = await installation("updating");
    await reconcileComputer(runner);
    expect((await row(upd)).status).toBe("failed");
    expect((await openJobs(upd)).map((j) => j.kind)).toEqual(["verify"]);

    const rem = await installation("removing");
    await q(
      `UPDATE installations SET desired_state = 'removed' WHERE id = $1`,
      [rem]
    );
    await reconcileComputer(runner);
    expect((await row(rem)).status).toBe("failed");
    expect((await openJobs(rem)).map((j) => j.kind)).toEqual(["remove"]);
  });

  it("a running install is never released, and a second open job is a no-op", async () => {
    const inst = await installation("installing");
    const running = await job(inst, "install", "running", {
      leaseExpiresSql: "now() + interval '2 minutes'",
    });
    await reconcileComputer(runner);
    // Past the lease-time filter, straight at the door: still nothing moves.
    expect(await reconcileInstallation(await full(inst))).toBeNull();
    expect(
      await reconcileInstallation(await full(inst), { kind: "verify" })
    ).toBeNull();
    expect((await row(inst)).status).toBe("installing");
    expect(await openJobs(inst)).toEqual([{ id: running, kind: "install" }]);
  });

  it("a finish that lands after a release still records what the job did", async () => {
    const inst = await installation("planned");
    await q(
      `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec, parameters, queued_at)
       VALUES ('install', $1, $2, $3, '{}'::jsonb, '{}'::jsonb, now() - interval '1 hour')`,
      [inst, PERSON, MAC]
    );
    const leased = (await leaseHostJob(runner))!;
    expect((await row(inst)).status).toBe("installing");
    // The release met the job between its close and its move (the one window).
    await q(`UPDATE installations SET status = 'failed' WHERE id = $1`, [inst]);
    const fin = await finishHostJob({
      jobId: leased.id,
      leaseId: leased.leaseId,
      runner,
      verdict: "done",
      durationMs: 1000,
    });
    expect(fin).toMatchObject({ ok: true, installationStatus: "installed" });
  });
});

describe("3. a person's ask on a stuck installation", () => {
  it("queues the check now, past the ladder's back-off (was: approved, jobId null)", async () => {
    const inst = await installation("installing", "needs 3.0 GB free");
    // Its job failed seconds ago: the ladder alone would wait a minute
    // (released to failed, nothing queued), so only the ask's own hint runs it.
    await job(inst, "install", "failed", {
      finishedSql: "now() - interval '5 seconds'",
    });
    const computer = (await loadPersonsComputer(PERSON, MAC))!;
    const ask = await requestInstallation({
      userId: PERSON,
      agentUserId: null,
      computer,
      capabilityKey: KEY,
      action: "install",
    });
    expect(ask).toMatchObject({ status: "approved", installationId: inst });
    const open = await openJobs(inst);
    expect(open.map((j) => j.kind)).toEqual(["verify"]);
    expect((ask as { jobId: string | null }).jobId).toBe(open[0]!.id);
    // A repair asks nobody: approval is once per (capability, computer).
    expect(h.gate).toEqual([]);
    // Asked again while the check is open: the one open job stays the one.
    const again = await requestInstallation({
      userId: PERSON,
      agentUserId: null,
      computer,
      capabilityKey: KEY,
      action: "install",
    });
    expect(again).toMatchObject({ status: "approved", jobId: null });
    expect(await openJobs(inst)).toHaveLength(1);
  });
});
