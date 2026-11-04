/**
 * The resource alert evaluator (plan P3, G10): thresholds, the 3-sample hold,
 * hysteresis, stale and unreadable host files, unavailable blocks, and the
 * once-per-level notification plan. Pure: no DB, no file.
 */
import { describe, expect, it } from "vitest";
import {
  emptyAlertState,
  evaluateResources,
  parseAlertState,
  planNotifications,
  type PodOwnReadings,
  type ResourceAlertState,
} from "../evaluate.js";
import {
  parseHostResources,
  readHostResources,
  type HostReadingsRead,
} from "../host-readings.js";
import { DEFAULT_RESOURCE_ALERT_THRESHOLDS } from "../thresholds.js";

const GB = 1024 ** 3;
const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000);

function hostFile(
  min: number,
  over: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    version: 1,
    sampledAt: at(min).toISOString(),
    hostKind: "vm",
    memory: { totalBytes: 16 * GB, availableBytes: 8 * GB, usedPct: 50 },
    swap: { totalBytes: 4 * GB, availableBytes: 4 * GB, usedPct: 0 },
    pressure: {
      memory: { someAvg10: 0, someAvg60: 0, fullAvg10: 0, fullAvg60: 0 },
      cpu: { someAvg10: 1, someAvg60: 2, fullAvg10: null, fullAvg60: null },
      io: { someAvg10: 0, someAvg60: 1, fullAvg10: 0, fullAvg60: 0 },
    },
    load: { avg1: 2, avg5: 1.5, cores: 4 },
    disks: [
      {
        label: "data",
        path: "/var/lib/docker",
        totalBytes: 100 * GB,
        usedBytes: 40 * GB,
        availBytes: 60 * GB,
        usedPct: 40,
      },
    ],
    docker: {
      sampledAt: at(min).toISOString(),
      buildCacheBytes: 3 * GB,
      imagesReclaimableBytes: 2 * GB,
    },
    ...over,
  };
}

function host(raw: Record<string, unknown>): HostReadingsRead {
  const resources = parseHostResources(raw);
  if (!resources) throw new Error("fixture is not a resources record");
  return { read: "ok", resources };
}

const POD: PodOwnReadings = {
  postgresConnections: { used: 20, max: 200 },
  databaseSizeBytes: 2 * GB,
  eventLoopP99Ms: 4,
  backup: { status: "ok", lastSuccessAt: at(-60).toISOString() },
};

/** Runs one evaluation per (minute, host file) and returns the last one. */
function run(
  samples: Array<{
    min: number;
    file: Record<string, unknown> | HostReadingsRead;
  }>,
  opts: { pod?: PodOwnReadings; start?: ResourceAlertState } = {}
) {
  let state = opts.start ?? emptyAlertState();
  let last: ReturnType<typeof evaluateResources> | null = null;
  for (const s of samples) {
    last = evaluateResources({
      now: at(s.min),
      host: "read" in s.file ? (s.file as HostReadingsRead) : host(s.file),
      pod: opts.pod ?? POD,
      thresholds: DEFAULT_RESOURCE_ALERT_THRESHOLDS,
      previous: state,
    });
    state = last.state;
  }
  return last!;
}

const mem = (pct: number) => ({
  memory: { totalBytes: 16 * GB, availableBytes: 1 * GB, usedPct: pct },
});

const reading = (ev: ReturnType<typeof evaluateResources>, key: string) =>
  ev.readings.find((r) => r.key === key);

