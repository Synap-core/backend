/**
 * The tick end to end, with its edges injected (no DB, no file): thresholds
 * validation, the notification dedupe across ticks (a restart re-reads the
 * durable state, so nothing is sent twice), the clear when resolved, and the
 * host action door (never Postgres, one request at a time).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: { create: vi.fn() },
}));
vi.mock("../../capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: vi.fn(async () => []),
}));
vi.mock("../../media-copy/backfill-media-copy.js", () => ({
  readPodSettingsKey: vi.fn(),
  writePodSettingsKey: vi.fn(),
}));
vi.mock("../pod-readings.js", () => ({
  readPodOwnReadings: vi.fn(),
  registerEventLoopP99Reader: vi.fn(),
}));

const {
  runPodHealthCheck,
  podResourcesStatus,
  applyThresholdsPatch,
  resolveResourceAlertThresholds,
  DEFAULT_RESOURCE_ALERT_THRESHOLDS,
  parseHostResources,
  requestHostAction,
  readHostActionsStatus,
  resourceWarningGroupKey,
  describeResourceAlert,
} = await import("../index.js");
type PodHealthDeps = import("../index.js").PodHealthDeps;

const GB = 1024 ** 3;
const T0 = Date.parse("2026-11-04T10:00:00.000Z");

function hostAt(min: number, memPct: number) {
  const r = parseHostResources({
    version: 1,
    sampledAt: new Date(T0 + min * 60_000).toISOString(),
    hostKind: "vm",
    memory: { totalBytes: 16 * GB, availableBytes: GB, usedPct: memPct },
    swap: null,
    pressure: { memory: null, cpu: null, io: null },
    load: { avg1: 1, avg5: 1, cores: 4 },
    disks: [],
    docker: null,
  });
  if (!r) throw new Error("fixture");
  return { read: "ok" as const, resources: r };
}

/** A pod whose durable settings live in a plain object, like pod_settings. */
function fakePod(admins = ["admin-1", "owner-1"]) {
  const settings: Record<string, unknown> = {};
  const sent: Array<{
    userId: string;
    data: Record<string, unknown>;
    type: string;
  }> = [];
  const dismissed: string[] = [];
  let min = 0;
  let mem = 50;
  const deps: PodHealthDeps = {
    now: () => new Date(T0 + min * 60_000),
    readThresholdsRaw: async () => settings.resourceAlerts ?? null,
    readStateRaw: async () => settings.resourceAlertState ?? null,
    writeState: async (s) => {
      settings.resourceAlertState = JSON.parse(JSON.stringify(s));
    },
    readHost: async () => hostAt(min, mem),
    readPod: async () => ({
      postgresConnections: { used: 10, max: 200 },
      databaseSizeBytes: GB,
      eventLoopP99Ms: 3,
      backup: null,
    }),
    notify: {
      recipients: async () => admins,
      create: async (input) => {
        sent.push({
          userId: input.userId,
          data: input.data,
          type: input.type,
        });
        return `n-${sent.length}`;
      },
      dismiss: async (metric) => {
        dismissed.push(metric);
      },
    },
  };
  return {
    deps,
    settings,
    sent,
    dismissed,
    tick: async (atMin: number, memPct: number) => {
      min = atMin;
      mem = memPct;
      return runPodHealthCheck(deps);
    },
  };
}

