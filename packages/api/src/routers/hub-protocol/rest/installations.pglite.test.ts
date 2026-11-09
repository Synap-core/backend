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
 *   - the reconciler queues at most one open job per installation, verifies
 *     when a check is due, repairs a drift once per finding, and heals by
 *     itself (self-heal.ts): a failed lifecycle is checked then repaired, a
 *     failed check is repaired, each retried with a back-off up to a cap
 *     that sends ONE card; an install waits for its prerequisites, and one
 *     nobody approved is ONE ask.
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
  prerequisiteAsks: [] as Array<{ installationId: string; missing: string[] }>,
}));

// The prerequisite ask is recorded, not sent: its own test below drives the
// real producer with a stub door.
vi.mock("../../../services/installations/self-heal-notice.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    notifyPrerequisiteNeeded: async (row: { id: string }, missing: string[]) => {
      h.prerequisiteAsks.push({ installationId: row.id, missing: [...missing] });
      return true;
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
  requiredCapabilityKeys,
} from "../../../services/installations/installations.js";
import {
  SELF_HEAL_BACKOFF_SECONDS,
  SELF_HEAL_MAX_FAILURES,
  type InstallationJobHistoryEntry,
} from "../../../services/installations/self-heal.js";
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
    `INSERT INTO users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', 'human', NULL, NULL, NULL, '{}'::jsonb),
      ($2, 'b@x', 'other', 'human', NULL, NULL, NULL, '{}'::jsonb),
      ($3, 'm@x', 'Mac', 'agent', 'machine', $1, NULL, $9::jsonb),
      ($4, 'o@x', 'Off box', 'agent', 'machine', $1, NULL, $10::jsonb),
      ($5, 'w@x', 'Win box', 'agent', 'machine', $1, NULL, $11::jsonb),
      ($6, 's@x', 'Stranger box', 'agent', 'machine', $2, NULL, $9::jsonb),
      ($7, 'h@x', 'Claude Code on the Mac', 'agent', 'claude-code', $1, $3, '{}'::jsonb),
      ($8, 'c@x', 'Cloud agent', 'agent', 'claude-code', $1, NULL, '{}'::jsonb)`,
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
  h.prerequisiteAsks.length = 0;
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
    // A failed lifecycle heals by itself: a check first.
    expect(nextJobFor(row({ status: "failed" }), now)).toBe("verify");
  });

  /** A past job, finished `s` seconds before `now`. */
  const past = (
    kind: InstallationJobHistoryEntry["kind"],
    status: InstallationJobHistoryEntry["status"],
    s: number
  ): InstallationJobHistoryEntry => ({
    kind,
    status,
    queuedAt: ago(s + 30),
    finishedAt: ago(s),
  });

  it("repairs a drift ONCE per finding", () => {
    const drifted = row({ observedVersion: "1.1.0" });
    expect(nextJobFor(drifted, now, undefined, [past("verify", "done", 60)])).toBe("install");
    expect(nextJobFor(drifted, now, undefined, [past("update", "done", 60)])).toBeNull();
  });

  it("self-heal 1: a tool recorded failed that may work is checked first; a failed check is then repaired", () => {
    // Tonight's ffmpeg: installed on the computer, recorded failed after a timed-out check.
    const failed = row({ status: "failed", statusDetail: "ffmpeg took longer than 30 s" });
    const installFailed = [past("install", "failed", 120)];
    expect(nextJobFor(failed, now, undefined, installFailed)).toBe("verify");
    // The check failed too: the next try is an install from the approved snapshot, after the back-off.
    const checkFailed = [past("verify", "failed", 10), ...installFailed];
    expect(nextJobFor(failed, now, undefined, checkFailed)).toBeNull();
    const later = new Date(now.getTime() + SELF_HEAL_BACKOFF_SECONDS[1] * 1000);
    expect(nextJobFor(failed, later, undefined, checkFailed)).toBe("install");
  });

  it("self-heal 2: an installed tool whose check failed is installed again, after the back-off", () => {
    const broken = row({ health: { verify: { ok: false, exitCode: 127 } } });
    const checkFailed = [past("verify", "failed", 30)];
    expect(nextJobFor(broken, now, undefined, checkFailed)).toBeNull();
    expect(
      nextJobFor(broken, new Date(now.getTime() + SELF_HEAL_BACKOFF_SECONDS[0] * 1000), undefined, checkFailed)
    ).toBe("install");
    // A repair that took resets the ladder: the next due check runs as usual.
    expect(nextJobFor(row({ verifiedAt: ago(7200) }), now, undefined, [past("install", "done", 7200), ...checkFailed])).toBe("verify");
  });

  it("self-heal 3: the back-off grows, the cap stops it, and a person's stop or ask decides", () => {
    const failed = row({ status: "failed" });
    for (let f = 1; f < SELF_HEAL_MAX_FAILURES; f++) {
      const history = Array.from({ length: f }, (_, i) => past(i % 2 ? "install" : "verify", "failed", 1 + i * 10));
      const wait = SELF_HEAL_BACKOFF_SECONDS[f - 1]!;
      expect(nextJobFor(failed, new Date(now.getTime() + (wait - 2) * 1000), undefined, history)).toBeNull();
      expect(nextJobFor(failed, new Date(now.getTime() + wait * 1000), undefined, history)).not.toBeNull();
    }
    const capped = Array.from({ length: SELF_HEAL_MAX_FAILURES }, (_, i) => past(i % 2 ? "install" : "verify", "failed", 1 + i * 10));
    const muchLater = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    expect(nextJobFor(failed, muchLater, undefined, capped)).toBeNull();
    // A job a person stopped is their call.
    expect(nextJobFor(failed, muchLater, undefined, [past("install", "stopped", 600)])).toBeNull();
    // A person's own ask (a repair) runs now, whatever the ladder says.
    expect(nextJobFor(failed, now, "install", capped)).toBe("install");
  });

  it("self-heal 4: an install waits for its approved prerequisites, and for one nobody approved", () => {
    const planned = row({ status: "planned" });
    expect(nextJobFor(planned, now, undefined, [], { waiting: ["media-ffmpeg"], missing: [] })).toBeNull();
    expect(nextJobFor(planned, now, undefined, [], { waiting: [], missing: ["media-ffmpeg"] })).toBeNull();
    expect(nextJobFor(planned, now, undefined, [], { waiting: [], missing: [] })).toBe("install");
    // A repair waits too, after its check: waiting counts no failure.
    const failed = row({ status: "failed" });
    expect(
      nextJobFor(failed, now, undefined, [past("verify", "failed", 3600)], { waiting: ["media-ffmpeg"], missing: [] })
    ).toBeNull();
    // Which prerequisites count: this computer's system, never itself.
    const manifest = {
      placement: {
        requires: {
          capabilities: [{ slug: "media-ffmpeg" }, { slug: "winget-thing", os: "win32" }, { slug: "media-download" }],
        },
      },
    };
    expect(requiredCapabilityKeys({ capabilityKey: "media-download", manifest }, "darwin")).toEqual(["media-ffmpeg"]);
    expect(requiredCapabilityKeys({ capabilityKey: "media-download", manifest }, "win32")).toEqual(["media-ffmpeg", "winget-thing"]);
  });

  it("self-heal 5: a removal converges the same way: retried with a back-off, capped, a person's ask runs now", () => {
    const leaving = row({ desiredState: "removed", status: "failed" });
    expect(nextJobFor(leaving, now, undefined, [past("remove", "failed", 10)])).toBeNull();
    expect(nextJobFor(leaving, now, undefined, [past("remove", "failed", SELF_HEAL_BACKOFF_SECONDS[0])])).toBe("remove");
    const capped = Array.from({ length: SELF_HEAL_MAX_FAILURES }, (_, i) => past("remove", "failed", 1 + i));
    expect(nextJobFor(leaving, new Date(now.getTime() + 30 * 24 * 3600 * 1000), undefined, capped)).toBeNull();
    expect(nextJobFor(leaving, now, "remove", capped)).toBe("remove");
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

  it("on a lease, a dependent waits for its approved prerequisite and installs right after it", async () => {
    // Tonight: Download was approved with ffmpeg; it must install after ffmpeg, not fail.
    const ffmpeg = randomUUID();
    const download = randomUUID();
    const requires = JSON.stringify({ placement: { requires: { capabilities: [{ slug: "media-ffmpeg" }] } } });
    await q(
      `INSERT INTO installations (id, user_id, kind, capability_key, machine_user_id, status, manifest) VALUES
        ($1, $3, 'tool', 'media-ffmpeg', $4, 'installing', '{}'::jsonb),
        ($2, $3, 'tool', 'media-download', $4, 'planned', $5::jsonb)`,
      [ffmpeg, download, PERSON, OFFBOX, requires]
    );
    const runner = { machineUserId: OFFBOX, ownerUserId: PERSON };
    const openFor = async (id: string) =>
      (await q<{ kind: string }>(`SELECT kind FROM host_jobs WHERE installation_id = $1 AND status IN ('queued','leased','running')`, [id])).rows;
    await reconcileComputer(runner);
    expect(await openFor(download)).toEqual([]);
    await q(
      `UPDATE installations SET status = 'installed', verified_at = now(), health = '{"verify":{"ok":true,"exitCode":0}}'::jsonb WHERE id = $1`,
      [ffmpeg]
    );
    await reconcileComputer(runner);
    expect(await openFor(download)).toEqual([{ kind: "install" }]);
  });

  it("a person's install whose prerequisite nobody approved on that computer queues nothing and asks ONCE", async () => {
    const DOWNLOAD_CAP = randomUUID();
    const needsFfmpeg = { ...TOOL, placement: { ...TOOL.placement, requires: { capabilities: [{ slug: "media-ffmpeg-x" }] } } };
    await q(
      `INSERT INTO capabilities (id, created_by, name, template_key, metadata) VALUES ($1, $2, 'Download media', 'media-download-x', $3::jsonb)`,
      [DOWNLOAD_CAP, PERSON, JSON.stringify({ computer: needsFfmpeg })]
    );
    const res = await ask(person(), { capabilityKey: "media-download-x", action: "install", computer: MAC });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installationId: string; jobId?: string | null };
    expect(body.jobId ?? null).toBeNull();
    expect(h.prerequisiteAsks).toEqual([{ installationId: body.installationId, missing: ["media-ffmpeg-x"] }]);
    // A lease reconciles it again: still nothing queued, and no second ask.
    await reconcileComputer({ machineUserId: MAC, ownerUserId: PERSON });
    const open = await q(`SELECT 1 FROM host_jobs WHERE installation_id = $1 AND status IN ('queued','leased','running')`, [body.installationId]);
    expect(open.rows).toEqual([]);
    expect(h.prerequisiteAsks).toHaveLength(1);
  });
});