describe("the 3-sample hold", () => {
  // Catches: one spike raising an alert (no hold), or a hold that never ends.
  it("two samples over the warn line are not an alert; the third is", () => {
    const two = run([
      { min: 0, file: hostFile(0, mem(85)) },
      { min: 2, file: hostFile(2, mem(86)) },
    ]);
    expect(two.state.metrics.memory.level).toBe("ok");
    expect(two.state.metrics.memory.overWarn).toBe(2);
    const three = run([
      { min: 0, file: hostFile(0, mem(85)) },
      { min: 2, file: hostFile(2, mem(86)) },
      { min: 4, file: hostFile(4, mem(84)) },
    ]);
    expect(three.state.metrics.memory.level).toBe("warning");
    expect(three.state.metrics.memory.since).toBe(at(4).toISOString());
    expect(three.level).toBe("warning");
    expect(reading(three, "memory")?.mark).toBe("warning");
  });

  it("a dip under the line restarts the count", () => {
    const ev = run([
      { min: 0, file: hostFile(0, mem(85)) },
      { min: 2, file: hostFile(2, mem(70)) },
      { min: 4, file: hostFile(4, mem(85)) },
      { min: 6, file: hostFile(6, mem(85)) },
    ]);
    expect(ev.state.metrics.memory.level).toBe("ok");
  });

  it("critical needs three critical samples of its own", () => {
    const ev = run([
      { min: 0, file: hostFile(0, mem(85)) },
      { min: 2, file: hostFile(2, mem(85)) },
      { min: 4, file: hostFile(4, mem(95)) },
      { min: 6, file: hostFile(6, mem(95)) },
    ]);
    expect(ev.state.metrics.memory.level).toBe("warning");
    const crit = run([
      { min: 0, file: hostFile(0, mem(95)) },
      { min: 2, file: hostFile(2, mem(95)) },
      { min: 4, file: hostFile(4, mem(95)) },
    ]);
    expect(crit.state.metrics.memory.level).toBe("critical");
  });

  // Catches: the same host file re-read every tick counted as a new sample.
  it("the same host sample read three times is ONE sample", () => {
    const f = hostFile(0, mem(95));
    const ev = run([
      { min: 0, file: f },
      { min: 2, file: f },
      { min: 4, file: f },
    ]);
    expect(ev.state.metrics.memory.overCritical).toBe(1);
    expect(ev.state.metrics.memory.level).toBe("ok");
  });
});

describe("hysteresis: an alert clears 5 points below its line", () => {
  const raised = () =>
    run([
      { min: 0, file: hostFile(0, mem(85)) },
      { min: 2, file: hostFile(2, mem(85)) },
      { min: 4, file: hostFile(4, mem(85)) },
    ]).state;

  it("just under the line keeps it", () => {
    const ev = run([{ min: 6, file: hostFile(6, mem(77)) }], {
      start: raised(),
    });
    expect(ev.state.metrics.memory.level).toBe("warning");
    expect(ev.state.metrics.memory.since).toBe(at(4).toISOString());
  });

  it("5 points under clears it at once", () => {
    const ev = run([{ min: 6, file: hostFile(6, mem(74)) }], {
      start: raised(),
    });
    expect(ev.state.metrics.memory.level).toBe("ok");
    expect(ev.state.metrics.memory.since).toBeNull();
  });

  it("critical steps down to warning under its own band", () => {
    const crit = run([
      { min: 0, file: hostFile(0, mem(95)) },
      { min: 2, file: hostFile(2, mem(95)) },
      { min: 4, file: hostFile(4, mem(95)) },
    ]).state;
    expect(
      run([{ min: 6, file: hostFile(6, mem(86)) }], { start: crit }).state
        .metrics.memory.level
    ).toBe("critical");
    expect(
      run([{ min: 6, file: hostFile(6, mem(84)) }], { start: crit }).state
        .metrics.memory.level
    ).toBe("warning");
  });
});

describe("thresholds per metric", () => {
  it("swap warns at 50, memory pressure at fullAvg60 10", () => {
    const swap = {
      swap: { totalBytes: 4 * GB, availableBytes: 1, usedPct: 55 },
    };
    const ev = run([0, 2, 4].map((m) => ({ min: m, file: hostFile(m, swap) })));
    expect(ev.state.metrics.swap.level).toBe("warning");
    const psi = {
      pressure: {
        memory: { someAvg10: 30, someAvg60: 30, fullAvg10: 30, fullAvg60: 26 },
        cpu: null,
        io: null,
      },
    };
    const p = run([0, 2, 4].map((m) => ({ min: m, file: hostFile(m, psi) })));
    expect(p.state.metrics.memoryPressure.level).toBe("critical");
  });

  // Catches: a big disk at a calm percentage hiding that it has 3 GB left.
  it("a disk under 5 GB free is critical whatever its percentage", () => {
    const low = {
      disks: [
        {
          label: "data",
          path: "/",
          totalBytes: 2000 * GB,
          usedBytes: 1997 * GB,
          availBytes: 3 * GB,
          usedPct: 60,
        },
      ],
    };
    const ev = run([0, 2, 4].map((m) => ({ min: m, file: hostFile(m, low) })));
    expect(ev.state.metrics["disk:data"].level).toBe("critical");
    expect(reading(ev, "disk:data")).toMatchObject({
      kind: "disk",
      label: "data",
      mark: "critical",
      detail: { availBytes: 3 * GB },
    });
  });

  it("disk warns at 80 and is critical at 95", () => {
    const d = (pct: number) => ({
      disks: [
        {
          label: "data",
          path: "/",
          totalBytes: 1000 * GB,
          usedBytes: pct * 10 * GB,
          availBytes: (100 - pct) * 10 * GB,
          usedPct: pct,
        },
      ],
    });
    const warn = run(
      [0, 2, 4].map((m) => ({ min: m, file: hostFile(m, d(91)) }))
    );
    expect(warn.state.metrics["disk:data"].level).toBe("warning");
    const crit = run(
      [0, 2, 4].map((m) => ({ min: m, file: hostFile(m, d(96)) }))
    );
    expect(crit.state.metrics["disk:data"].level).toBe("critical");
  });

  it("Postgres connections count on every evaluation, against max_connections", () => {
    const pod = { ...POD, postgresConnections: { used: 185, max: 200 } };
    const f = hostFile(0);
    const ev = run(
      [
        { min: 0, file: f },
        { min: 2, file: f },
        { min: 4, file: f },
      ],
      { pod }
    );
    expect(ev.state.metrics.postgresConnections.level).toBe("critical");
    expect(reading(ev, "postgresConnections")).toMatchObject({
      value: 92.5,
      detail: { used: 185, max: 200 },
    });
  });
});