describe("the tick: notify once per metric and level, durably", () => {
  // Catches: an alert re-sent every 2 minutes, or re-sent after a restart
  // (state held in memory only).
  it("raises after 3 samples, to every pod admin, once", async () => {
    const pod = fakePod();
    await pod.tick(0, 85);
    await pod.tick(2, 85);
    expect(pod.sent).toEqual([]);
    const r = await pod.tick(4, 85);
    expect(r.level).toBe("warning");
    expect(pod.sent.map((s) => s.userId)).toEqual(["admin-1", "owner-1"]);
    expect(pod.sent[0]).toMatchObject({
      type: "pod.resource_warning",
      data: {
        metric: "memory",
        level: "warning",
        headline: describeResourceAlert("memory", "warning"),
        value: 85,
      },
    });
    // The next ticks, still over the line: nothing new.
    await pod.tick(6, 86);
    await pod.tick(8, 84);
    expect(pod.sent).toHaveLength(2);
  });

  it("a NEW process reading the stored state sends nothing again", async () => {
    const pod = fakePod();
    for (const m of [0, 2, 4]) await pod.tick(m, 85);
    expect(pod.sent).toHaveLength(2);
    const restarted = fakePod();
    Object.assign(restarted.settings, pod.settings);
    await restarted.tick(6, 85);
    expect(restarted.sent).toEqual([]);
  });

  it("critical is told once more; resolving clears the notice", async () => {
    const pod = fakePod(["admin-1"]);
    for (const m of [0, 2, 4]) await pod.tick(m, 85);
    for (const m of [6, 8, 10]) await pod.tick(m, 95);
    expect(pod.sent.map((s) => s.data.level)).toEqual(["warning", "critical"]);
    const r = await pod.tick(12, 60);
    expect(r.level).toBe("ok");
    expect(pod.dismissed).toEqual(["memory"]);
    // A new episode notifies again.
    for (const m of [14, 16, 18]) await pod.tick(m, 85);
    expect(pod.sent.map((s) => s.data.level)).toEqual([
      "warning",
      "critical",
      "warning",
    ]);
  });

  it("the group key is one per metric", () => {
    expect(resourceWarningGroupKey("disk:data")).toBe(
      "pod:pod.resource_warning:disk:data"
    );
  });

  it("the status part reports a failed read as failed, never ok", async () => {
    const pod = fakePod();
    pod.deps.readStateRaw = async () => {
      throw new Error("db down");
    };
    expect(await podResourcesStatus(pod.deps)).toEqual({ read: "failed" });
  });

  // Catches: evaluating against an unreadable state, which would re-send
  // every open alert as if it were new.
  it("a failed state read skips the tick instead of re-notifying", async () => {
    const pod = fakePod();
    for (const m of [0, 2, 4]) await pod.tick(m, 85);
    pod.deps.readStateRaw = async () => {
      throw new Error("db down");
    };
    await expect(pod.tick(6, 85)).rejects.toThrow("db down");
    expect(pod.sent).toHaveLength(2);
  });
});

describe("thresholds", () => {
  it("defaults are the founder's: 80/90, disk 80/95, swap 50/80, pressure 10/25", () => {
    expect(DEFAULT_RESOURCE_ALERT_THRESHOLDS).toEqual({
      memory: { warn: 80, critical: 90 },
      swap: { warn: 50, critical: 80 },
      memoryPressure: { warn: 10, critical: 25 },
      disk: { warn: 80, critical: 95 },
      postgresConnections: { warn: 80, critical: 90 },
    });
  });

  it("a malformed stored metric falls back to its default alone", () => {
    const t = resolveResourceAlertThresholds({
      memory: { warn: 70, critical: 85 },
      swap: { warn: 90, critical: 20 },
      disk: "x",
    });
    expect(t.memory).toEqual({ warn: 70, critical: 85 });
    expect(t.swap).toEqual({ warn: 50, critical: 80 });
    expect(t.disk).toEqual({ warn: 80, critical: 95 });
    expect(t.explicit).toEqual(["memory"]);
  });

  it("a patch is refused per metric: out of range, warn not below critical", () => {
    const base = resolveResourceAlertThresholds(null);
    expect(
      applyThresholdsPatch(base, {
        memory: { warn: 90, critical: 90 },
        disk: { warn: 0, critical: 50 },
        swap: { warn: 40, critical: 101 },
      })
    ).toEqual({
      ok: false,
      problems: {
        memory: "warn_not_below_critical",
        disk: "out_of_range",
        swap: "out_of_range",
      },
    });
    const ok = applyThresholdsPatch(base, {
      memory: { warn: 70, critical: 85 },
    });
    expect(ok.ok && ok.thresholds.memory).toEqual({ warn: 70, critical: 85 });
    expect(ok.ok && ok.thresholds.disk).toEqual({ warn: 80, critical: 95 });
  });
});

