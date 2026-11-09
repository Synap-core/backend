/**
 * The host-jobs Hub routes (0409, plan 64072312 U7), driven on PGlite through
 * the real routes and the real service. The auth middleware is replaced by one
 * that sets what `hubAuthMiddleware` sets for a key (scopes, the linked person
 * as `userId`, the key's agent as `agentUserId`), so each case is one key:
 *
 *   - a computer key without `host.runner` (even holding `box.runner`) → 403;
 *   - an agent key, or the person's own key, holding the scope → 403;
 *   - a computer acting for another person → 403;
 *   - an agent HOSTED on the computer (`host_user_id`), even holding the
 *     scope and the live lease id → 403 on lease, report and finish, and the
 *     installation's observed state is untouched (no forged "installed");
 *   - the computer's own key → it leases ONLY the jobs of installations on
 *     itself (not a sibling computer's, not a job whose copied computer id
 *     points at it while its installation lives elsewhere), heartbeats,
 *     reports and finishes, and the installation moves with it (lifecycle
 *     only: health is derived at read time, never stored);
 *   - a tool's verify job stores what the runner observed (version, os, arch,
 *     verify, masked) and moves no lifecycle; a failed verify reads failed;
 *     an install job on an installed tool is a repair (installed → installing);
 *     a verify that passes on a FAILED tool makes it installed (self-heal);
 *     every failed lifecycle finish asks the self-heal card door, which sends
 *     ONE card when that failure reaches the cap (its own test:
 *     installations.pglite.test.ts).
 *
 * Logs: never sent unasked; a person's request turns `logsRequested` on, the
 * report carrying the log turns it off, and the stored log is scrubbed of
 * secrets. `GET /:id/logs` is the owner's, through the access layer.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  stoppedChecks: [] as string[],
}));

vi.mock("../../../services/installations/self-heal-notice.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    notifyIfSelfHealStopped: async (installationId: string) => {
      h.stoppedChecks.push(installationId);
      return false;
    },
  };
});

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

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerHostJobsRoutes } from "./host-jobs.js";
import {
  installationHealth,
  hostJobReadStatus,
  isoDurationSeconds,
  requestHostJobLogs,
  INSTALLATION_REPORT_WINDOW_SECONDS,
  TOOL_REVERIFY_DEFAULT_SECONDS,
} from "../../../services/host-jobs/host-jobs.js";
import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import type { HubHono, HubVariables } from "./_shared.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const OTHER = "person-b";
const DEVBOX = "machine-devbox";
const MAC = "machine-mac";
const AGENT = "agent-1";
/** Claude Code running ON the devbox (`users.host_user_id` = the devbox). */
const HOSTED = "agent-on-devbox";
const INST = randomUUID();
const INST_MAC = randomUUID();
const INST_MAC_2 = randomUUID();
const INST_TOOL = randomUUID();
const JOB_INSTALL = randomUUID();
const JOB_MAC = randomUUID();
const JOB_FORGED = randomUUID();

const BASE = ["hub-protocol.read", "hub-protocol.write"];
const RUNNER = [...BASE, "host.runner"];

function appAs(vars: {
  scopes: string[];
  userId: string;
  agentUserId?: string;
}): HubHono {
  const app = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes);
    c.set("userId", vars.userId);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerHostJobsRoutes(app);
  return app;
}

const devbox = () =>
  appAs({ scopes: RUNNER, userId: PERSON, agentUserId: DEVBOX });

