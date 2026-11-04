/**
 * The host's resource readings — `deploy/state/resources.json`, written by the
 * host sampler every heal tick (~2 min; plan P3, G10, lane p3a) and read here
 * through the backend's read-only deploy mount, the same way the update
 * outcome is (`apps/api/src/pod-updates`, `state/last-update.json`).
 *
 * The parse is TOLERANT PER BLOCK: one malformed block (a missing `swap`, a
 * `pressure` the kernel does not expose) reads as `null` = "unavailable" for
 * that block only, never as 0 and never as a failure of the whole file. A file
 * that is not a version-1 record at all is `unreadable`, which the evaluator
 * reports as its own warning ("readings stopped"), never "all fine".
 *
 * Never throws.
 */

import { readFile } from "node:fs/promises";

/** Where the host writes its readings (mounted read-only at /opt/synap/deploy). */
export const HOST_RESOURCES_PATH =
  process.env.SYNAP_RESOURCES_PATH || "/opt/synap/deploy/state/resources.json";

export interface PressureAverages {
  someAvg10: number | null;
  someAvg60: number | null;
  fullAvg10: number | null;
  fullAvg60: number | null;
}

export interface UsageBlock {
  totalBytes: number | null;
  availableBytes: number | null;
  usedPct: number;
}

export interface DiskReading {
  /** `data` (the pod's volumes) or `docker` (images, build cache). */
  label: string;
  path: string | null;
  totalBytes: number | null;
  usedBytes: number | null;
  availBytes: number | null;
  usedPct: number;
}

export interface HostResources {
  version: 1;
  sampledAt: string;
  hostKind: string | null;
  memory: UsageBlock | null;
  swap: UsageBlock | null;
  pressure: {
    memory: PressureAverages | null;
    cpu: PressureAverages | null;
    io: PressureAverages | null;
  };
  load: { avg1: number; avg5: number | null; cores: number } | null;
  disks: DiskReading[];
  docker: {
    sampledAt: string | null;
    buildCacheBytes: number | null;
    imagesReclaimableBytes: number | null;
  } | null;
}

/**
 * `ok` = a record was read; `absent` = the host has never written one (an
 * older host with no sampler, or the deploy dir is not mounted); `unreadable`
 * = the file exists but could not be read or is not a resources record.
 * Three different facts: a consumer never folds `unreadable` into `absent`.
 */
export type HostReadingsRead =
  | { read: "ok"; resources: HostResources }
  | { read: "absent" }
  | { read: "unreadable"; error: string };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nonNegative(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
}

function pct(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function usage(v: unknown): UsageBlock | null {
  const o = obj(v);
  if (!o) return null;
  const usedPct = pct(o.usedPct);
  if (usedPct === null) return null;
  return {
    totalBytes: nonNegative(o.totalBytes),
    availableBytes: nonNegative(o.availableBytes),
    usedPct,
  };
}

function pressure(v: unknown): PressureAverages | null {
  const o = obj(v);
  if (!o) return null;
  const p: PressureAverages = {
    someAvg10: pct(o.someAvg10),
    someAvg60: pct(o.someAvg60),
    fullAvg10: pct(o.fullAvg10),
    fullAvg60: pct(o.fullAvg60),
  };
  return Object.values(p).every((x) => x === null) ? null : p;
}

function disk(v: unknown): DiskReading | null {
  const o = obj(v);
  if (!o) return null;
  const label = str(o.label, 40);
  const usedPct = pct(o.usedPct);
  if (!label || !/^[a-z0-9_-]+$/i.test(label) || usedPct === null) return null;
  return {
    label,
    path: str(o.path),
    totalBytes: nonNegative(o.totalBytes),
    usedBytes: nonNegative(o.usedBytes),
    availBytes: nonNegative(o.availBytes),
    usedPct,
  };
}

/** Projects a parsed file to readings. Null when it is not a version-1 record. */
export function parseHostResources(raw: unknown): HostResources | null {
  const r = obj(raw);
  if (!r || r.version !== 1) return null;
  const sampledAt = str(r.sampledAt, 40);
  if (!sampledAt || Number.isNaN(Date.parse(sampledAt))) return null;
  const p = obj(r.pressure);
  const l = obj(r.load);
  const avg1 = num(l?.avg1);
  const cores = num(l?.cores);
  const d = obj(r.docker);
  // One disk per filesystem: the host lists the deploy dir (`data`) and
  // Docker's root (`docker`) even when they sit on ONE filesystem
  // (host-resources.v1 schema), and two rows of the same disk would raise two
  // alerts for one problem. Same label, same path, or the same byte figures
  // (the paths differ by contract, the filesystem does not) = one disk; the
  // first listed (`data`) is kept.
  const seen = new Set<string>();
  const disks = (Array.isArray(r.disks) ? r.disks : [])
    .map(disk)
    .filter((x): x is DiskReading => {
      if (!x) return false;
      const keys = [
        `label:${x.label}`,
        ...(x.path ? [`path:${x.path}`] : []),
        ...(x.totalBytes !== null &&
        x.usedBytes !== null &&
        x.availBytes !== null
          ? [`fs:${x.totalBytes}:${x.usedBytes}:${x.availBytes}`]
          : []),
      ];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    })
    .slice(0, 8);
  return {
    version: 1,
    sampledAt: new Date(sampledAt).toISOString(),
    hostKind: str(r.hostKind, 40),
    memory: usage(r.memory),
    swap: usage(r.swap),
    pressure: {
      memory: pressure(p?.memory),
      cpu: pressure(p?.cpu),
      io: pressure(p?.io),
    },
    load:
      avg1 !== null && avg1 >= 0 && cores !== null && cores > 0
        ? { avg1, avg5: nonNegative(l?.avg5), cores }
        : null,
    disks,
    docker: d
      ? {
          sampledAt: str(d.sampledAt, 40),
          buildCacheBytes: nonNegative(d.buildCacheBytes),
          imagesReclaimableBytes: nonNegative(d.imagesReclaimableBytes),
        }
      : null,
  };
}

export async function readHostResources(
  path: string = HOST_RESOURCES_PATH,
  read: (p: string) => Promise<string> = (p) => readFile(p, "utf-8")
): Promise<HostReadingsRead> {
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT")
      return { read: "absent" };
    return {
      read: "unreadable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const resources = parseHostResources(JSON.parse(text));
    return resources
      ? { read: "ok", resources }
      : { read: "unreadable", error: "not a version-1 resources record" };
  } catch (err) {
    return {
      read: "unreadable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
