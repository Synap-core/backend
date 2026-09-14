import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * `resolveBroker` — which broker answers a `nango://` call.
 *
 * The rule under test:
 *  - "brokered by a Control Plane" is SERVER env (`CONTROL_PLANE_URL`), never
 *    workspace settings — an editor cannot plant a URL or erase managed status;
 *  - the relay credential is sent ONLY to the configured CP URL;
 *  - a brokered pod consults no local key tier (env, legacy, vault) and a vault
 *    FAULT cannot pre-empt the CP; `SYNAP_CONNECTOR_BROKER=local` opts out;
 *  - the credential is the longest-lived of the recent SEEDED relay rows;
 *  - an expired or missing credential is a legible fault, never "not configured".
 *
 * Driven through the real resolver with only the storage edges mocked (workspace
 * row, vault read, source_configs query — whose where/orderBy/limit are honored,
 * so row selection is tested, not assumed) and `config.server.controlPlaneUrl`.
 */

type RelayRow = {
  providerType: string;
  name: string;
  enabled: boolean;
  createdAt: Date;
  userId: string;
  config: Record<string, unknown>;
};

const h = vi.hoisted(() => ({
  controlPlaneUrl: undefined as string | undefined,
  settings: {} as Record<string, unknown>,
  vault: { ok: false, reason: "absent", error: "absent" } as
    | { ok: true; config: Record<string, string> }
    | { ok: false; reason: string; error: string },
  relayRows: [] as RelayRow[],
  vaultValues: {} as Record<string, string>,
  upserts: [] as unknown[],
}));

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  const server = new Proxy(actual.config.server, {
    get: (target, prop) =>
      prop === "controlPlaneUrl"
        ? h.controlPlaneUrl
        : (target as Record<string | symbol, unknown>)[prop],
  });
  return { ...actual, config: { ...actual.config, server } };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const workspaces = {
    findFirst: async () => ({
      id: "ws-1",
      ownerId: "owner-1",
      settings: h.settings,
    }),
  };
  const sourceConfigs = {
    findMany: async (opts: {
      where: (
        t: Record<string, string>,
        ops: Record<string, unknown>
      ) => unknown;
      orderBy: (
        t: Record<string, string>,
        ops: Record<string, unknown>
      ) => unknown[];
      limit?: number;
    }) => {
      const cols = {
        providerType: "providerType",
        name: "name",
        enabled: "enabled",
        createdAt: "createdAt",
      };
      const conds = [
        opts.where(cols, {
          and: (...c: unknown[]) => c,
          eq: (col: string, val: unknown) => ({ col, val }),
        }),
      ].flat(2) as Array<{ col: keyof RelayRow; val: unknown }>;
      const [dir] = opts.orderBy(cols, {
        asc: () => "asc",
        desc: () => "desc",
      }) as string[];
      const rows = h.relayRows
        .filter((r) => conds.every((c) => r[c.col] === c.val))
        .sort((a, b) =>
          dir === "desc"
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime()
        );
      return rows.slice(0, opts.limit ?? rows.length);
    },
  };
  const fakeDb = { query: { workspaces, sourceConfigs } };
  return {
    ...actual,
    db: fakeDb,
    getDb: async () => fakeDb,
    getServiceSecretResult: async () => h.vault,
    isServerVaultAvailable: () => true,
    upsertServiceSecret: async (...args: unknown[]) => {
      h.upserts.push(args);
    },
    resolveVaultReferences: async (config: Record<string, string>) => ({
      relayKey: h.vaultValues[config.relayKey!] ?? "",
    }),
  };
});

import { migrateNangoEnvToVault, resolveBroker } from "./index.js";

const CP = "https://cp.synap.live";

/** An unsigned JWT-shaped string whose `exp` is `days` from now (negative = past). */
function jwtWithExp(days: number): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + days * 86_400;
  return `${enc({ alg: "ES256" })}.${enc({ type: "pod_relay", podId: "pod-1", exp })}.sig`;
}

function seededRow(
  ref: string,
  createdAt: string,
  name = "Synap Relay (CP-managed)"
): RelayRow {
  return {
    providerType: "cp-relay",
    name,
    enabled: true,
    createdAt: new Date(createdAt),
    userId: "owner-1",
    config: { relayKey: ref },
  };
}