describe("the host action door", () => {
  function memFs(existing: string[] = []) {
    const files = new Map<string, string>(existing.map((p) => [p, "{}"]));
    return {
      files,
      fs: {
        exists: async (p: string) => files.has(p),
        mkdir: async () => undefined,
        write: async (p: string, t: string) => void files.set(p, t),
        rename: async (a: string, b: string) => {
          files.set(b, files.get(a) ?? "");
          files.delete(a);
        },
        unlink: async (p: string) => void files.delete(p),
      },
    };
  }

  // Catches: Postgres (or any service off the list) restartable from a page.
  it("never restarts Postgres or an unknown service", async () => {
    for (const service of [
      "postgres",
      "redis",
      "minio",
      "kratos",
      "x; rm -rf /",
      undefined,
    ]) {
      const { fs, files } = memFs();
      const r = await requestHostAction(
        { action: "restart-service", service, requestedBy: "u1" },
        { path: "/s/requests/clean.json", fs }
      );
      expect(r, String(service)).toEqual({
        ok: false,
        reason: "service_not_allowed",
      });
      expect(files.size).toBe(0);
    }
  });

  it("writes one request (tmp + rename) and refuses a second while it waits", async () => {
    const { fs, files } = memFs();
    const r = await requestHostAction(
      { action: "prune-build-cache", service: "backend", requestedBy: "u1" },
      { path: "/s/requests/clean.json", fs, id: "req-1", now: new Date(T0) }
    );
    expect(r.ok).toBe(true);
    expect([...files.keys()]).toEqual(["/s/requests/clean.json"]);
    expect(JSON.parse(files.get("/s/requests/clean.json") ?? "")).toEqual({
      id: "req-1",
      action: "prune-build-cache",
      requestedBy: "u1",
      requestedAt: new Date(T0).toISOString(),
    });
    expect(
      await requestHostAction(
        { action: "prune-old-images", requestedBy: "u1" },
        { path: "/s/requests/clean.json", fs }
      )
    ).toEqual({ ok: false, reason: "busy" });
  });

  it("a write that fails is unavailable, and leaves no temp file", async () => {
    const { fs, files } = memFs();
    fs.rename = async () => {
      throw new Error("EROFS");
    };
    expect(
      await requestHostAction(
        { action: "restart-service", service: "realtime", requestedBy: "u1" },
        { path: "/s/requests/clean.json", fs }
      )
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(files.size).toBe(0);
  });

  it("reads the waiting request and the host's last answer; unreadable ≠ none", async () => {
    const files: Record<string, string> = {
      "/req": JSON.stringify({
        id: "r2",
        action: "restart-service",
        service: "backend",
        requestedAt: "2026-11-04T10:00:00Z",
      }),
      "/res": JSON.stringify({
        id: "r1",
        action: "prune-build-cache",
        status: "done",
        detail: "Trimmed",
        freedBytes: 1234,
        finishedAt: "2026-11-04T09:59:00Z",
      }),
    };
    const read = async (p: string) => {
      if (!(p in files))
        throw Object.assign(new Error("no"), { code: "ENOENT" });
      return files[p];
    };
    const s = await readHostActionsStatus(
      { request: "/req", result: "/res" },
      read
    );
    expect(s.pending).toMatchObject({
      id: "r2",
      action: "restart-service",
      service: "backend",
    });
    expect(s.last).toMatchObject({
      read: "ok",
      result: { status: "done", freedBytes: 1234 },
    });
    files["/res"] = "{broken";
    expect(
      (await readHostActionsStatus({ request: "/none", result: "/res" }, read))
        .last
    ).toEqual({ read: "unreadable" });
    expect(
      await readHostActionsStatus({ request: "/none", result: "/none" }, read)
    ).toEqual({ pending: null, last: { read: "absent" } });
  });
});
