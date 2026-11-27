import { describe, expect, it } from "vitest";
import {
  DEVICE_CAPABILITY_TTL_MS,
  DEVICE_KINDS,
  DEVICE_KIND_PARAMETERS,
  DEVICE_ONLINE_WINDOW_MS,
  DeviceConnectionSchema,
  buildDeviceTree,
  deriveDeviceStatus,
  effectiveDeviceCapabilities,
  mergeDeviceManifest,
  parseDeviceManifest,
  recordCapabilityReport,
  summarizeDeviceResources,
} from "./index.js";

const FULL = {
  manifestVersion: 1,
  identity: {
    vendor: "Apple",
    model: "MacBookPro18,1",
    os: "darwin",
    arch: "arm64",
    hostname: "mac",
  },
  resources: {
    cpu: { model: "Apple M1 Pro", cores: 10 },
    memoryMb: 32768,
    gpus: [{ model: "Apple M1 Pro", vramMb: 0 }],
    disks: [
      { mount: "/", sizeMb: 1000, freeMb: 250, fs: "apfs", tier: "nvme" },
      { mount: "/data", sizeMb: 3000, freeMb: 2750 },
    ],
  },
  capabilities: ["run.tool", "wake.agent", "print.3d"],
  parameters: { anything: { nested: true } },
  location: { site: "home", network: "tailnet" },
  health: { state: "ok", checkedAt: "2026-11-27T10:00:00Z" },
};

describe("device manifest v1", () => {
  it("accepts a full manifest and keeps every section", () => {
    const r = parseDeviceManifest(FULL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.identity?.hostname).toBe("mac");
    expect(r.manifest.resources?.disks).toHaveLength(2);
    expect(r.manifest.capabilities).toEqual([
      "run.tool",
      "wake.agent",
      "print.3d",
    ]);
    expect(r.manifest.parameters).toEqual({ anything: { nested: true } });
    expect(r.manifest.health?.state).toBe("ok");
  });

  it("accepts the smallest manifest: a version and nothing else", () => {
    expect(parseDeviceManifest({ manifestVersion: 1 }).ok).toBe(true);
  });

  it("refuses another version, naming the field", () => {
    const r = parseDeviceManifest({ ...FULL, manifestVersion: 2 });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/^manifestVersion:/);
    expect(parseDeviceManifest({ identity: {} }).ok).toBe(false);
    expect(parseDeviceManifest(null).ok).toBe(false);
  });

  it("refuses a bad resource with the path of the field", () => {
    const r = parseDeviceManifest({
      manifestVersion: 1,
      resources: { disks: [{ mount: "/", sizeMb: -1, freeMb: 0 }] },
    });
    expect(!r.ok && r.error).toMatch(/^resources\.disks\.0\.sizeMb:/);
  });

  it("refuses a capability that is not dotted words", () => {
    for (const bad of ["run", "Run.Tool", "run tool", ".run"]) {
      expect(
        parseDeviceManifest({ manifestVersion: 1, capabilities: [bad] }).ok,
        bad
      ).toBe(false);
    }
    // A name the pod does not list is accepted: a driver declares its own.
    expect(
      parseDeviceManifest({
        manifestVersion: 1,
        capabilities: ["scan.document"],
      }).ok
    ).toBe(true);
  });

  it("drops unknown top-level keys instead of refusing them", () => {
    const r = parseDeviceManifest({ manifestVersion: 1, futureField: 1 });
    expect(r.ok && "futureField" in r.manifest).toBe(false);
  });

  it("checks a known kind's parameters, and only for that kind", () => {
    expect(DEVICE_KIND_PARAMETERS.printer).toBeDefined();
    const bad = { manifestVersion: 1, parameters: { bedMm: { x: -5, y: 1 } } };
    const asPrinter = parseDeviceManifest(bad, { kind: "printer" });
    expect(!asPrinter.ok && asPrinter.error).toMatch(/^parameters\.bedMm\.x:/);
    // The same parameters on a kind with no schema are a free-form record.
    expect(parseDeviceManifest(bad, { kind: "sensor" }).ok).toBe(true);
    // An unknown kind (a new one, no release yet) is free-form too.
    expect(parseDeviceManifest(bad, { kind: "drone" }).ok).toBe(true);
    // A known kind keeps the keys its schema does not name.
    const ok = parseDeviceManifest(
      { manifestVersion: 1, parameters: { bedMm: { x: 220, y: 220 }, k: 1 } },
      { kind: "printer" }
    );
    expect(ok.ok && ok.manifest.parameters).toEqual({
      bedMm: { x: 220, y: 220 },
      k: 1,
    });
  });

  it("refuses a manifest over the size limit", () => {
    const r = parseDeviceManifest({
      manifestVersion: 1,
      parameters: { blob: "x".repeat(70_000) },
    });
    expect(!r.ok && r.error).toMatch(/larger than/);
  });

  it("lists the ten kinds of the plan", () => {
    expect([...DEVICE_KINDS]).toEqual([
      "computer",
      "vm",
      "container",
      "cloud_server",
      "storage",
      "phone",
      "printer",
      "camera",
      "sensor",
      "other",
    ]);
  });

  it("reads each connection mode and refuses a bridge with no driver", () => {
    for (const c of [
      { mode: "agent" },
      { mode: "bridge", viaDeviceId: "d1", driver: "proxmox" },
      { mode: "provider", leaseId: "l1" },
      { mode: "manual" },
    ])
      expect(DeviceConnectionSchema.safeParse(c).success, c.mode).toBe(true);
    expect(
      DeviceConnectionSchema.safeParse({ mode: "bridge", viaDeviceId: "d1" })
        .success
    ).toBe(false);
    expect(DeviceConnectionSchema.safeParse({ mode: "usb" }).success).toBe(
      false
    );
  });
});