const savedEnv = { ...process.env };

beforeEach(() => {
  h.controlPlaneUrl = undefined;
  h.settings = {};
  h.vault = { ok: false, reason: "absent", error: "absent" };
  h.relayRows = [];
  h.vaultValues = {};
  h.upserts = [];
  for (const k of [
    "NANGO_SECRET_KEY",
    "CP_RELAY_KEY",
    "SOURCE_RELAY_KEY",
    "SYNAP_CONNECTOR_BROKER",
  ]) {
    delete process.env[k];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
  vi.unstubAllGlobals();
});

function brokeredWithValidKey() {
  h.controlPlaneUrl = CP;
  h.relayRows = [seededRow("vault://k", "2026-09-01")];
  h.vaultValues = { "vault://k": jwtWithExp(10) };
}

describe("resolveBroker — who is brokered", () => {
  it("CONTROL_PLANE_URL set → the CP broker", async () => {
    brokeredWithValidKey();
    const r = await resolveBroker("nango");
    expect(r.ok && r.source).toBe("control-plane");
  });

  it("an editor-planted settings.controlPlane.url never receives the relay key", async () => {
    brokeredWithValidKey();
    h.settings = { controlPlane: { podId: "pod-1", url: "https://evil.tld" } };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await resolveBroker("nango");
    expect(r.ok).toBe(true);
    if (r.ok) await r.broker.probe();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith(`${CP}/api/connector-broker/`))).toBe(
      true
    );
    expect(urls.some((u) => u.includes("evil.tld"))).toBe(false);
  });

  it("controlPlane erased from settings does not un-manage the pod (env key present)", async () => {
    brokeredWithValidKey();
    h.settings = {};
    process.env.NANGO_SECRET_KEY = "shared-host-key";
    const r = await resolveBroker("nango");
    expect(r.ok && r.broker.mode).toBe("cp");
  });

  it("a nango vault FAULT does not pre-empt the CP broker", async () => {
    brokeredWithValidKey();
    h.vault = { ok: false, reason: "undecryptable", error: "bad key" };
    const r = await resolveBroker("nango");
    expect(r.ok && r.source).toBe("control-plane");
  });

  it("a vaulted Nango key does not silently take over a brokered pod", async () => {
    brokeredWithValidKey();
    h.vault = { ok: true, config: { secretKey: "own-key" } };
    const r = await resolveBroker("nango");
    expect(r.ok && r.broker.mode).toBe("cp");
  });

  it("SYNAP_CONNECTOR_BROKER=local opts a CP-connected pod out to its own vault key", async () => {
    brokeredWithValidKey();
    process.env.SYNAP_CONNECTOR_BROKER = "local";
    h.vault = { ok: true, config: { secretKey: "own-key" } };
    const r = await resolveBroker("nango");
    expect(r.ok && r.source).toBe("vault");
  });

  it("no CONTROL_PLANE_URL → own env key, even if settings claim a controlPlane", async () => {
    h.settings = { controlPlane: { podId: "pod-1", url: CP } };
    process.env.NANGO_SECRET_KEY = "self-hosted-key";
    const r = await resolveBroker("nango");
    expect(r.ok && r.source).toBe("env");
  });

  it("nothing configured anywhere → not-configured", async () => {
    expect(await resolveBroker("nango")).toMatchObject({
      ok: false,
      reason: "not-configured",
    });
  });

  it("an unknown scheme is refused", async () => {
    expect(await resolveBroker("composio")).toMatchObject({
      ok: false,
      reason: "unsupported-scheme",
    });
  });
});

