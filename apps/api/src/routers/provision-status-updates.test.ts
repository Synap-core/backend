/**
 * The SEAM: `GET /api/provision/status` (the route the CP health poll already
 * calls) carries the `updates` section — settings + last outcome — read from
 * the real pod_settings reader and the real last-update.json reader, and
 * nothing secret. The DB/IS edges are stubbed; `pod-updates/index.ts` and the
 * route handler are real.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/pod-updates-status-${process.pid}-${Date.now()}`;
  process.env.SYNAP_LAST_UPDATE_PATH = `${dir}/last-update.json`;
  return { dir, settings: undefined as unknown, settingsFails: false };
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
  probeIntelligenceService: async () => ({ reachable: false }),
}));
vi.mock("@synap/api", () => ({
  createAndVerifyHubInboundKey: vi.fn(),
  encryptServiceKey: vi.fn(),
  describeServingIntelligence: async () => ({
    service: null,
    url: "http://is.invalid",
    source: "env",
  }),
  envIntelligenceEndpoint: vi.fn(),
  getSyncGenerationState: async () => ({ splitBrainDetected: false, role: "primary" }),
  resolveServiceKey: vi.fn(),
  toRegistrationTrace: vi.fn(),
  verifyTrustedIssuerJwt: vi.fn(),
}));
vi.mock("@synap/database", () => ({
  getDb: async () => ({
    query: { workspaces: { findFirst: async () => ({ settings: {} }) } },
  }),
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  drizzleSql: vi.fn(),
  EventRepository: vi.fn(),
  ApiKeyRepository: vi.fn(),
  TrustedIssuerService: vi.fn(),
}));
vi.mock("@synap/database/api-key-revocation", () => ({ revokeApiKeys: vi.fn() }));
vi.mock("@synap/database/schema", () => ({
  workspaces: {},
  intelligenceServices: {},
  users: {},
  workspaceMembers: {},
  apiKeys: {},
}));

const { provisionRouter } = await import("./provision.js");

async function status() {
  const res = await provisionRouter.request("/status");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown> & {
    updates: {
      settings: { auto: boolean; channel: string; explicit: boolean } | null;
      settingsRead: string;
      lastUpdate: { read: string; outcome?: Record<string, unknown> };
    };
  };
}

describe("GET /api/provision/status → updates", () => {
  beforeEach(() => {
    h.settings = undefined;
    h.settingsFails = false;
  });

  it("a fresh pod reports auto ON and no recorded update", async () => {
    const body = await status();
    expect(body.updates.settings).toEqual({ auto: true, channel: "stable", explicit: false });
    expect(body.updates.lastUpdate).toEqual({ read: "absent" });
  });

  it("carries the owner's choice and the engine's last outcome, metadata only", async () => {
    h.settings = { auto: false, channel: "fast", updatedAt: "2026-10-04T00:00:00Z" };
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
    expect(body.updates.settings).toEqual({ auto: false, channel: "fast", explicit: true });
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
