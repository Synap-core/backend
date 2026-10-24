/**
 * control-plane-link — the pod's Control Plane link and plan (lane cp-link).
 *
 * Real enrollment record on disk (the file `synap register` / `synap pod-key
 * enroll` write), real `workspaces` + `pod_settings` tables on PGlite.
 *   - a pod registered through today's door reads its link from the record,
 *     with NO workspace record at all (the July orphan);
 *   - a pre-July pod with no record yet still reads its old link (legacy);
 *   - an unreadable record is an error, never "not linked";
 *   - a pulled plan is what the readers see; a failed pull keeps it;
 *   - the boot migration seeds the plan from the old record and clears the old
 *     record only once the pod is enrolled.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const h = vi.hoisted(() => ({ db: null as unknown, client: null as unknown }));

vi.mock("../../index.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client;
  h.db = drizzle(client);
  return { db: h.db };
});
vi.mock("../vault-resolver.js", () => ({ resolveVaultReferences: vi.fn() }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { workspaces } from "../../schema/workspaces.js";
import { podSettings } from "../../schema/pod-settings.js";
const link = await import("../control-plane-link.js");

type Q = {
  exec: (s: string) => Promise<unknown>;
  query: <T>(s: string, p?: unknown[]) => Promise<{ rows: T[] }>;
};
const q = () => h.client as Q;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid"
        ? " default gen_random_uuid()"
        : type.startsWith("timestamp")
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${def}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const dir = mkdtempSync(path.join(tmpdir(), "cp-link-"));
const ENROLL = path.join(dir, "pod-identity-enrollment.json");
const SAVED = process.env.SYNAP_POD_IDENTITY_ENROLLMENT_FILE;

/** The record `_podkey_record_enrollment` (synap) writes. */
const RECORD = {
  podId: "pod_lab",
  kid: "kid-1",
  issuer: "https://api.synap.live",
  controlPlaneUrl: "https://api.synap.live",
  enrolledAt: "2026-10-23T08:00:00Z",
};

const LEGACY = {
  url: "https://cp.old.test",
  podId: "pod_old",
  connectedAt: "2026-05-01T00:00:00Z",
  tier: "pro",
  trialEnd: "2026-06-01T00:00:00Z",
};

async function addWorkspace(settings: unknown) {
  await q().query(
    `insert into workspaces (id, name, settings) values (gen_random_uuid(), 'ws', $1::jsonb)`,
    [JSON.stringify(settings)]
  );
}
const workspaceRecords = async () =>
  (
    await q().query<{ cp: unknown }>(
      `select settings -> 'controlPlane' as cp from workspaces where settings -> 'controlPlane' is not null`
    )
  ).rows;
const podSettingsBlob = async () =>
  (
    await q().query<{ settings: Record<string, unknown> }>(
      `select settings from pod_settings`
    )
  ).rows[0]?.settings;

beforeAll(async () => {
  await q().exec(ddlFor(workspaces as unknown as PgTable));
  await q().exec(ddlFor(podSettings as unknown as PgTable));
  process.env.SYNAP_POD_IDENTITY_ENROLLMENT_FILE = ENROLL;
}, 60_000);

afterAll(() => {
  if (SAVED === undefined)
    delete process.env.SYNAP_POD_IDENTITY_ENROLLMENT_FILE;
  else process.env.SYNAP_POD_IDENTITY_ENROLLMENT_FILE = SAVED;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(ENROLL, { force: true });
  await q().exec(`delete from workspaces; delete from pod_settings;`);
});