describe("deriveDeviceStatus", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("unknown when it never reported", () => {
    expect(deriveDeviceStatus({ lastReportAt: null }, now)).toBe("unknown");
  });
  it("online inside the window, offline past it", () => {
    expect(deriveDeviceStatus({ lastReportAt: ago(30_000) }, now)).toBe(
      "online"
    );
    expect(
      deriveDeviceStatus({ lastReportAt: ago(DEVICE_ONLINE_WINDOW_MS + 1) }, now)
    ).toBe("offline");
  });
  it("degraded when it reports and says so; a stale degraded is offline", () => {
    const manifest = { health: { state: "failing" } };
    expect(
      deriveDeviceStatus({ lastReportAt: ago(1000), manifest }, now)
    ).toBe("degraded");
    expect(
      deriveDeviceStatus(
        { lastReportAt: ago(DEVICE_ONLINE_WINDOW_MS * 2), manifest },
        now
      )
    ).toBe("offline");
  });
  it("offline when retired, whatever it last said", () => {
    expect(
      deriveDeviceStatus(
        { lastReportAt: ago(1000), retiredAt: ago(500) },
        now
      )
    ).toBe("offline");
  });
});

describe("summarizeDeviceResources", () => {
  it("sums the disks and rounds the used percent", () => {
    const r = parseDeviceManifest(FULL);
    if (!r.ok) throw new Error(r.error);
    expect(summarizeDeviceResources(r.manifest)).toEqual({
      cpuModel: "Apple M1 Pro",
      cpuCores: 10,
      memoryMb: 32768,
      gpus: [{ model: "Apple M1 Pro", vramMb: 0 }],
      diskSizeMb: 4000,
      diskFreeMb: 3000,
      diskUsedPct: 25,
    });
  });
  it("says null, not zero, for what was not reported", () => {
    expect(summarizeDeviceResources(null)).toEqual({
      cpuModel: null,
      cpuCores: null,
      memoryMb: null,
      gpus: [],
      diskSizeMb: null,
      diskFreeMb: null,
      diskUsedPct: null,
    });
  });
});

describe("buildDeviceTree", () => {
  it("nests by parent and keeps orphans and cycles as roots", () => {
    const roots = buildDeviceTree([
      { id: "host", parentDeviceId: null },
      { id: "vm", parentDeviceId: "host" },
      { id: "ct", parentDeviceId: "vm" },
      { id: "orphan", parentDeviceId: "gone" },
      { id: "a", parentDeviceId: "b" },
      { id: "b", parentDeviceId: "a" },
    ]);
    expect(roots.map((r) => r.id)).toEqual(["host", "orphan", "a", "b"]);
    expect(roots[0]!.children[0]!.id).toBe("vm");
    expect(roots[0]!.children[0]!.children[0]!.id).toBe("ct");
  });
});

describe("several processes report one device", () => {
  const t0 = new Date("2026-11-27T12:00:00Z");
  const later = (ms: number) => new Date(t0.getTime() + ms);

  it("keeps each reporter's capabilities apart and answers their union", () => {
    let reports = recordCapabilityReport({}, "waker", ["wake.agent"], t0);
    reports = recordCapabilityReport(reports, "host", ["serve.http"], t0);
    // The waker reports again: the host's capability is not erased.
    reports = recordCapabilityReport(reports, "waker", ["wake.agent"], t0);
    expect(effectiveDeviceCapabilities(reports, t0)).toEqual([
      "serve.http",
      "wake.agent",
    ]);
  });

  it("a report with no capabilities keeps the reporter's last set alive", () => {
    let reports = recordCapabilityReport({}, "host", ["serve.http"], t0);
    const at = later(DEVICE_CAPABILITY_TTL_MS - 1000);
    reports = recordCapabilityReport(reports, "host", undefined, at);
    expect(
      effectiveDeviceCapabilities(reports, later(DEVICE_CAPABILITY_TTL_MS + 1))
    ).toEqual(["serve.http"]);
  });

  it("a reporter that stopped drops out after the TTL", () => {
    let reports = recordCapabilityReport({}, "host", ["serve.http"], t0);
    const late = later(DEVICE_CAPABILITY_TTL_MS + 1000);
    reports = recordCapabilityReport(reports, "waker", ["wake.agent"], late);
    expect(effectiveDeviceCapabilities(reports, late)).toEqual(["wake.agent"]);
    expect(effectiveDeviceCapabilities({}, t0)).toBeNull();
  });

  it("merges a report section by section: what it leaves out is kept", () => {
    const stored = parseDeviceManifest(FULL);
    if (!stored.ok) throw new Error(stored.error);
    const waker = parseDeviceManifest({
      manifestVersion: 1,
      identity: { os: "darwin", osVersion: "15.1" },
      capabilities: ["wake.agent"],
    });
    if (!waker.ok) throw new Error(waker.error);
    const merged = mergeDeviceManifest(stored.manifest, waker.manifest, [
      "run.tool",
      "wake.agent",
    ]);
    expect(merged.identity).toEqual({ os: "darwin", osVersion: "15.1" });
    // Not in the waker's report: kept from the stored manifest.
    expect(merged.resources).toEqual(stored.manifest.resources);
    expect(merged.location).toEqual(stored.manifest.location);
    // The union, never the one report's set.
    expect(merged.capabilities).toEqual(["run.tool", "wake.agent"]);
  });
});
