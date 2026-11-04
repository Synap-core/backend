/**
 * A `podHealth.get` answer as the pod sends it, for the page's tests: a calm
 * pod with one unmeasured block (swap), at 23:00 on 4 Nov 2026 local time.
 */
export const GB = 1e9;
export const NOW = new Date(2026, 10, 4, 23, 0).getTime();
export const at = (h: number, m: number) =>
  new Date(2026, 10, 4, h, m).toISOString();

export const THRESHOLDS = {
  memory: { warn: 80, critical: 90 },
  swap: { warn: 50, critical: 80 },
  memoryPressure: { warn: 10, critical: 25 },
  disk: { warn: 80, critical: 95 },
  postgresConnections: { warn: 80, critical: 90 },
};

export function wire(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    level: "ok",
    hostState: "fresh",
    hostSampledAt: at(22, 58),
    evaluatedAt: at(23, 0),
    readings: [
      {
        key: "readings",
        kind: "readings",
        value: null,
        unit: "none",
        mark: "ok",
        since: null,
        alerting: true,
        detail: { state: "fresh", sampledAt: at(22, 58) },
      },
      {
        key: "memory",
        kind: "memory",
        value: 52,
        unit: "percent",
        mark: "ok",
        since: null,
        alerting: true,
        detail: { availableBytes: 8 * GB, totalBytes: 16 * GB },
      },
      {
        key: "swap",
        kind: "swap",
        value: null,
        unit: "percent",
        mark: "unavailable",
        since: null,
        alerting: true,
        detail: { totalBytes: null },
      },
      {
        key: "disk:data",
        kind: "disk",
        label: "data",
        value: 40,
        unit: "percent",
        mark: "ok",
        since: null,
        alerting: true,
        detail: { availBytes: 60 * GB, totalBytes: 100 * GB },
      },
      {
        key: "postgresConnections",
        kind: "postgresConnections",
        value: 10,
        unit: "percent",
        mark: "ok",
        since: null,
        alerting: true,
        detail: { used: 20, max: 200 },
      },
      {
        key: "load",
        kind: "load",
        value: 0.5,
        unit: "ratio",
        mark: "neutral",
        since: null,
        alerting: false,
        detail: { cores: 4 },
      },
      {
        key: "backup",
        kind: "backup",
        value: 3_600_000,
        unit: "ms",
        mark: "ok",
        since: null,
        alerting: false,
        detail: { status: "ok", lastSuccessAt: at(22, 0) },
      },
    ],
    reclaimable: { buildCacheBytes: 3 * GB, imagesReclaimableBytes: 2 * GB },
    alerts: [],
    thresholds: THRESHOLDS,
    customized: [],
    actions: { pending: null, last: { read: "absent" } },
    restartableServices: ["backend", "realtime"],
    ...over,
  };
}