describe("stale, unreadable and missing readings", () => {
  // Catches: an old file read as "all fine" (the 3 Nov failure shape: the
  // sampler dies with the host, and the page goes calm).
  it("a file older than 10 minutes is its own warning, and the old numbers are not shown", () => {
    const ev = run([{ min: 11, file: hostFile(0, mem(95)) }]);
    expect(ev.hostState).toBe("stale");
    expect(ev.state.metrics.readings.level).toBe("warning");
    expect(ev.level).toBe("warning");
    expect(reading(ev, "readings")?.mark).toBe("warning");
    expect(reading(ev, "memory")?.mark).toBe("unavailable");
    expect(reading(ev, "memory")?.value).toBeNull();
    // A stale sample never advances the host metrics.
    expect(ev.state.metrics.memory).toBeUndefined();
  });

  it("an alert open when the readings stop keeps its level", () => {
    const crit = run([
      { min: 0, file: hostFile(0, mem(95)) },
      { min: 2, file: hostFile(2, mem(95)) },
      { min: 4, file: hostFile(4, mem(95)) },
    ]).state;
    const ev = run([{ min: 20, file: hostFile(4, mem(95)) }], { start: crit });
    expect(ev.state.metrics.memory.level).toBe("critical");
    expect(ev.state.metrics.readings.level).toBe("warning");
  });

  it("what the host actions would free comes from a fresh sample only", () => {
    expect(run([{ min: 0, file: hostFile(0) }]).reclaimable).toEqual({
      buildCacheBytes: 3 * GB,
      imagesReclaimableBytes: 2 * GB,
      sampledAt: at(0).toISOString(),
    });
    expect(run([{ min: 11, file: hostFile(0) }]).reclaimable).toBeNull();
    expect(
      run([{ min: 0, file: hostFile(0, { docker: null }) }]).reclaimable
    ).toBeNull();
  });

  it("an unreadable file is a warning, never all fine", () => {
    const ev = run([
      { min: 0, file: { read: "unreadable", error: "Unexpected token" } },
    ]);
    expect(ev.hostState).toBe("unreadable");
    expect(ev.level).toBe("warning");
    expect(reading(ev, "readings")?.detail.error).toBe("Unexpected token");
  });

  it("no file at all (an older host) is unavailable, not an alert", () => {
    const ev = run([{ min: 0, file: { read: "absent" } }]);
    expect(ev.hostState).toBe("absent");
    expect(ev.level).toBe("ok");
    expect(reading(ev, "readings")?.mark).toBe("unavailable");
  });

  // Catches: a missing block folded into 0 (reads as "0% swap, all fine").
  it("a block the host did not report is unavailable, never 0", () => {
    const ev = run([
      { min: 0, file: hostFile(0, { swap: null, pressure: { memory: "x" } }) },
    ]);
    expect(reading(ev, "swap")).toMatchObject({
      value: null,
      mark: "unavailable",
    });
    expect(reading(ev, "memoryPressure")).toMatchObject({
      value: null,
      mark: "unavailable",
    });
    expect(reading(ev, "cpuPressure")).toMatchObject({
      value: null,
      mark: "unavailable",
    });
    expect(reading(ev, "memory")?.mark).toBe("ok");
  });

  it("the pod's own failed reads are unavailable", () => {
    const ev = run([{ min: 0, file: hostFile(0) }], {
      pod: {
        postgresConnections: null,
        databaseSizeBytes: null,
        eventLoopP99Ms: null,
        backup: null,
      },
    });
    for (const key of [
      "postgresConnections",
      "databaseSize",
      "eventLoop",
      "backup",
    ]) {
      expect(reading(ev, key)?.mark, key).toBe("unavailable");
    }
  });
});

