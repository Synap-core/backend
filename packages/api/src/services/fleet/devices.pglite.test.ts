/**
 * The devices registry on PGlite (devices plan 767a5978 §3-§4, P1), driven
 * through the real doors:
 *
 * INGEST
 *   - enrolment makes ONE computer device per computer (a reconnect reuses
 *     it), named and owned as the computer is;
 *   - `POST /computers/me/report` stores a v1 manifest and moves the report
 *     time; a report with NO manifest (an older CLI) still answers 200 and
 *     moves the time, keeping the manifest; a manifest the pod cannot read
 *     is `refused` with the field, the last good one kept;
 *   - only the computer's own key reports: a person's key, an agent's key
 *     (one hosted on the computer included) and a computer acting for
 *     another person are `NOT_A_COMPUTER`;
 *   - `POST /host-jobs/lease` from an older CLI (no manifest) still leases,
 *     and one carrying a manifest stores it; a bad one never fails it.
 *
 * READ (`fleet.list` / `fleet.get`)
 *   - a person reads their own devices and the SHARED devices filed in a
 *     space they belong to; never another person's private device, a shared
 *     device of a space they are not in, or a person-owned device of a space
 *     they share;
 *   - the tree nests a VM under its host; status is derived (online when it
 *     just reported, unknown when it never did).
 *
 * ALIAS
 *   - `device` / `deviceId` name the same computer as `computer` /
 *     `computerId`, through the MCP door itself (`synap_list_installations`)
 *     and `computer.run_recipe`'s capability door; another person's device
 *     id passes through as it is (nothing of it leaks);
 *
 * LIFE OF A REPORT
 *   - two processes reporting out of phase each keep their capabilities
 *     alive past the TTL; `[]` replaces a reporter's set, no list keeps it;
 *   - two reports at once lose neither manifest section nor entry;
 *   - a device keeps at most 16 reporters, none past the TTL;
 *   - a computer that only runs scripts reads online (`POST /box-runs/lease`);
 *   - a revoked computer's device is retired, a reconnect brings it back with
 *     its identity refreshed.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  grant: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    getRequestGrant: () => h.grant,
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerComputerReportRoutes } from "../../routers/hub-protocol/rest/computer-report.js";
import { registerHostJobsRoutes } from "../../routers/hub-protocol/rest/host-jobs.js";
import { registerBoxRunsRoutes } from "../../routers/hub-protocol/rest/box-runs.js";
import { effectiveDeviceCapabilities } from "@synap-core/types/device-manifest";
import { resolveBuiltinParamAliases } from "../capabilities/builtin-verbs.js";
import { ensureMachineAgent, revokeMachine } from "../machine-connect.js";
import { fleetRouter } from "../../routers/fleet.js";
import { installationHandlers } from "../../routers/mcp/handlers/installations.js";
import { sessionHandlers } from "../../routers/mcp/handlers/session.js";
import { devicesReadableByGrant } from "../../access/grant-door-fence.js";
import { AccessContext } from "../../access/index.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";
import {
  computerFromDeviceArgs,
  ensureComputerDevice,
  recordDeviceReport,
} from "./devices.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params).then((r) => r.rows);

const A = "person-a";
const B = "person-b";
const DEVBOX = "machine-devbox";
const MAC = "machine-mac";
const BOX_B = "machine-b";
const AGENT = "agent-a";
const HOSTED = "agent-on-devbox";
const SCRIPTS = "machine-scripts";
const TWO = "machine-two";
const RACE = "machine-race";
const OLD = "machine-old";
const WS_SHARED = randomUUID();
const WS_B = randomUUID();
const PRINTER_SHARED = randomUUID();
const PRINTER_PERSON = randomUUID();
const CAMERA_B = randomUUID();
const VM = randomUUID();

const WRITE = ["hub-protocol.read", "hub-protocol.write"];

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
  registerComputerReportRoutes(app);
  registerHostJobsRoutes(app);
  registerBoxRunsRoutes(app);
  return app;
}
const computer = (id: string, userId = A, scopes = WRITE) =>
  appAs({ scopes, userId, agentUserId: id });

const post = (app: HubHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const MANIFEST = {
  manifestVersion: 1,
  identity: { os: "linux", arch: "x64", hostname: "devbox" },
  resources: {
    cpu: { model: "EPYC", cores: 8 },
    memoryMb: 32768,
    disks: [
      { mount: "/data", sizeMb: 492_000, freeMb: 481_000, tier: "hdd-thin" },
    ],
  },
  capabilities: ["run.tool", "wake.agent"],
};

async function deviceRow(principal: string) {
  const [row] = await q<{
    id: string;
    manifest: Record<string, unknown> | null;
    last_report_at: string | null;
  }>(
    `SELECT id, manifest, last_report_at FROM devices WHERE principal_user_id = $1`,
    [principal]
  );
  return row!;
}

const fleetAs = (userId: string) =>
  fleetRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
    session: { id: "s" },
  } as never);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, agent_metadata, computer_belongs_to) VALUES
      ($1, 'a@x', 'Ada', NULL, NULL, NULL, NULL),
      ($2, 'b@x', 'Bea', NULL, NULL, NULL, NULL),
      ($3, 'd@x', 'devbox', 'machine', $1, '{"hostname":"devbox","platform":"linux","arch":"x64"}', 'person'),
      ($4, 'm@x', NULL, 'machine', $1, '{"hostname":"mac.local","platform":"darwin"}', 'person'),
      ($5, 'bb@x', 'box-b', 'machine', $2, '{"hostname":"box-b"}', 'person'),
      ($6, 'c@x', 'Claude Code', 'claude-code', $1, NULL, NULL)`,
    [A, B, DEVBOX, MAC, BOX_B, AGENT]
  );
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, agent_metadata, computer_belongs_to) VALUES
      ($1, 's@x', 'scripts', 'machine', $5, '{"hostname":"scripts"}', 'person'),
      ($2, 't@x', 'two', 'machine', $5, '{"hostname":"two"}', 'person'),
      ($3, 'r@x', 'race', 'machine', $5, '{"hostname":"race"}', 'person'),
      ($4, 'o@x', 'old-box', 'machine', $5, '{"hostname":"old-box","platform":"linux","arch":"x64"}', 'person')`,
    [SCRIPTS, TWO, RACE, OLD, A]
  );
  await q(
    `INSERT INTO users (id, email, name, agent_type, created_by_user_id, host_user_id)
     VALUES ($1, 'h@x', 'Claude Code on devbox', 'claude-code', $2, $3)`,
    [HOSTED, A, DEVBOX]
  );
  await q(
    `INSERT INTO workspaces (id, name, owner_id) VALUES ($1, 'Shared', $2), ($3, 'B only', $2)`,
    [WS_SHARED, B, WS_B]
  );
  await q(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
      ($1, $2, 'owner'), ($1, $3, 'editor'), ($4, $2, 'owner')`,
    [WS_SHARED, B, A, WS_B]
  );
  for (const m of [DEVBOX, MAC, BOX_B]) await ensureComputerDevice(m);
  const devbox = await deviceRow(DEVBOX);
  await q(
    `INSERT INTO devices (id, owner_user_id, workspace_id, belongs_to, kind, name, parent_device_id, connection, labels) VALUES
      ($1, $5, $6, 'shared', 'printer', 'Shared printer', NULL, '{"mode":"manual"}', '{}'),
      ($2, $5, $6, 'person', 'printer', 'Bea''s printer', NULL, '{"mode":"manual"}', '{}'),
      ($3, $5, $7, 'shared', 'camera', 'B-only camera', NULL, '{"mode":"manual"}', '{}'),
      ($4, $8, NULL, 'person', 'vm', 'VM 109', $9, '{"mode":"manual"}', '{}')`,
    [
      PRINTER_SHARED,
      PRINTER_PERSON,
      CAMERA_B,
      VM,
      B,
      WS_SHARED,
      WS_B,
      A,
      devbox.id,
    ]
  );
}, 60_000);

describe("enrolment", () => {
  it("makes one computer device per computer, named and owned as the computer", async () => {
    const rows = await q<{
      principal_user_id: string;
      owner_user_id: string;
      kind: string;
      name: string;
      connection: { mode: string };
      manifest: { identity: Record<string, string> };
    }>(
      `SELECT principal_user_id, owner_user_id, kind, name, connection, manifest
       FROM devices WHERE principal_user_id IS NOT NULL ORDER BY principal_user_id`
    );
    expect(rows.map((r) => r.principal_user_id)).toEqual([BOX_B, DEVBOX, MAC]);
    const mac = rows.find((r) => r.principal_user_id === MAC)!;
    // No name: the hostname, as the person reads the computer.
    expect(mac).toMatchObject({
      owner_user_id: A,
      kind: "computer",
      name: "mac.local",
      connection: { mode: "agent" },
    });
    expect(mac.manifest.identity).toEqual({
      hostname: "mac.local",
      os: "darwin",
    });
  });

  it("a reconnect reuses the device: never a twin", async () => {
    const before = await deviceRow(DEVBOX);
    expect((await ensureComputerDevice(DEVBOX))?.id).toBe(before.id);
    const [{ n }] = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM devices WHERE principal_user_id = $1`,
      [DEVBOX]
    );
    expect(n).toBe(1);
  });

  it("a person or an agent is not a computer: no device", async () => {
    expect(await ensureComputerDevice(A)).toBeNull();
    expect(await ensureComputerDevice(AGENT)).toBeNull();
  });
});

describe("POST /computers/me/report", () => {
  it("stores a v1 manifest and moves the report time", async () => {
    const res = await post(computer(DEVBOX), "/computers/me/report", {
      manifest: MANIFEST,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device: Record<string, unknown> };
    expect(body.device).toMatchObject({ recorded: true, manifest: "accepted" });
    const row = await deviceRow(DEVBOX);
    expect(body.device.deviceId).toBe(row.id);
    expect(row.last_report_at).not.toBeNull();
    expect(row.manifest).toMatchObject({
      resources: { memoryMb: 32768, cpu: { cores: 8 } },
    });
  });

  it("an older CLI sends no manifest: 200, the time moves, the manifest is kept", async () => {
    await q(
      `UPDATE devices SET last_report_at = now() - interval '10 minutes' WHERE principal_user_id = $1`,
      [DEVBOX]
    );
    const before = await deviceRow(DEVBOX);
    const res = await post(computer(DEVBOX), "/computers/me/report", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { device: unknown }).device).toMatchObject({
      recorded: true,
      manifest: "absent",
    });
    const after = await deviceRow(DEVBOX);
    expect(new Date(after.last_report_at!).getTime()).toBeGreaterThan(
      new Date(before.last_report_at!).getTime()
    );
    expect(after.manifest).toEqual(before.manifest);
  });

  it("refuses a manifest it cannot read, names the field, keeps the last good one", async () => {
    const before = await deviceRow(DEVBOX);
    const res = await post(computer(DEVBOX), "/computers/me/report", {
      manifest: { manifestVersion: 1, resources: { memoryMb: -1 } },
    });
    expect(res.status).toBe(200);
    const { device } = (await res.json()) as {
      device: { manifest: string; error?: string };
    };
    expect(device.manifest).toBe("refused");
    expect(device.error).toMatch(/^resources\.memoryMb:/);
    expect((await deviceRow(DEVBOX)).manifest).toEqual(before.manifest);
  });

  it("only the computer's own key reports", async () => {
    for (const app of [
      appAs({ scopes: WRITE, userId: A }),
      appAs({ scopes: WRITE, userId: A, agentUserId: AGENT }),
      appAs({ scopes: WRITE, userId: A, agentUserId: HOSTED }),
      computer(DEVBOX, B),
    ]) {
      const res = await post(app, "/computers/me/report", {
        manifest: MANIFEST,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "NOT_A_COMPUTER" });
    }
    const res = await post(
      computer(DEVBOX, A, ["hub-protocol.read"]),
      "/computers/me/report",
      {}
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "SCOPE_REQUIRED" });
  });
});

describe("POST /host-jobs/lease carries the report", () => {
  const RUNNER = [...WRITE, "host.runner"];

  it("an older CLI (no manifest) still leases, and the Mac now reads reported", async () => {
    expect((await deviceRow(MAC)).last_report_at).toBeNull();
    const res = await post(computer(MAC, A, RUNNER), "/host-jobs/lease", {
      os: "darwin",
      arch: "arm64",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: unknown; device: unknown };
    expect(body.job).toBeNull();
    expect(body.device).toMatchObject({ recorded: true, manifest: "absent" });
    expect((await deviceRow(MAC)).last_report_at).not.toBeNull();
  });

  it("a lease with a manifest stores it; a bad one never fails the lease", async () => {
    const res = await post(computer(MAC, A, RUNNER), "/host-jobs/lease", {
      manifest: { ...MANIFEST, identity: { os: "darwin", arch: "arm64" } },
    });
    expect(res.status).toBe(200);
    expect((await deviceRow(MAC)).manifest).toMatchObject({
      identity: { os: "darwin", arch: "arm64" },
    });
    const bad = await post(computer(MAC, A, RUNNER), "/host-jobs/lease", {
      manifest: { manifestVersion: 2 },
    });
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as { device: unknown }).device).toMatchObject({
      manifest: "refused",
    });
  });
});

describe("fleet.list / fleet.get", () => {
  it("a person reads their own and the shared devices of their spaces, nothing else", async () => {
    const { devices } = await fleetAs(A).list();
    const flat = (nodes: typeof devices): string[] =>
      nodes.flatMap((n) => [n.name, ...flat(n.children)]);
    const names = flat(devices).sort();
    expect(names).toEqual(
      ["devbox", "mac.local", "Shared printer", "VM 109"].sort()
    );
    // B's own computer, B's person printer in the shared space, and B's
    // shared camera in a space A is not in: none of them.
    expect(names).not.toContain("box-b");
    expect(names).not.toContain("Bea's printer");
    expect(names).not.toContain("B-only camera");
  });

  it("B reads B's own devices, shared or not, and none of A's", async () => {
    const { devices } = await fleetAs(B).list();
    expect(devices.map((d) => d.name).sort()).toEqual(
      ["B-only camera", "Bea's printer", "Shared printer", "box-b"].sort()
    );
  });

  it("nests the VM under its host, with derived status and resources", async () => {
    const { devices } = await fleetAs(A).list();
    const devbox = devices.find((d) => d.name === "devbox")!;
    expect(devbox.children.map((c) => c.name)).toEqual(["VM 109"]);
    expect(devbox.status).toBe("online");
    expect(devbox.resources).toMatchObject({ cpuCores: 8, memoryMb: 32768 });
    expect(devbox.children[0]!.status).toBe("unknown");
  });

  it("get answers a readable device with its manifest, NOT_FOUND otherwise", async () => {
    const devbox = await deviceRow(DEVBOX);
    const got = await fleetAs(A).get({ id: devbox.id });
    expect(got.manifest).toMatchObject({ manifestVersion: 1 });
    await expect(fleetAs(A).get({ id: CAMERA_B })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("device / deviceId: aliases of computer / computerId", () => {
  const access = () => AccessContext.operator({ userId: A });

  it("a device id answers its computer; any other value passes through", async () => {
    const devbox = await deviceRow(DEVBOX);
    expect(
      await computerFromDeviceArgs(access(), { device: devbox.id })
    ).toEqual({
      ok: true,
      computer: DEVBOX,
    });
    expect(await computerFromDeviceArgs(access(), { device: "mac" })).toEqual({
      ok: true,
      computer: "mac",
    });
    expect(await computerFromDeviceArgs(access(), { computer: MAC })).toEqual({
      ok: true,
      computer: MAC,
    });
    // Two names for one computer agree; two different computers do not.
    expect(
      await computerFromDeviceArgs(access(), {
        computer: DEVBOX,
        device: devbox.id,
      })
    ).toEqual({ ok: true, computer: DEVBOX });
    expect(
      (
        await computerFromDeviceArgs(access(), {
          computer: MAC,
          device: devbox.id,
        })
      ).ok
    ).toBe(false);
    // A device with no runner is not a computer.
    const printer = await computerFromDeviceArgs(access(), {
      device: PRINTER_SHARED,
    });
    expect(printer.ok).toBe(false);
  });

  it("another person's device id passes through as it is: no principal, no name", async () => {
    const boxB = await deviceRow(BOX_B);
    // B's computer, B's camera in a space A is not in, B's own printer in a
    // space A shares: A reads none of them, so each id is just a value.
    for (const id of [boxB.id, CAMERA_B, PRINTER_PERSON])
      expect(await computerFromDeviceArgs(access(), { device: id })).toEqual({
        ok: true,
        computer: id,
      });
    const refused = await computerFromDeviceArgs(access(), {
      computer: MAC,
      device: boxB.id,
    });
    expect(refused.ok).toBe(false);
    const said = JSON.stringify(refused);
    for (const leak of [BOX_B, "box-b", "B-only camera"])
      expect(said).not.toContain(leak);
  });

  it("computer.run_recipe takes `device` at the capability door, as `computer`", async () => {
    const devbox = await deviceRow(DEVBOX);
    const call = { capability: "media-ffmpeg", recipe: "loudness-normalize" };
    expect(
      await resolveBuiltinParamAliases(
        "computer.run_recipe",
        { ...call, device: devbox.id },
        { userId: A }
      )
    ).toEqual({ ok: true, parameters: { ...call, computer: DEVBOX } });
    // Two names for two computers: refused before anything is filed.
    expect(
      (
        await resolveBuiltinParamAliases(
          "computer.run_recipe",
          { ...call, computer: MAC, device: devbox.id },
          { userId: A }
        )
      ).ok
    ).toBe(false);
    // Without `device`, and for any other verb, the call is left as it is.
    expect(
      await resolveBuiltinParamAliases("computer.run_recipe", call, {
        userId: A,
      })
    ).toEqual({ ok: true, parameters: call });
    const other = { device: devbox.id };
    expect(
      await resolveBuiltinParamAliases("feed.post", other, { userId: A })
    ).toEqual({ ok: true, parameters: other });
  });

  it("synap_list_installations reads the same rows by deviceId as by computerId", async () => {
    await q(
      `INSERT INTO installations (id, user_id, kind, capability_key, machine_user_id, status, manifest, digests) VALUES
        ($1, $3, 'tool', 'media-ffmpeg', $4, 'installed', '{}'::jsonb, '{}'::jsonb),
        ($2, $3, 'tool', 'media-ffmpeg', $5, 'installed', '{}'::jsonb, '{}'::jsonb)`,
      [randomUUID(), randomUUID(), A, DEVBOX, MAC]
    );
    const devbox = await deviceRow(DEVBOX);
    const call = async (args: Record<string, unknown>) => {
      const res = await installationHandlers.synap_list_installations!({
        toolName: "synap_list_installations",
        args,
        userId: A,
        apiKeyScopes: ["mcp.read"],
      } as never);
      const text = (res.content[0] as { text: string }).text;
      return JSON.parse(text) as {
        installations: Array<Record<string, unknown>>;
      };
    };
    const byComputer = await call({ computerId: DEVBOX });
    const byDevice = await call({ deviceId: devbox.id });
    expect(byComputer.installations).toHaveLength(1);
    expect(byDevice.installations).toEqual(byComputer.installations);
  });
});

describe("two processes report one computer (waker and host runner)", () => {
  const RUNNER = [...WRITE, "host.runner"];
  const capsOf = async () => {
    const { devices } = await fleetAs(B).list();
    return devices.find((d) => d.name === "box-b")!;
  };

  it("neither erases the other's capabilities, nor a section it left out", async () => {
    const waker = await post(computer(BOX_B, B), "/computers/me/report", {
      reporter: "waker",
      manifest: {
        manifestVersion: 1,
        resources: { memoryMb: 8192 },
        capabilities: ["wake.agent"],
      },
    });
    expect(waker.status).toBe(200);
    const host = await post(computer(BOX_B, B, RUNNER), "/host-jobs/lease", {
      manifest: { manifestVersion: 1, capabilities: ["serve.http"] },
    });
    expect(host.status).toBe(200);
    // The waker again, last: the host's capability stays.
    await post(computer(BOX_B, B), "/computers/me/report", {
      reporter: "waker",
      manifest: { manifestVersion: 1, capabilities: ["wake.agent"] },
    });
    const device = await capsOf();
    expect(device.capabilities).toEqual(["serve.http", "wake.agent"]);
    // The host's report carried no resources: the waker's are kept.
    expect(device.resources.memoryMb).toBe(8192);
  });

  it("a process that stopped reporting drops out after the TTL", async () => {
    await q(
      `UPDATE devices
         SET capability_reports = jsonb_set(capability_reports, '{host,at}',
               to_jsonb(to_char((now() - interval '2 hours') AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
       WHERE principal_user_id = $1`,
      [BOX_B]
    );
    expect((await capsOf()).capabilities).toEqual(["wake.agent"]);
  });
});

const reportsOf = async (principal: string) =>
  (
    await q<{
      capability_reports: Record<
        string,
        { capabilities: string[]; at: string }
      >;
      manifest: Record<string, unknown> | null;
      retired_at: string | null;
    }>(
      `SELECT capability_reports, manifest, retired_at FROM devices WHERE principal_user_id = $1`,
      [principal]
    )
  )[0]!;

describe("a live reporter keeps its capabilities", () => {
  it("two processes reporting out of phase both outlive the TTL", async () => {
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms);
    await recordDeviceReport({
      machineUserId: TWO,
      reporter: "host",
      manifest: { manifestVersion: 1, capabilities: ["serve.http"] },
      now: at(0),
    });
    await recordDeviceReport({
      machineUserId: TWO,
      reporter: "waker",
      manifest: { manifestVersion: 1, capabilities: ["wake.agent"] },
      now: at(10_000),
    });
    // Both keep polling every 30 s, 10 s apart, with nothing new to say:
    // within any minute only one of them could win a row-level slot.
    let ms = 30_000;
    for (; ms <= 32 * 60_000; ms += 30_000) {
      await recordDeviceReport({
        machineUserId: TWO,
        reporter: "host",
        now: at(ms),
      });
      await recordDeviceReport({
        machineUserId: TWO,
        reporter: "waker",
        now: at(ms + 10_000),
      });
    }
    const { capability_reports } = await reportsOf(TWO);
    expect(effectiveDeviceCapabilities(capability_reports, at(ms))).toEqual([
      "serve.http",
      "wake.agent",
    ]);
  });

  it("[] says the reporter has none; no list keeps its set and moves its time", async () => {
    const t0 = Date.now() + 60 * 60_000;
    await recordDeviceReport({
      machineUserId: TWO,
      reporter: "worker",
      manifest: { manifestVersion: 1, capabilities: ["run.tool"] },
      now: new Date(t0),
    });
    await recordDeviceReport({
      machineUserId: TWO,
      reporter: "worker",
      now: new Date(t0 + 2 * 60_000),
    });
    let worker = (await reportsOf(TWO)).capability_reports.worker!;
    expect(worker).toEqual({
      capabilities: ["run.tool"],
      at: new Date(t0 + 2 * 60_000).toISOString(),
    });
    await recordDeviceReport({
      machineUserId: TWO,
      reporter: "worker",
      manifest: { manifestVersion: 1, capabilities: [] },
      now: new Date(t0 + 4 * 60_000),
    });
    worker = (await reportsOf(TWO)).capability_reports.worker!;
    expect(worker.capabilities).toEqual([]);
  });
});

describe("two reports at once", () => {
  it("lose neither manifest section nor reporter entry", async () => {
    await ensureComputerDevice(RACE);
    const [worker, waker] = await Promise.all([
      recordDeviceReport({
        machineUserId: RACE,
        reporter: "worker",
        manifest: {
          manifestVersion: 1,
          resources: { memoryMb: 4096 },
          capabilities: ["run.tool"],
        },
      }),
      recordDeviceReport({
        machineUserId: RACE,
        reporter: "waker",
        manifest: {
          manifestVersion: 1,
          location: { site: "home" },
          capabilities: ["wake.agent"],
        },
      }),
    ]);
    expect(worker).toMatchObject({ recorded: true, manifest: "accepted" });
    expect(waker).toMatchObject({ recorded: true, manifest: "accepted" });
    const row = await reportsOf(RACE);
    expect(row.manifest).toMatchObject({
      identity: { hostname: "race" },
      resources: { memoryMb: 4096 },
      location: { site: "home" },
    });
    expect(Object.keys(row.capability_reports).sort()).toEqual([
      "waker",
      "worker",
    ]);
  });

  it("a device keeps at most 16 reporters, none past the TTL", async () => {
    const t0 = Date.now() + 2 * 60 * 60_000;
    for (let i = 0; i < 20; i++)
      await recordDeviceReport({
        machineUserId: RACE,
        reporter: `p${i}`,
        now: new Date(t0 + i * 1000),
      });
    const keys = Object.keys((await reportsOf(RACE)).capability_reports);
    // The two at the start of the test are hours old: gone. Of the 20, the
    // newest 16.
    expect(keys).toHaveLength(16);
    expect(keys).not.toContain("worker");
    expect(keys).not.toContain("p0");
    expect(keys).toContain("p19");
  });
});

describe("POST /box-runs/lease is the computer reporting", () => {
  it("a computer that only runs scripts reads online", async () => {
    const res = await post(
      computer(SCRIPTS, A, [...WRITE, "box.runner"]),
      "/box-runs/lease",
      {}
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { run: unknown }).run).toBeNull();
    const { devices } = await fleetAs(A).list();
    expect(devices.find((d) => d.name === "scripts")?.status).toBe("online");
  });
});

describe("a revoked computer retires its device; a reconnect brings it back", () => {
  it("revoke, then reconnect through the device flow's door", async () => {
    await ensureComputerDevice(OLD);
    await q(
      `INSERT INTO api_keys (id, user_id, key_name, key_prefix, key_hash, key_type, scope, is_active, usage_count, created_at)
       VALUES ($1, $2, 'old-box', 'synap_hub_live_', 'h', 'hub_inbound', '{hub-protocol.read}', true, 0, now())`,
      [randomUUID(), OLD]
    );
    await revokeMachine({ machineUserId: OLD, by: A });
    expect((await reportsOf(OLD)).retired_at).not.toBeNull();
    const names = async (includeRetired: boolean) =>
      (await fleetAs(A).list({ includeRetired })).devices.map((d) => d.name);
    expect(await names(false)).not.toContain("old-box");
    expect(await names(true)).toContain("old-box");

    // The terminal comes back as another host on the same computer.
    await ensureMachineAgent({
      approverId: A,
      reuseId: OLD,
      name: "old-box",
      hostname: "old-box-2",
      platform: "darwin",
    });
    const back = await reportsOf(OLD);
    expect(back.retired_at).toBeNull();
    expect(back.manifest).toMatchObject({
      identity: { hostname: "old-box-2", os: "darwin", arch: "x64" },
    });
    expect(await names(false)).toContain("old-box");
  });

  it("a reconnect that says nothing new writes nothing; a changed identity keeps the rest", async () => {
    await recordDeviceReport({
      machineUserId: OLD,
      manifest: { manifestVersion: 1, resources: { memoryMb: 1024 } },
    });
    const [before] = await q<{ updated_at: string }>(
      `SELECT updated_at::text AS updated_at FROM devices WHERE principal_user_id = $1`,
      [OLD]
    );
    await ensureComputerDevice(OLD);
    const [same] = await q<{ updated_at: string }>(
      `SELECT updated_at::text AS updated_at FROM devices WHERE principal_user_id = $1`,
      [OLD]
    );
    expect(same!.updated_at).toBe(before!.updated_at);
    await q(
      `UPDATE users SET agent_metadata = agent_metadata || '{"arch":"arm64"}'::jsonb WHERE id = $1`,
      [OLD]
    );
    await ensureComputerDevice(OLD);
    expect((await reportsOf(OLD)).manifest).toMatchObject({
      identity: { hostname: "old-box-2", os: "darwin", arch: "arm64" },
      resources: { memoryMb: 1024 },
    });
  });
});

describe("synap_list_agents: devices[] beside computers[]", () => {
  const listAgents = async () => {
    const res = await sessionHandlers.synap_list_agents!({
      toolName: "synap_list_agents",
      args: {},
      userId: A,
      apiKeyScopes: ["mcp.read"],
    } as never);
    return JSON.parse((res.content[0] as { text: string }).text) as {
      devices: Array<{ name: string }> | null;
      devicesError?: string;
      computers: unknown[];
    };
  };

  it("a person reads their devices", async () => {
    const out = await listAgents();
    expect(out.devicesError).toBeUndefined();
    expect(out.devices?.map((d) => d.name)).toContain("devbox");
  });

  it("a key whose grant does not read devices is told so, never handed []", async () => {
    h.grant = {
      scopes: [{ permissions: ["agent.read", "tool.read"] }],
      clientId: null,
    };
    try {
      const out = await listAgents();
      expect(out.devices).toBeNull();
      expect(out.devicesError).toMatch(/^Not granted/);
      expect(Array.isArray(out.computers)).toBe(true);
    } finally {
      h.grant = null;
    }
  });

  it("devicesReadableByGrant: a person, a full key, or one reading installations whole", () => {
    const key = (...scopes: Array<Record<string, unknown>>) =>
      ({ scopes, clientId: null }) as never;
    expect(devicesReadableByGrant(null)).toBe(true);
    expect(devicesReadableByGrant(key({ permissions: ["*"] }))).toBe(true);
    expect(
      devicesReadableByGrant(key({ permissions: ["installation.read"] }))
    ).toBe(true);
    expect(
      devicesReadableByGrant(
        key({ permissions: ["installation.read"], workspaceIds: [WS_SHARED] })
      )
    ).toBe(false);
    expect(devicesReadableByGrant(key({ permissions: ["agent.read"] }))).toBe(
      false
    );
    expect(devicesReadableByGrant(key({ permissions: [] }))).toBe(false);
  });
});