describe("self-heal: the card when the pod stops trying", () => {
  it("is sent once, by the failure that reaches the cap, never before or after", async () => {
    const { notifyIfSelfHealStopped } = await vi.importActual<
      typeof import("../../../services/installations/self-heal-notice.js")
    >("../../../services/installations/self-heal-notice.js");
    const inst = randomUUID();
    await q(
      `INSERT INTO installations (id, user_id, kind, capability_id, capability_key, machine_user_id, status, status_detail, manifest)
       VALUES ($1, $2, 'tool', $3, $4, $5, 'failed', 'The step “Homebrew: install mlx-whisper” failed: exit 1', '{}'::jsonb)`,
      [inst, PERSON, CAP, KEY, OFFBOX]
    );
    const fail = (i: number) =>
      q(
        `INSERT INTO host_jobs (id, kind, installation_id, user_id, machine_user_id, spec, status, attempt, parameters, queued_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'failed', 1, '{}'::jsonb, now() - make_interval(mins => $6), now() - make_interval(mins => $6))`,
        [randomUUID(), i % 2 ? "verify" : "install", inst, PERSON, OFFBOX, 100 - i]
      );
    const sent: Array<Record<string, unknown>> = [];
    const deps = { create: async (input: Record<string, unknown>) => (sent.push(input), randomUUID()) };
    for (let i = 1; i < SELF_HEAL_MAX_FAILURES; i++) {
      await fail(i);
      expect(await notifyIfSelfHealStopped(inst, deps as never)).toBe(false);
    }
    await fail(SELF_HEAL_MAX_FAILURES);
    expect(await notifyIfSelfHealStopped(inst, deps as never)).toBe(true);
    await fail(SELF_HEAL_MAX_FAILURES + 1);
    expect(await notifyIfSelfHealStopped(inst, deps as never)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "installation.self_heal_stopped",
      userId: PERSON,
      groupKey: `installation:${inst}`,
      data: {
        name: "Transcribe",
        computer: "Off box",
        action: "install",
        attempts: SELF_HEAL_MAX_FAILURES,
        capabilityKey: KEY,
        lastError: "The step “Homebrew: install mlx-whisper” failed: exit 1",
      },
    });
  });
});
