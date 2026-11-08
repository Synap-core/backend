/**
 * The installations Hub routes and the pod-side reconciler (reconciliation
 * f75fbb48 §3.2–§3.4), driven on PGlite through the real routes and the real
 * service. The auth middleware is replaced by one that sets what
 * `hubAuthMiddleware` sets for a key; the gate (`checkPermissionOrPropose`)
 * is replaced by the ladder's two outcomes: a person's ask is granted, an
 * agent's is proposed. Each case asserts whether the gate was reached:
 *
 *   - a person's first install applies: one live `tool` row with the
 *     manifest AS APPROVED, the asked half, and ONE install job;
 *   - approval is once per (capability, computer): the same install asked
 *     again by an agent (a repair) and a verify never reach the gate; a new
 *     version and a removal do (proposed);
 *   - the computer must have "Installs from the pod" on, and the placement
 *     must allow its system;
 *   - `computer: "me"` is the caller's own computer (its key, or an agent
 *     hosted on it); an agent on no computer is refused; a stranger's
 *     computer is 404 on the ask and empty on the read;
 *   - the reconciler queues at most one open job per installation, repairs
 *     once per finding, and verifies when a check is due.
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
  db: null as unknown,
  gate: [] as Array<Record<string, unknown>>,
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

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gate.push(opts);
      return opts.agentUserId
        ? {
            granted: false,
            proposalId: randomUUID(),
            proposalType: "installation.request",
            reviewUrl: "https://pod.example/review",
          }
        : { granted: true };
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerInstallationsRoutes } from "./installations.js";
import {
  nextJobFor,
  reconcileComputer,
} from "../../../services/installations/installations.js";
import { pgliteAllTablesDdl } from "../../../__tests__/pglite-ddl.js";
import type { HubHono, HubVariables } from "./_shared.js";
import type { InstallationRow } from "@synap/database/schema";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PERSON = "person-a";
const OTHER = "person-b";
const MAC = "machine-mac";
const OFFBOX = "machine-off";
const WINBOX = "machine-win";
const STRANGER_BOX = "machine-stranger";
const HOSTED = "agent-on-mac";
const AGENT = "agent-cloud";
const CAP = randomUUID();
const KEY = "media-transcribe";

const RW = ["hub-protocol.read", "hub-protocol.write"];

const TOOL = {
  placement: {
    runsOn: ["computer"],
    platforms: [
      { os: "darwin", arch: ["arm64"] },
      { os: "linux", arch: ["x64"] },
    ],
  },
  install: {
    darwin: {
      steps: [{ kind: "uv", action: "tool-install", package: "mlx-whisper" }],
    },
    linux: {
      steps: [
        { kind: "uv", action: "tool-install", package: "whisper-ctranslate2" },
      ],
    },
  },
  verify: {
    darwin: {
      command: ["mlx_whisper", "--help"],
      expect: { exitCode: 0 },
    },
    linux: {
      command: ["whisper-ctranslate2", "--version"],
      expect: { exitCode: 0 },
    },
    reverifyEvery: "P1D",
  },
  licence: "MIT",
  recipes: [],
};

function appAs(vars: { userId: string; agentUserId?: string }): HubHono {
  const app = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", RW);
    c.set("userId", vars.userId);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    await next();
  });
  registerInstallationsRoutes(app);
  return app;
}

const person = () => appAs({ userId: PERSON });
const hosted = () => appAs({ userId: PERSON, agentUserId: HOSTED });
const agent = () => appAs({ userId: PERSON, agentUserId: AGENT });

const ask = (app: HubHono, body: Record<string, unknown>) =>
  app.request("/installations/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function openJobs(): Promise<Array<{ kind: string }>> {
  return (
    await q<{ kind: string }>(
      `SELECT kind FROM host_jobs WHERE status IN ('queued','leased','running') ORDER BY queued_at`
    )
  ).rows;
}

async function settleJobs(): Promise<void> {
  await q(`UPDATE host_jobs SET status = 'done' WHERE status = 'queued'`);
}

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  // The derived DDL carries no index: the two partial uniques this model
  // rests on (0409) are added on purpose, from the migration itself.
  const m0409 = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../database/migrations/0409_installations.sql"
    ),
    "utf8"
  );
  const uniques = m0409.match(/CREATE UNIQUE INDEX IF NOT EXISTS[^;]+;/g) ?? [];
  expect(uniques).toHaveLength(2);
  for (const ddl of uniques) await h.client!.exec(ddl);
  const meta = (platform: string, arch: string, on: boolean) =>
    JSON.stringify({ platform, arch, hostsServices: on });
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, host_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', NULL, NULL, NULL, '{}'::jsonb),
      ($2, 'b@x', 'other', NULL, NULL, NULL, '{}'::jsonb),
      ($3, 'm@x', 'Mac', 'machine', $1, NULL, $9::jsonb),
      ($4, 'o@x', 'Off box', 'machine', $1, NULL, $10::jsonb),
      ($5, 'w@x', 'Win box', 'machine', $1, NULL, $11::jsonb),
      ($6, 's@x', 'Stranger box', 'machine', $2, NULL, $9::jsonb),
      ($7, 'h@x', 'Claude Code on the Mac', 'claude-code', $1, $3, '{}'::jsonb),
      ($8, 'c@x', 'Cloud agent', 'claude-code', $1, NULL, '{}'::jsonb)`,
    [
      PERSON,
      OTHER,
      MAC,
      OFFBOX,
      WINBOX,
      STRANGER_BOX,
      HOSTED,
      AGENT,
      meta("darwin", "arm64", true),
      meta("darwin", "arm64", false),
      meta("win32", "x64", true),
    ]
  );
  await q(
    `INSERT INTO capabilities (id, created_by, name, template_key, metadata)
     VALUES ($1, $2, 'Transcribe', $3, $4::jsonb)`,
    [CAP, PERSON, KEY, JSON.stringify({ computer: TOOL })]
  );
}, 60_000);

beforeEach(() => {
  h.gate.length = 0;
});

describe("installations — the ask", () => {
  let installationId: string;

  it("a person's first install applies: one live tool row, the asked half, one install job", async () => {
    const res = await ask(person(), {
      capabilityKey: KEY,
      action: "install",
      computer: MAC,
      version: "1.2.0",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      installationId: string;
      jobId: string | null;
    };
    expect(body).toMatchObject({ status: "approved" });
    expect(body.jobId).not.toBeNull();
    installationId = body.installationId;
    expect(h.gate).toHaveLength(1);
    const row = await q<Record<string, unknown>>(
      `SELECT kind, status, desired_state, desired_version, approved_by, manifest FROM installations WHERE id = $1`,
      [installationId]
    );
    expect(row.rows[0]).toMatchObject({
      kind: "tool",
      status: "planned",
      desired_state: "installed",
      desired_version: "1.2.0",
      approved_by: PERSON,
    });
    // The manifest AS APPROVED, recipes kept.
    expect(row.rows[0]!.manifest).toEqual(TOOL);
    expect(await openJobs()).toEqual([{ kind: "install" }]);
  });

  it("the same install asked again by an agent is a repair: no gate, no second open job", async () => {
    const res = await ask(agent(), {
      capabilityKey: KEY,
      action: "install",
      computer: MAC,
      version: "1.2.0",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "approved",
      installationId,
      jobId: null,
    });
    expect(h.gate).toHaveLength(0);
    expect(await openJobs()).toHaveLength(1);
  });

  it("a verify asks nobody; one on an installation not installed is refused", async () => {
    const early = await ask(hosted(), { capabilityKey: KEY, action: "verify" });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: "NOT_INSTALLED" });

    await settleJobs();
    await q(
      `UPDATE installations SET status = 'installed', verified_at = now(), observed_version = '1.2.0' WHERE id = $1`,
      [installationId]
    );
    const res = await ask(hosted(), { capabilityKey: KEY, action: "verify" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "approved",
      installationId,
    });
    expect(h.gate).toHaveLength(0);
    expect(await openJobs()).toEqual([{ kind: "verify" }]);
    await settleJobs();
  });

  it("a new version and a removal by an agent are proposals", async () => {
    const upgrade = await ask(agent(), {
      capabilityKey: KEY,
      action: "install",
      computer: MAC,
      version: "1.3.0",
    });
    expect(upgrade.status).toBe(202);
    expect(await upgrade.json()).toMatchObject({ status: "proposed" });
    const removal = await ask(agent(), {
      capabilityKey: KEY,
      action: "remove",
      computer: MAC,
    });
    expect(removal.status).toBe(202);
    expect(h.gate.map((g) => g.subjectType)).toEqual([
      "installation",
      "installation",
    ]);
    expect(h.gate.map((g) => g.action)).toEqual(["request", "request"]);
    // Nothing applied: the asked half is unchanged.
    const row = await q<{ desired_version: string; desired_state: string }>(
      `SELECT desired_version, desired_state FROM installations WHERE id = $1`,
      [installationId]
    );
    expect(row.rows[0]).toEqual({
      desired_version: "1.2.0",
      desired_state: "installed",
    });
    expect(await openJobs()).toHaveLength(0);
  });

  it("a person's new version applies as an update job", async () => {
    const res = await ask(person(), {
      capabilityKey: KEY,
      action: "install",
      computer: MAC,
      version: "1.3.0",
    });
    expect(res.status).toBe(200);
    expect(await openJobs()).toEqual([{ kind: "update" }]);
    await settleJobs();
  });

  it('refuses a computer without "Installs from the pod", and a system its placement does not list', async () => {
    const off = await ask(person(), {
      capabilityKey: KEY,
      action: "install",
      computer: OFFBOX,
    });
    expect(off.status).toBe(409);
    expect(JSON.stringify(await off.json())).toContain("Installs from the pod");
    const win = await ask(person(), {
      capabilityKey: KEY,
      action: "install",
      computer: WINBOX,
    });
    expect(win.status).toBe(409);
    expect(JSON.stringify(await win.json())).toContain("win32");
    expect(h.gate).toHaveLength(0);
  });

  it('"me" needs a computer; a stranger\'s computer is not found; an unknown capability is not installable', async () => {
    const me = await ask(agent(), { capabilityKey: KEY, action: "install" });
    expect(me.status).toBe(403);
    expect(await me.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
    const stranger = await ask(person(), {
      capabilityKey: KEY,
      action: "install",
      computer: STRANGER_BOX,
    });
    expect(stranger.status).toBe(404);
    const unknown = await ask(person(), {
      capabilityKey: "not-a-tool",
      action: "install",
      computer: MAC,
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "NOT_INSTALLABLE" });
  });
});

describe("installations — the read", () => {
  it("this computer's installations (the hosted agent's), by capability, a stranger's as empty", async () => {
    // Another person's installation of the SAME capability: without it the
    // stranger read below is empty whatever the owner floor does (it was,
    // until 2026-11-08: a negative control that bypassed the floor stayed
    // green).
    await q(
      `INSERT INTO installations (user_id, kind, capability_key, machine_user_id, manifest, desired_state, status)
       VALUES ($1, 'tool', $2, $3, '{}'::jsonb, 'installed', 'installed')`,
      [OTHER, KEY, STRANGER_BOX]
    );
    const mine = await hosted().request("/installations?computer=me");
    expect(mine.status).toBe(200);
    const items = (
      (await mine.json()) as { items: Array<Record<string, unknown>> }
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      computerId: MAC,
      capabilityKey: KEY,
      kind: "tool",
      status: "installed",
      desiredVersion: "1.3.0",
    });
    expect(items[0]!.health).toBeDefined();
    const byKey = await person().request(`/installations?capabilityKey=${KEY}`);
    const byKeyItems = (
      (await byKey.json()) as { items: Array<{ computerId: string }> }
    ).items;
    expect(byKeyItems.map((i) => i.computerId)).toEqual([MAC]);
    const stranger = await person().request(
      `/installations?computer=${STRANGER_BOX}`
    );
    expect(await stranger.json()).toEqual({ items: [] });
    const noComputer = await agent().request("/installations?computer=me");
    expect(noComputer.status).toBe(403);
  });
});

describe("the reconciler", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000);
  const row = (over: Partial<InstallationRow>): InstallationRow =>
    ({
      id: randomUUID(),
      kind: "tool",
      status: "installed",
      statusDetail: null,
      desiredState: "installed",
      desiredVersion: "1.2.0",
      observedVersion: "1.2.0",
      health: null,
      lastReportAt: null,
      installedAt: ago(3600),
      verifiedAt: ago(60),
      manifest: { verify: { reverifyEvery: "PT1H" } },
      ...over,
    }) as InstallationRow;

  it("derives the one job each state is due", () => {
    expect(nextJobFor(row({ status: "planned" }), now)).toBe("install");
    expect(nextJobFor(row({ desiredState: "removed" }), now)).toBe("remove");
    expect(
      nextJobFor(row({ status: "removing", desiredState: "removed" }), now)
    ).toBeNull();
    expect(nextJobFor(row({}), now)).toBeNull();
    expect(nextJobFor(row({ verifiedAt: ago(7200) }), now)).toBe("verify");
    expect(nextJobFor(row({ verifiedAt: null }), now)).toBe("verify");
    // A failed lifecycle is never retried on its own.
    expect(nextJobFor(row({ status: "failed" }), now)).toBeNull();
  });

  it("repairs a failed check or a drift ONCE per finding", () => {
    const failedCheck = row({
      health: { verify: { ok: false, exitCode: 127 } },
    });
    expect(nextJobFor(failedCheck, now, undefined, "verify")).toBe("install");
    expect(nextJobFor(failedCheck, now, undefined, "install")).toBeNull();
    const drifted = row({ observedVersion: "1.1.0" });
    expect(nextJobFor(drifted, now, undefined, "verify")).toBe("install");
    expect(nextJobFor(drifted, now, undefined, "update")).toBeNull();
  });

  it("on a lease, queues at most one open job per installation, never a pile", async () => {
    await settleJobs();
    // The update above finished (settleJobs marks it done): the computer now
    // runs the approved version, last checked 3 days ago, past PT1H.
    await q(
      `UPDATE installations SET verified_at = now() - interval '3 days', observed_version = desired_version WHERE machine_user_id = $1`,
      [MAC]
    );
    const runner = { machineUserId: MAC, ownerUserId: PERSON };
    expect(await reconcileComputer(runner)).toBe(1);
    expect(await reconcileComputer(runner)).toBe(0);
    expect(await openJobs()).toEqual([{ kind: "verify" }]);
  });
});
