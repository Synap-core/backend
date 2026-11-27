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
 *     `computerId`, through the MCP door itself (`synap_list_installations`).
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
import { registerComputerReportRoutes } from "../../routers/hub-protocol/rest/computer-report.js";
import { registerHostJobsRoutes } from "../../routers/hub-protocol/rest/host-jobs.js";
import { fleetRouter } from "../../routers/fleet.js";
import { installationHandlers } from "../../routers/mcp/handlers/installations.js";
import { AccessContext } from "../../access/index.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";
import { computerFromDeviceArgs, ensureComputerDevice } from "./devices.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params).then((r) => r.rows);

const A = "person-a";
const B = "person-b";
const DEVBOX = "machine-devbox";
const MAC = "machine-mac";
const BOX_B = "machine-b";
const AGENT = "agent-a";
const HOSTED = "agent-on-devbox";
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
    expect(await ensureComputerDevice(DEVBOX)).toBe(before.id);
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