describe("readControlPlaneLink", () => {
  it("a pod registered through today's door reads its link from the enrollment record — no workspace record needed", async () => {
    writeFileSync(ENROLL, JSON.stringify(RECORD));
    await addWorkspace({ theme: "light" });
    expect(await link.readControlPlaneLink()).toEqual({
      podId: "pod_lab",
      url: "https://api.synap.live",
      issuer: "https://api.synap.live",
      since: "2026-10-23T08:00:00Z",
      source: "enrollment",
    });
  });

  it("a pre-July pod with no enrollment record yet reads its old link (legacy)", async () => {
    await addWorkspace({ controlPlane: LEGACY });
    expect(await link.readControlPlaneLink()).toEqual({
      podId: "pod_old",
      url: "https://cp.old.test",
      issuer: "https://cp.old.test",
      since: "2026-05-01T00:00:00Z",
      source: "legacy",
    });
  });

  it("a self-hosted pod that never registered has no link", async () => {
    await addWorkspace({ theme: "light" });
    expect(await link.readControlPlaneLink()).toBeNull();
  });

  it("an unreadable enrollment record is an error, never 'not linked'", async () => {
    writeFileSync(ENROLL, "{not json");
    await expect(link.readControlPlaneLink()).rejects.toThrow();
  });
});

describe("the plan (pod_settings.settings.controlPlaneEntitlement)", () => {
  it("absent until the CP answers", async () => {
    expect(await link.readControlPlaneEntitlement()).toBeNull();
  });

  it("a pull is what the readers see, beside the other pod settings", async () => {
    await q().query(
      `insert into pod_settings (settings) values ('{"podApps":{"allowUnverified":true}}'::jsonb)`
    );
    await link.recordControlPlaneEntitlement(
      {
        tier: "pro",
        status: "trialing",
        trialEnd: "2026-11-01T00:00:00.000Z",
        lab: false,
      },
      new Date("2026-10-23T10:00:00.000Z")
    );
    expect(await link.readControlPlaneEntitlement()).toEqual({
      tier: "pro",
      status: "trialing",
      trialEnd: "2026-11-01T00:00:00.000Z",
      lab: false,
      source: "pull",
      checkedAt: "2026-10-23T10:00:00.000Z",
    });
    expect((await podSettingsBlob())?.podApps).toEqual({
      allowUnverified: true,
    });
  });

  it("a failed pull records why and keeps the last good plan", async () => {
    await link.recordControlPlaneEntitlement({
      tier: "team",
      status: "active",
      trialEnd: null,
      lab: false,
    });
    await link.recordControlPlaneEntitlementFailure(
      "unreachable",
      "The Control Plane could not be reached."
    );
    expect((await link.readControlPlaneEntitlement())?.tier).toBe("team");
    expect(await link.readControlPlaneEntitlementSync()).toMatchObject({
      outcome: "unreachable",
    });
  });
});

describe("migrateLegacyControlPlaneRecord", () => {
  it("seeds the plan from the old record and keeps it while the pod is not enrolled", async () => {
    await addWorkspace({ controlPlane: LEGACY, theme: "dark" });
    expect(await link.migrateLegacyControlPlaneRecord()).toEqual({
      planSeeded: true,
      workspacesCleared: 0,
    });
    expect(await link.readControlPlaneEntitlement()).toEqual({
      tier: "pro",
      status: null,
      trialEnd: "2026-06-01T00:00:00Z",
      lab: false,
      source: "legacy",
      checkedAt: null,
    });
    expect(await workspaceRecords()).toHaveLength(1);
  });

  it("clears the old record from every workspace once the pod is enrolled; never over a pulled plan", async () => {
    writeFileSync(ENROLL, JSON.stringify(RECORD));
    await addWorkspace({ controlPlane: LEGACY, theme: "dark" });
    await addWorkspace({ controlPlane: { podId: "pod_old" } });
    await link.recordControlPlaneEntitlement({
      tier: "team",
      status: "active",
      trialEnd: null,
      lab: false,
    });
    expect(await link.migrateLegacyControlPlaneRecord()).toEqual({
      planSeeded: false,
      workspacesCleared: 2,
    });
    expect(await workspaceRecords()).toHaveLength(0);
    expect((await link.readControlPlaneEntitlement())?.tier).toBe("team");
    const themes = (
      await q().query<{ t: string }>(
        `select settings ->> 'theme' as t from workspaces`
      )
    ).rows.map((r) => r.t);
    expect(themes).toContain("dark");
    // Idempotent: nothing left to migrate.
    expect(await link.migrateLegacyControlPlaneRecord()).toEqual({
      planSeeded: false,
      workspacesCleared: 0,
    });
  });
});
