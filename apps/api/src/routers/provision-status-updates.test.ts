/**
 * The SEAM: `GET /api/provision/status` (the route the CP health poll already
 * calls) carries the `updates` section — settings + last outcome — read from
 * the real pod_settings reader and the real last-update.json reader, and
 * nothing secret. The DB/IS edges are stubbed; `pod-updates/index.ts` and the
 * route handler are real.
 *
 * Who reads what (W9-UPDATE): the details go to the CP (a verified CP JWT) or a
 * pod admin's session; anyone else gets the restricted liveness answer.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/pod-updates-status-${process.pid}-${Date.now()}`;
  process.env.SYNAP_LAST_UPDATE_PATH = `${dir}/last-update.json`;
  return {
    dir,
    settings: undefined as unknown,
    settingsFails: false,
    probes: 0,
    jwtOk: true,
    jwtOpts: [] as unknown[],
    session: null as null | { identity: { id: string } },
    admin: false,
  };
});

vi.mock("@synap-core/core", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return { createLogger: () => log };
});
vi.mock("bcrypt", () => ({ default: {} }));
vi.mock("./pod-updates-deps.js", () => ({
  readPodUpdateSettingsRaw: async () => {
    if (h.settingsFails) throw new Error("db down");
    return h.settings;
  },
}));
vi.mock("./provision-intelligence-probe.js", () => ({
  probeIntelligenceService: async () => {
    h.probes++;
    return { reachable: false };
  },
}));
vi.mock("@synap/auth", () => ({
  getSession: async () => h.session,
}));
vi.mock("./account-recovery-deps.js", () => ({
  findAccountByIdentity: async (id: string) => ({ userId: `user-of-${id}` }),
  isPodAdmin: async () => h.admin,
}));
vi.mock("@synap/api", () => ({
  // Mirrors the real contract (@synap/api jwks-client): PUBLIC_URL, no trailing slash.
  podAudience: () => process.env.PUBLIC_URL?.replace(/\/+$/, "") || null,
  createAndVerifyHubInboundKey: vi.fn(),
  encryptServiceKey: vi.fn(),
  describeServingIntelligence: async () => ({
    service: null,
    url: "http://is.invalid",
    source: "env",
  }),
  envIntelligenceEndpoint: vi.fn(),
  getSyncGenerationState: async () => ({
    splitBrainDetected: false,
    role: "primary",
  }),
  resolveServiceKey: vi.fn(),
  toRegistrationTrace: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(async (_token: string, opts: unknown) => {
    h.jwtOpts.push(opts);
    return h.jwtOk
      ? { iss: "https://api.synap.live", type: "pod-status" }
      : null;
  }),
}));
vi.mock("@synap/database", () => ({
  getDb: async () => ({
    query: {
      workspaces: {
        findFirst: async () => ({
          settings: {
            controlPlane: {
              url: "https://api.synap.live",
              podId: "pod-secret-id",
              cpApiKey: "k",
              connectedAt: "2026-10-01T00:00:00Z",
              lastPingAt: null,
            },
          },
        }),
      },
    },
  }),
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  drizzleSql: vi.fn(),
  EventRepository: vi.fn(),
  ApiKeyRepository: vi.fn(),
  TrustedIssuerService: vi.fn(),
}));
vi.mock("@synap/database/api-key-revocation", () => ({
  revokeApiKeys: vi.fn(),
}));
vi.mock("@synap/database/schema", () => ({
  workspaces: {},
  intelligenceServices: {},
  users: {},
  workspaceMembers: {},
  apiKeys: {},
}));

const { provisionRouter } = await import("./provision.js");

process.env.PUBLIC_URL = "https://pod.example.com";

/** As the CP reads it: a CP-signed JWT (the pod verifies it). */
async function status() {
  const res = await provisionRouter.request("/status", {
    headers: { Authorization: "Bearer cp-signed" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown> & {
    updates: {
      settings: { auto: boolean; channel: string; explicit: boolean } | null;
      settingsRead: string;
      lastUpdate: { read: string; outcome?: Record<string, unknown> };
    };
  };
}

beforeEach(() => {
  h.settings = undefined;
  h.settingsFails = false;
  h.probes = 0;
  h.jwtOk = true;
  h.jwtOpts = [];
  h.session = null;
  h.admin = false;
});

describe("GET /api/provision/status → who reads the details", () => {
  // Catches: the pod id, the IS URL, the version or the update history leaking
  // to an anonymous caller, or an anonymous request making the pod call out.
  it("anyone: liveness only — restricted, no identifier, no URL, no probe", async () => {
    const res = await provisionRouter.request("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.restricted).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.connectionState).toBe("partial");
    expect(body.connectionIssues).toContain("hub_not_registered");
    for (const k of [
      "controlPlane",
      "updates",
      "podVersion",
      "serviceProbe",
      "courier",
      "splitBrain",
      "podRole",
    ]) {
      expect(body, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(body)).not.toContain("pod-secret-id");
    expect(JSON.stringify(body)).not.toContain("is.invalid");
    expect(h.probes).toBe(0);
  });

  it("the CP: details, through the one trusted-issuer door with a typed token", async () => {
    const body = await status();
    expect(body.restricted).toBeUndefined();
    expect((body.controlPlane as { podId: string }).podId).toBe(
      "pod-secret-id"
    );
    expect(h.probes).toBe(1);
    expect(h.jwtOpts[0]).toMatchObject({
      pinnedIssuer: "https://api.synap.live",
      audience: "https://pod.example.com",
      expectedType: ["pod-status", "provision"],
    });
  });

  it("a refused Bearer token is a 401, never the public answer", async () => {
    h.jwtOk = false;
    const res = await provisionRouter.request("/status", {
      headers: { Authorization: "Bearer forged" },
    });
    expect(res.status).toBe(401);
  });

  it("a pod admin's session: details; any other session: liveness only", async () => {
    h.session = { identity: { id: "ident-1" } };
    h.admin = true;
    const admin = (await (
      await provisionRouter.request("/status", {
        headers: { "x-session-token": "t" },
      })
    ).json()) as Record<string, unknown>;
    expect(admin.restricted).toBeUndefined();
    expect(admin).toHaveProperty("updates");

    h.admin = false;
    const member = (await (
      await provisionRouter.request("/status", {
        headers: { "x-session-token": "t" },
      })
    ).json()) as Record<string, unknown>;
    expect(member.restricted).toBe(true);
    expect(member).not.toHaveProperty("updates");
  });
});

describe("GET /api/provision/status → updates", () => {
  it("a fresh pod reports auto ON and no recorded update", async () => {
    const body = await status();
    expect(body.updates.settings).toEqual({
      auto: true,
      channel: "stable",
      explicit: false,
    });
    expect(body.updates.lastUpdate).toEqual({ read: "absent" });
  });

  it("carries the owner's choice and the engine's last outcome, metadata only", async () => {
    h.settings = {
      auto: false,
      channel: "fast",
      updatedAt: "2026-10-04T00:00:00Z",
    };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(
      join(h.dir, "last-update.json"),
      JSON.stringify({
        ts: "2026-10-04T12:00:00Z",
        status: "rolled_back",
        from: "v1",
        to: "v2",
        reason: "backend migration failed",
        dbRestored: true,
        backup: "/opt/synap/backups/pre-update.dump",
        pod: "perso.synap.live",
      })
    );
    const body = await status();
    expect(body.updates.settings).toEqual({
      auto: false,
      channel: "fast",
      explicit: true,
    });
    expect(body.updates.lastUpdate.read).toBe("ok");
    expect(body.updates.lastUpdate.outcome?.status).toBe("rolled_back");
    // No secret / host path leaves the pod through the public status.
    const raw = JSON.stringify(body.updates);
    expect(raw).not.toContain("/opt/synap/backups");
    expect(raw).not.toMatch(/apiKey|secret|password|token/i);
  });

  // Catches: a failed settings read folded into auto:true on the CP's input.
  it("a failed settings read is reported as failed, not as the default", async () => {
    h.settingsFails = true;
    const body = await status();
    expect(body.updates.settings).toBeNull();
    expect(body.updates.settingsRead).toBe("failed");
  });
});