describe("the host file parser never throws and never invents a number", () => {
  it("a record of another version, or no sampledAt, is not a record", () => {
    expect(parseHostResources({ ...hostFile(0), version: 2 })).toBeNull();
    expect(
      parseHostResources({ ...hostFile(0), sampledAt: "soon" })
    ).toBeNull();
    expect(parseHostResources("nope")).toBeNull();
    expect(parseHostResources(null)).toBeNull();
  });

  it("drops out-of-range or malformed fields per block", () => {
    const r = parseHostResources(
      hostFile(0, {
        memory: { usedPct: 140 },
        load: { avg1: 1, cores: 0 },
        disks: [
          { label: "../etc", usedPct: 10 },
          { label: "docker", usedPct: 10 },
        ],
      })
    );
    expect(r?.memory).toBeNull();
    expect(r?.load).toBeNull();
    expect(r?.disks.map((d) => d.label)).toEqual(["docker"]);
  });

  // Catches: one filesystem listed twice (deploy dir + Docker root) raising
  // two alerts for one full disk.
  it("one filesystem listed under two labels is one disk", () => {
    const same = {
      totalBytes: 100 * GB,
      usedBytes: 90 * GB,
      availBytes: 10 * GB,
      usedPct: 90,
    };
    const r = parseHostResources(
      hostFile(0, {
        disks: [
          { label: "data", path: "/opt/synap/deploy", ...same },
          { label: "docker", path: "/var/lib/docker", ...same },
        ],
      })
    );
    expect(r?.disks.map((d) => d.label)).toEqual(["data"]);
    const two = parseHostResources(
      hostFile(0, {
        disks: [
          { label: "data", path: "/opt/synap/deploy", ...same },
          {
            label: "docker",
            path: "/mnt/docker",
            ...same,
            usedBytes: 50 * GB,
            usedPct: 50,
          },
        ],
      })
    );
    expect(two?.disks.map((d) => d.label)).toEqual(["data", "docker"]);
  });

  it("the reader: ENOENT is absent, a parse failure is unreadable", async () => {
    const enoent = Object.assign(new Error("no"), { code: "ENOENT" });
    expect(
      await readHostResources("/x", async () => {
        throw enoent;
      })
    ).toEqual({ read: "absent" });
    expect((await readHostResources("/x", async () => "{not json")).read).toBe(
      "unreadable"
    );
    expect(
      (await readHostResources("/x", async () => JSON.stringify(hostFile(0))))
        .read
    ).toBe("ok");
  });
});

describe("the durable state", () => {
  it("survives a round trip and a malformed blob starts over", () => {
    const ev = run([
      { min: 0, file: hostFile(0, mem(95)) },
      { min: 2, file: hostFile(2, mem(95)) },
      { min: 4, file: hostFile(4, mem(95)) },
    ]);
    expect(parseAlertState(JSON.parse(JSON.stringify(ev.state)))).toEqual(
      ev.state
    );
    expect(parseAlertState({ version: 9 })).toEqual(emptyAlertState());
    expect(parseAlertState("garbage")).toEqual(emptyAlertState());
  });
});

describe("notifications: once per metric and level, cleared when resolved", () => {
  const state = (
    metrics: ResourceAlertState["metrics"]
  ): ResourceAlertState => ({ ...emptyAlertState(), metrics });
  const m = (
    level: "ok" | "warning" | "critical",
    notified: "warning" | "critical" | null
  ) => ({
    level,
    since: level === "ok" ? null : at(0).toISOString(),
    overWarn: 3,
    overCritical: 0,
    notified,
    value: 90,
  });

  it("raises a new level once, then nothing on the next tick", () => {
    const first = planNotifications(state({ memory: m("warning", null) }));
    expect(first.raise).toEqual([
      {
        metric: "memory",
        level: "warning",
        value: 90,
        since: at(0).toISOString(),
      },
    ]);
    const second = planNotifications(first.state);
    expect(second.raise).toEqual([]);
    expect(second.clear).toEqual([]);
  });

  it("warning → critical raises critical; critical → warning raises nothing", () => {
    const up = planNotifications(state({ memory: m("critical", "warning") }));
    expect(up.raise.map((r) => r.level)).toEqual(["critical"]);
    const down = planNotifications(state({ memory: m("warning", "critical") }));
    expect(down.raise).toEqual([]);
    expect(down.state.metrics.memory.notified).toBe("critical");
  });

  it("back to ok clears it and resets the episode", () => {
    const p = planNotifications(state({ memory: m("ok", "critical") }));
    expect(p.clear).toEqual(["memory"]);
    expect(p.state.metrics.memory.notified).toBeNull();
    expect(planNotifications(p.state).clear).toEqual([]);
  });
});