const post = (app: HubHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** The derived health of an installation row, as a read would answer it. */
async function readHealth(id: string) {
  const r = await q<Record<string, unknown>>(
    `SELECT kind, status, status_detail, health, last_report_at, installed_at,
            verified_at, observed_version, desired_version, manifest
     FROM installations WHERE id = $1`,
    [id]
  );
  const row = r.rows[0]!;
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  return installationHealth({
    kind: row.kind as "service" | "tool",
    status: row.status as "installed",
    statusDetail: (row.status_detail as string | null) ?? null,
    health: (row.health as never) ?? null,
    lastReportAt: date(row.last_report_at),
    installedAt: date(row.installed_at),
    verifiedAt: date(row.verified_at),
    observedVersion: (row.observed_version as string | null) ?? null,
    desiredVersion: (row.desired_version as string | null) ?? null,
    manifest: (row.manifest as Record<string, unknown>) ?? {},
  });
}

async function installationStatus(id: string): Promise<string> {
  const r = await q<{ status: string }>(
    `SELECT status FROM installations WHERE id = $1`,
    [id]
  );
  return r.rows[0]!.status;
}

type Leased = {
  id: string;
  kind: string;
  leaseId: string;
  installation: { id: string; manifest: unknown; digests: unknown };
};

async function lease(app: HubHono): Promise<Leased | null> {
  const res = await post(app, "/host-jobs/lease", {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { job: Leased | null }).job;
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id) VALUES
      ($1, 'a@x', 'person', NULL, NULL),
      ($2, 'b@x', 'other', NULL, NULL),
      ($3, 'd@x', 'devbox', 'machine', $1),
      ($4, 'm@x', 'mac', 'machine', $1),
      ($5, 'c@x', 'Claude Code', 'claude-code', $1)`,
    [PERSON, OTHER, DEVBOX, MAC, AGENT]
  );
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, host_user_id)
     VALUES ($1, 'h@x', 'Claude Code on the devbox', 'claude-code', $2, $3)`,
    [HOSTED, PERSON, DEVBOX]
  );
  await q(
    `INSERT INTO installations (id, user_id, kind, capability_key, machine_user_id, status, manifest, digests)
     VALUES ($1, $3, 'service', 'hyperframes', $4, 'planned', '{"services":[{"id":"render"}]}'::jsonb, '{"render":"sha256:aa"}'::jsonb),
            ($2, $3, 'service', 'hyperframes', $5, 'planned', '{}'::jsonb, '{}'::jsonb),
            ($6, $3, 'tool', 'media-ffmpeg', $5, 'planned', '{}'::jsonb, '{}'::jsonb)`,
    [INST, INST_MAC, PERSON, DEVBOX, MAC, INST_MAC_2]
  );
  // The devbox's own install job; the Mac's job; and a job whose COPIED
  // computer id says devbox while its installation lives on the Mac.
  await q(
    `INSERT INTO host_jobs (id, kind, installation_id, user_id, machine_user_id, spec, status, attempt, queued_at, parameters)
     VALUES ($1, 'install', $2, $5, $6, '{"op":"install"}'::jsonb, 'queued', 0, now() - interval '3 minutes', '{}'::jsonb),
            ($3, 'install', $4, $5, $7, '{}'::jsonb, 'queued', 0, now() - interval '2 minutes', '{}'::jsonb),
            ($8, 'install', $9, $5, $6, '{}'::jsonb, 'queued', 0, now() - interval '1 minute', '{}'::jsonb)`,
    [
      JOB_INSTALL,
      INST,
      JOB_MAC,
      INST_MAC,
      PERSON,
      DEVBOX,
      MAC,
      JOB_FORGED,
      INST_MAC_2,
    ]
  );
}, 60_000);

describe("host-jobs routes — who may call", () => {
  it("a computer key without host.runner is refused, even with box.runner", async () => {
    for (const scopes of [BASE, [...BASE, "box.runner"]]) {
      const res = await post(
        appAs({ scopes, userId: PERSON, agentUserId: DEVBOX }),
        "/host-jobs/lease",
        {}
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "SCOPE_REQUIRED" });
    }
  });

  it("an agent key or the person's own key holding the scope is not a computer", async () => {
    for (const app of [
      appAs({ scopes: RUNNER, userId: PERSON, agentUserId: AGENT }),
      appAs({ scopes: RUNNER, userId: PERSON }),
    ]) {
      const res = await post(app, "/host-jobs/lease", {});
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
    }
  });

  it("an agent hosted on the computer, holding the scope, is not the computer", async () => {
    const res = await post(
      appAs({ scopes: RUNNER, userId: PERSON, agentUserId: HOSTED }),
      "/host-jobs/lease",
      {}
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
  });

  it("a computer acting for another person is refused", async () => {
    const res = await post(
      appAs({ scopes: RUNNER, userId: OTHER, agentUserId: DEVBOX }),
      "/host-jobs/lease",
      {}
    );
    expect(res.status).toBe(403);
  });
});

