/**
 * The host-jobs Hub routes (0399, plan 64072312 U7), driven on PGlite through
 * the real routes and the real service. The auth middleware is replaced by one
 * that sets what `hubAuthMiddleware` sets for a key (scopes, the linked person
 * as `userId`, the key's agent as `agentUserId`), so each case is one key:
 *
 *   - a computer key without `host.runner` (even holding `box.runner`) → 403;
 *   - an agent key, or the person's own key, holding the scope → 403;
 *   - a computer acting for another person → 403;
 *   - the computer's own key → it leases ONLY the jobs of installations on
 *     itself (not a sibling computer's, not a job whose copied computer id
 *     points at it while its installation lives elsewhere), heartbeats,
 *     reports and finishes, and the installation moves with it.
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

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerHostJobsRoutes } from "./host-jobs.js";
import {
  installationReadStatus,
  hostJobReadStatus,
  requestHostJobLogs,
  INSTALLATION_REPORT_WINDOW_SECONDS,
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
const INST = randomUUID();
const INST_MAC = randomUUID();
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
    `INSERT INTO installations (id, user_id, capability_key, machine_user_id, status, manifest, digests)
     VALUES ($1, $3, 'hyperframes', $4, 'planned', '{"services":[{"id":"render"}]}'::jsonb, '{"render":"sha256:aa"}'::jsonb),
            ($2, $3, 'hyperframes', $5, 'planned', '{}'::jsonb, '{}'::jsonb)`,
    [INST, INST_MAC, PERSON, DEVBOX, MAC]
  );
  // The devbox's own install job; the Mac's job; and a job whose COPIED
  // computer id says devbox while its installation lives on the Mac.
  await q(
    `INSERT INTO host_jobs (id, kind, installation_id, user_id, machine_user_id, spec, status, attempt, queued_at, parameters)
     VALUES ($1, 'install', $2, $5, $6, '{"op":"install"}'::jsonb, 'queued', 0, now() - interval '3 minutes', '{}'::jsonb),
            ($3, 'install', $4, $5, $7, '{}'::jsonb, 'queued', 0, now() - interval '2 minutes', '{}'::jsonb),
            ($8, 'install', $4, $5, $6, '{}'::jsonb, 'queued', 0, now() - interval '1 minute', '{}'::jsonb)`,
    [JOB_INSTALL, INST, JOB_MAC, INST_MAC, PERSON, DEVBOX, MAC, JOB_FORGED]
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

  it("finishing the install makes the installation healthy; a second finish is 409", async () => {
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
      installationStatus: "healthy",
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

  it("health moves a running installation between healthy and degraded", async () => {
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
    expect(await sick.json()).toMatchObject({ status: "degraded" });
    const well = await post(devbox(), `/host-jobs/${verbJob}/report`, {
      leaseId: leased.leaseId,
      health: {
        services: { render: { healthy: true } },
        ports: [{ service: "render", port: 8080, host: "127.0.0.1" }],
      },
    });
    expect(await well.json()).toMatchObject({ status: "healthy" });
    const fin = await post(devbox(), `/host-jobs/${verbJob}/finish`, {
      leaseId: leased.leaseId,
      status: "failed",
      steps: [{ name: "render", ok: false, detail: "exit 1" }],
    });
    // A failed verb is the job's failure, never the installation's.
    expect(await fin.json()).toMatchObject({
      status: "failed",
      installationStatus: "healthy",
    });
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

  it("a healthy installation silent past the window reads degraded, with when", () => {
    const silent = installationReadStatus(
      {
        status: "healthy",
        lastReportAt: ago(INSTALLATION_REPORT_WINDOW_SECONDS + 1),
        installedAt: ago(86_400),
        statusDetail: null,
      },
      now
    );
    expect(silent.status).toBe("degraded");
    expect(silent.notSeenSince).toEqual(
      ago(INSTALLATION_REPORT_WINDOW_SECONDS + 1)
    );
    const fresh = installationReadStatus(
      {
        status: "healthy",
        lastReportAt: ago(10),
        installedAt: ago(86_400),
        statusDetail: null,
      },
      now
    );
    expect(fresh.status).toBe("healthy");
    // Just installed, no report yet: the install's finish is the last sign.
    expect(
      installationReadStatus(
        {
          status: "healthy",
          lastReportAt: null,
          installedAt: ago(10),
          statusDetail: null,
        },
        now
      ).status
    ).toBe("healthy");
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