describe("resolveBroker — which relay credential", () => {
  it("a brokered pod with NO seeded relay row is a fault, never 'not configured'", async () => {
    h.controlPlaneUrl = CP;
    expect(await resolveBroker("nango")).toMatchObject({
      ok: false,
      reason: "broker-credential-missing",
    });
  });

  it("no relay credential but the pod holds its OWN Nango key → the fault names the SYNAP_CONNECTOR_BROKER=local opt-out", async () => {
    h.controlPlaneUrl = CP;
    process.env.NANGO_SECRET_KEY = "self-hosted-key";
    const viaEnv = await resolveBroker("nango");
    expect(viaEnv).toMatchObject({
      ok: false,
      reason: "broker-credential-missing",
    });
    if (!viaEnv.ok) {
      expect(viaEnv.error).toContain("SYNAP_CONNECTOR_BROKER=local");
      expect(viaEnv.error).not.toMatch(/Rotate the pod's relay key/);
    }

    delete process.env.NANGO_SECRET_KEY;
    h.vault = { ok: true, config: { secretKey: "own-key" } };
    const viaVault = await resolveBroker("nango");
    if (!viaVault.ok)
      expect(viaVault.error).toContain("SYNAP_CONNECTOR_BROKER=local");
    expect(viaVault.ok).toBe(false);
  });

  it("no relay credential and no local key → the fault says to rotate the relay key (positive control)", async () => {
    h.controlPlaneUrl = CP;
    const r = await resolveBroker("nango");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Rotate the pod's relay key/);
      expect(r.error).not.toContain("SYNAP_CONNECTOR_BROKER");
    }
  });

  it("an admin-created cp-relay row under another name is never the broker credential", async () => {
    h.controlPlaneUrl = CP;
    h.relayRows = [seededRow("vault://admin", "2026-09-10", "My relay")];
    h.vaultValues = { "vault://admin": jwtWithExp(25) };
    expect(await resolveBroker("nango")).toMatchObject({
      ok: false,
      reason: "broker-credential-missing",
    });
  });

  it("of the recent seeded rows, the longest-lived key wins — not merely the newest row", async () => {
    h.controlPlaneUrl = CP;
    h.relayRows = [
      seededRow("vault://old", "2026-08-01"),
      seededRow("vault://newest-but-short", "2026-09-10"),
      seededRow("vault://long", "2026-09-05"),
    ];
    h.vaultValues = {
      "vault://old": jwtWithExp(-1),
      "vault://newest-but-short": jwtWithExp(2),
      "vault://long": jwtWithExp(20),
    };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await resolveBroker("nango");
    expect(r.ok).toBe(true);
    if (r.ok) await r.broker.probe();
    const auth = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(auth.Authorization).toBe(`Bearer ${h.vaultValues["vault://long"]}`);
  });

  it("an EXPIRED relay key is a legible fault naming the expiry", async () => {
    h.controlPlaneUrl = CP;
    h.relayRows = [seededRow("vault://only", "2026-08-01")];
    h.vaultValues = { "vault://only": jwtWithExp(-2) };
    const r = await resolveBroker("nango");
    expect(r).toMatchObject({ ok: false, reason: "broker-credential-missing" });
    if (!r.ok) expect(r.error).toMatch(/credential expired on \d{4}-/);
  });

  it("a seeded relay row whose vault reference does not resolve is its own fault, never 'credential missing' or a database fault", async () => {
    h.controlPlaneUrl = CP;
    h.relayRows = [seededRow("vault://sealed", "2026-09-01")];
    // No `vaultValues` entry: the mocked resolver maps it to "" exactly as
    // `resolveVaultReferences` does for an unavailable vault or missing secret.
    const r = await resolveBroker("nango");
    expect(r).toMatchObject({ ok: false, reason: "vault-unresolved" });
    if (!r.ok) expect(r.error).toMatch(/re-delivers a readable key/);
  });
});

describe("migrateNangoEnvToVault on a brokered pod", () => {
  it("refuses — the env key there is the shared host key", async () => {
    h.controlPlaneUrl = CP;
    process.env.NANGO_SECRET_KEY = "shared-host-key";
    expect(await migrateNangoEnvToVault()).toEqual({
      migrated: false,
      reason: "control-plane-brokered",
    });
    expect(h.upserts).toHaveLength(0);
  });

  it("still migrates on a self-hosted pod (positive control)", async () => {
    process.env.NANGO_SECRET_KEY = "self-hosted-key";
    expect(await migrateNangoEnvToVault()).toEqual({
      migrated: true,
      reason: "migrated",
    });
    expect(h.upserts).toHaveLength(1);
  });
});