describe("host-jobs routes — the computer's own work", () => {
  let job: Leased;

  it("leases only the jobs of installations on itself, and the install starts", async () => {
    const leased = await lease(devbox());
    expect(leased).not.toBeNull();
    job = leased!;
    expect(job).toMatchObject({
      id: JOB_INSTALL,
      kind: "install",
      installation: {
        id: INST,
        manifest: { services: [{ id: "render" }] },
        digests: { render: "sha256:aa" },
      },
    });
    expect(await installationStatus(INST)).toBe("installing");
    // Neither the Mac's job nor the forged one is the devbox's to take.
    expect(await lease(devbox())).toBeNull();
    const left = await q<{ id: string; status: string }>(
      `SELECT id, status FROM host_jobs WHERE id IN ($1, $2) ORDER BY id`,
      [JOB_MAC, JOB_FORGED]
    );
    expect(left.rows.every((r) => r.status === "queued")).toBe(true);
  });

  it("heartbeats; a stale lease is 409 and an unknown job 404", async () => {
    const hb = await post(devbox(), `/host-jobs/${job.id}/heartbeat`, {
      leaseId: job.leaseId,
      phase: "running",
    });
    expect(hb.status).toBe(200);
    expect(await hb.json()).toMatchObject({
      stopRequested: false,
      logsRequested: false,
    });
    const stale = await post(devbox(), `/host-jobs/${job.id}/heartbeat`, {
      leaseId: randomUUID(),
      phase: "running",
    });
    expect(stale.status).toBe(409);
    const unknown = await post(
      devbox(),
      `/host-jobs/${randomUUID()}/heartbeat`,
      { leaseId: job.leaseId, phase: "running" }
    );
    expect(unknown.status).toBe(404);
    // The Mac's job, seen from the devbox, does not exist.
    const mac = await post(devbox(), `/host-jobs/${JOB_MAC}/heartbeat`, {
      leaseId: job.leaseId,
      phase: "running",
    });
    expect(mac.status).toBe(404);
  });

  it("an agent hosted on the computer cannot report or finish its job, even with the lease id", async () => {
    const hosted = appAs({
      scopes: RUNNER,
      userId: PERSON,
      agentUserId: HOSTED,
    });
    const before = await q<Record<string, unknown>>(
      `SELECT status, observed_version, verified_at, health FROM installations WHERE id = $1`,
      [INST]
    );
    const computerBefore = await q<Record<string, unknown>>(
      `SELECT agent_metadata FROM users WHERE id = $1`,
      [DEVBOX]
    );
    const forged = {
      leaseId: job.leaseId,
      observedVersion: "9.9.9",
      os: "linux",
      arch: "x64",
      verify: { ok: true, exitCode: 0, excerpt: "all good" },
    };
    const report = await post(hosted, `/host-jobs/${job.id}/report`, forged);
    expect(report.status).toBe(403);
    expect(await report.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
    const finish = await post(hosted, `/host-jobs/${job.id}/finish`, {
      ...forged,
      status: "done",
    });
    expect(finish.status).toBe(403);
    expect(await finish.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
    const after = await q<Record<string, unknown>>(
      `SELECT status, observed_version, verified_at, health FROM installations WHERE id = $1`,
      [INST]
    );
    expect(after.rows).toEqual(before.rows);
    // Nor what the computer is: only its own key says that.
    expect(
      (
        await q<Record<string, unknown>>(
          `SELECT agent_metadata FROM users WHERE id = $1`,
          [DEVBOX]
        )
      ).rows
    ).toEqual(computerBefore.rows);
    const jobRow = await q<{ status: string; lease_id: string }>(
      `SELECT status, lease_id FROM host_jobs WHERE id = $1`,
      [job.id]
    );
    // The computer's own lease is intact: the forgery closed nothing.
    expect(jobRow.rows[0]).toEqual({
      status: "running",
      lease_id: job.leaseId,
    });
  });

  it("sends logs only when asked, scrubbed of secrets", async () => {
    expect(
      await requestHostJobLogs({ jobId: job.id, ownerUserId: OTHER })
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await requestHostJobLogs({ jobId: job.id, ownerUserId: PERSON })
    ).toEqual({ ok: true, requested: true });
    const asked = await post(devbox(), `/host-jobs/${job.id}/heartbeat`, {
      leaseId: job.leaseId,
      phase: "running",
    });
    expect(await asked.json()).toMatchObject({ logsRequested: true });

    const report = await post(devbox(), `/host-jobs/${job.id}/report`, {
      leaseId: job.leaseId,
      log: { head: "pulling sha256:aa", tail: "API_KEY=sk-live-123 started" },
    });
    expect(report.status).toBe(200);
    // Installing: the report never moves the installation.
    expect(await report.json()).toMatchObject({
      installationId: INST,
      status: "installing",
    });
    const after = await post(devbox(), `/host-jobs/${job.id}/heartbeat`, {
      leaseId: job.leaseId,
      phase: "running",
    });
    expect(await after.json()).toMatchObject({ logsRequested: false });

    const read = await appAs({ scopes: BASE, userId: PERSON }).request(
      `/host-jobs/${job.id}/logs`
    );
    expect(read.status).toBe(200);
    const logs = (await read.json()) as { log: { tail: string } };
    expect(logs.log.tail).toContain("***REDACTED***");
    expect(logs.log.tail).not.toContain("sk-live-123");

    const stranger = await appAs({ scopes: BASE, userId: OTHER }).request(
      `/host-jobs/${job.id}/logs`
    );
    expect(stranger.status).toBe(404);
    const noScope = await appAs({ scopes: [], userId: PERSON }).request(
      `/host-jobs/${job.id}/logs`
    );
    expect(noScope.status).toBe(403);
  });

  it("finishing the install makes the installation installed; a second finish is 409", async () => {
    const done = await post(devbox(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "done",
      durationMs: 1200,
      steps: [
        { name: "pull", ok: true },
        { name: "health", ok: true },
      ],
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({
      id: job.id,
      status: "done",
      installationStatus: "installed",
    });
    const again = await post(devbox(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "done",
    });
    expect(again.status).toBe(409);
    const r = await q<{ installed_at: Date | null }>(
      `SELECT installed_at FROM installations WHERE id = $1`,
      [INST]
    );
    expect(r.rows[0]!.installed_at).not.toBeNull();
  });

  it("a report stores health and never moves the lifecycle; health is read", async () => {
    const verbJob = randomUUID();
    await q(
      `INSERT INTO host_jobs (id, kind, installation_id, user_id, machine_user_id, spec, status, attempt, parameters, queued_at)
       VALUES ($1, 'verb', $2, $3, $4, '{}'::jsonb, 'queued', 0, '{}'::jsonb, now())`,
      [verbJob, INST, PERSON, DEVBOX]
    );
    const leased = (await lease(devbox()))!;
    expect(leased.id).toBe(verbJob);
    const sick = await post(devbox(), `/host-jobs/${verbJob}/report`, {
      leaseId: leased.leaseId,
      health: {
        services: {
          render: { healthy: false, detail: "GET /healthz 502" },
        },
      },
    });
    expect(await sick.json()).toMatchObject({ status: "installed" });
    expect((await readHealth(INST)).health).toBe("degraded");
    const well = await post(devbox(), `/host-jobs/${verbJob}/report`, {
      leaseId: leased.leaseId,
      health: {
        services: { render: { healthy: true } },
        ports: [{ service: "render", port: 8080, host: "127.0.0.1" }],
      },
    });
    expect(await well.json()).toMatchObject({ status: "installed" });
    expect((await readHealth(INST)).health).toBe("ok");
    const fin = await post(devbox(), `/host-jobs/${verbJob}/finish`, {
      leaseId: leased.leaseId,
      status: "failed",
      steps: [{ name: "render", ok: false, detail: "exit 1" }],
    });
    // A failed verb is the job's failure, never the installation's.
    expect(await fin.json()).toMatchObject({
      status: "failed",
      installationStatus: "installed",
    });
  });
});

describe("host-jobs routes — a tool", () => {
  const mac = () => appAs({ scopes: RUNNER, userId: PERSON, agentUserId: MAC });

  async function queue(kind: string): Promise<Leased> {
    await q(
      `INSERT INTO host_jobs (id, kind, installation_id, user_id, machine_user_id, spec, status, attempt, parameters, queued_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'queued', 0, '{}'::jsonb, now() - interval '1 hour')`,
      [randomUUID(), kind, INST_TOOL, PERSON, MAC]
    );
    const leased = (await lease(mac()))!;
    expect(leased.kind).toBe(kind);
    return leased;
  }

  beforeAll(async () => {
    // The Mac's earlier jobs are settled so the tool's jobs head the queue.
    await q(`UPDATE host_jobs SET status = 'done' WHERE machine_user_id = $1`, [
      MAC,
    ]);
    await q(
      `INSERT INTO installations (id, user_id, kind, capability_key, machine_user_id, status, desired_version, manifest)
       VALUES ($1, $2, 'tool', 'media-transcribe', $3, 'planned', '1.2.0', '{"verify":{"reverifyEvery":"P1D"}}'::jsonb)`,
      [INST_TOOL, PERSON, MAC]
    );
  });

  it("installs, with the observed version, os and arch; the lease names the kind", async () => {
    const job = await queue("install");
    expect(job.installation).toMatchObject({
      id: INST_TOOL,
      kind: "tool",
      desiredVersion: "1.2.0",
    });
    expect(await installationStatus(INST_TOOL)).toBe("installing");
    const done = await post(mac(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "done",
      observedVersion: "1.2.0",
      os: "darwin",
      arch: "arm64",
      verify: {
        ok: true,
        exitCode: 0,
        excerpt: "whisper 1.2.0 API_KEY=sk-live-abc123",
        outputSha256: "a".repeat(64),
      },
    });
    expect(await done.json()).toMatchObject({
      installationStatus: "installed",
    });
    const row = await q<{
      observed_version: string;
      observed_os: string;
      observed_arch: string;
      verified_at: Date | null;
      health: { verify: { excerpt: string } };
    }>(
      `SELECT observed_version, observed_os, observed_arch, verified_at, health FROM installations WHERE id = $1`,
      [INST_TOOL]
    );
    expect(row.rows[0]).toMatchObject({
      observed_version: "1.2.0",
      observed_os: "darwin",
      observed_arch: "arm64",
    });
    expect(row.rows[0]!.verified_at).not.toBeNull();
    // What the runner saw of the computer is kept on the computer too: the
    // roster and the placement check read its processor from there.
    const computer = await q<{ m: Record<string, unknown> }>(
      `SELECT agent_metadata AS m FROM users WHERE id = $1`,
      [MAC]
    );
    expect(computer.rows[0]!.m).toMatchObject({
      platform: "darwin",
      arch: "arm64",
    });
    expect(row.rows[0]!.health.verify.excerpt).not.toContain("sk-live-abc123");
    expect((await readHealth(INST_TOOL)).health).toBe("ok");
  });

  it("a failed verify moves no lifecycle and reads failed; drift reads drifted", async () => {
    const job = await queue("verify");
    // A verify never moves the lifecycle at lease.
    expect(await installationStatus(INST_TOOL)).toBe("installed");
    const fin = await post(mac(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "failed",
      observedVersion: "1.2.0",
      verify: { ok: false, exitCode: null, excerpt: "spawn ENOENT" },
    });
    // A check whose program never started has no exit code: accepted (200).
    expect(fin.status).toBe(200);
    expect(await fin.json()).toMatchObject({
      status: "failed",
      installationStatus: "installed",
    });
    expect((await readHealth(INST_TOOL)).health).toBe("failed");

    const again = await queue("verify");
    await post(mac(), `/host-jobs/${again.id}/finish`, {
      leaseId: again.leaseId,
      status: "done",
      observedVersion: "1.3.0",
      verify: { ok: true, exitCode: 0 },
    });
    expect((await readHealth(INST_TOOL)).health).toBe("drifted");
  });

  it("self-heal: a check that passes on a tool recorded failed makes it installed, with the version seen", async () => {
    // Tonight's ffmpeg: the install's check timed out (failed), the tool works.
    await q(
      `UPDATE installations SET status = 'failed', status_detail = 'ffmpeg took longer than 30 s and was stopped' WHERE id = $1`,
      [INST_TOOL]
    );
    const job = await queue("verify");
    const fin = await post(mac(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "done",
      observedVersion: "1.2.0",
      verify: { ok: true, exitCode: 0 },
    });
    expect(await fin.json()).toMatchObject({ installationStatus: "installed" });
    const row = await q<{ status_detail: string | null; observed_version: string }>(
      `SELECT status_detail, observed_version FROM installations WHERE id = $1`,
      [INST_TOOL]
    );
    expect(row.rows[0]).toEqual({ status_detail: null, observed_version: "1.2.0" });
    expect((await readHealth(INST_TOOL)).health).toBe("ok");
  });

  it("self-heal: a failed check on a failed tool leaves it failed, and every failed lifecycle finish asks the card door", async () => {
    await q(`UPDATE installations SET status = 'failed' WHERE id = $1`, [INST_TOOL]);
    h.stoppedChecks.length = 0;
    const job = await queue("verify");
    const fin = await post(mac(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "failed",
      verify: { ok: false, exitCode: 1 },
    });
    expect(await fin.json()).toMatchObject({ installationStatus: "failed" });
    expect(h.stoppedChecks).toEqual([INST_TOOL]);
    // A job that finished done asks nothing.
    await q(`UPDATE installations SET status = 'installed' WHERE id = $1`, [INST_TOOL]);
    const ok = await queue("verify");
    await post(mac(), `/host-jobs/${ok.id}/finish`, {
      leaseId: ok.leaseId,
      status: "done",
      observedVersion: "1.2.0",
      verify: { ok: true, exitCode: 0 },
    });
    expect(h.stoppedChecks).toEqual([INST_TOOL]);
  });

  it("an install job on an installed tool is a repair at the approved version", async () => {
    const job = await queue("install");
    expect(await installationStatus(INST_TOOL)).toBe("installing");
    await post(mac(), `/host-jobs/${job.id}/finish`, {
      leaseId: job.leaseId,
      status: "done",
      observedVersion: "1.2.0",
      verify: { ok: true, exitCode: 0 },
    });
    expect(await installationStatus(INST_TOOL)).toBe("installed");
    expect((await readHealth(INST_TOOL)).health).toBe("ok");
  });
});

describe("host-jobs routes — the body door", () => {
  it("refuses a body that is not JSON, an empty report, and a port not on 127.0.0.1", async () => {
    const id = randomUUID();
    const notJson = await post(devbox(), `/host-jobs/${id}/heartbeat`, "{");
    expect(notJson.status).toBe(400);
    const empty = await post(devbox(), `/host-jobs/${id}/report`, {
      leaseId: randomUUID(),
    });
    expect(empty.status).toBe(400);
    const open = await post(devbox(), `/host-jobs/${id}/report`, {
      leaseId: randomUUID(),
      health: {
        services: {},
        ports: [{ service: "studio", port: 3002, host: "0.0.0.0" }],
      },
    });
    expect(open.status).toBe(400);
  });
});

describe("read verdicts — never stored", () => {
  const now = new Date("2026-11-04T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  const base = {
    statusDetail: null,
    health: null,
    lastReportAt: null,
    installedAt: null,
    verifiedAt: null,
    observedVersion: null,
    desiredVersion: null,
    manifest: {},
  } as const;

  it("a service silent past the window reads unknown, with when", () => {
    const silent = installationHealth(
      {
        ...base,
        kind: "service",
        status: "installed",
        lastReportAt: ago(INSTALLATION_REPORT_WINDOW_SECONDS + 1),
        installedAt: ago(86_400),
      },
      now
    );
    expect(silent.health).toBe("unknown");
    expect(silent.notSeenSince).toEqual(
      ago(INSTALLATION_REPORT_WINDOW_SECONDS + 1)
    );
    const fresh = installationHealth(
      { ...base, kind: "service", status: "installed", lastReportAt: ago(10) },
      now
    );
    expect(fresh.health).toBe("ok");
    // Just installed, no report yet: the install's finish is the last sign.
    expect(
      installationHealth(
        { ...base, kind: "service", status: "installed", installedAt: ago(10) },
        now
      ).health
    ).toBe("ok");
  });

  it("a tool reads unknown, ok, stale past reverifyEvery, failed, drifted", () => {
    const tool = { ...base, kind: "tool", status: "installed" } as const;
    expect(installationHealth(tool, now).health).toBe("unknown");
    expect(
      installationHealth({ ...tool, verifiedAt: ago(60) }, now).health
    ).toBe("ok");
    expect(
      installationHealth(
        { ...tool, verifiedAt: ago(TOOL_REVERIFY_DEFAULT_SECONDS + 1) },
        now
      ).health
    ).toBe("stale");
    // The manifest's own cadence wins over the default.
    expect(
      installationHealth(
        {
          ...tool,
          verifiedAt: ago(2 * 3600),
          manifest: { verify: { reverifyEvery: "PT1H" } },
        },
        now
      ).health
    ).toBe("stale");
    expect(
      installationHealth(
        {
          ...tool,
          verifiedAt: ago(60),
          health: { verify: { ok: false, exitCode: 1 } },
        },
        now
      ).health
    ).toBe("failed");
    expect(
      installationHealth(
        {
          ...tool,
          verifiedAt: ago(60),
          desiredVersion: "8.0",
          observedVersion: "7.1",
        },
        now
      ).health
    ).toBe("drifted");
  });

  it("only a lifecycle that ran has a health", () => {
    for (const status of [
      "planned",
      "installing",
      "updating",
      "removing",
      "removed",
    ] as const) {
      expect(
        installationHealth({ ...base, kind: "tool", status }, now).health
      ).toBeNull();
    }
    expect(
      installationHealth(
        { ...base, kind: "service", status: "failed", statusDetail: "x" },
        now
      )
    ).toMatchObject({ health: "failed", detail: "x" });
  });

  it("reads ISO 8601 durations", () => {
    expect(isoDurationSeconds("P7D")).toBe(7 * 86_400);
    expect(isoDurationSeconds("PT12H")).toBe(12 * 3_600);
    expect(isoDurationSeconds("P1DT30M")).toBe(86_400 + 1_800);
    expect(isoDurationSeconds("7 days")).toBeNull();
    expect(isoDurationSeconds("P")).toBeNull();
  });

  it("a running job whose lease ran out reads stalled", () => {
    expect(
      hostJobReadStatus({ status: "running", leaseExpiresAt: ago(1) }, now)
    ).toBe("stalled");
    expect(
      hostJobReadStatus({ status: "leased", leaseExpiresAt: ago(1) }, now)
    ).toBe("leased");
  });
});
