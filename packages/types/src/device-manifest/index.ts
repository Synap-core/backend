/**
 * A DEVICE describes itself (devices plan 767a5978 §3, decision 78fc3fa1).
 *
 * "Device" is the product word ("Appareil"); `fleet` is the internal
 * namespace (the tRPC router, the services). A device is a `devices` row. A
 * computer that runs the Synap runner also has a `users` principal
 * (`agent_type = 'machine'`): that row is the device's KEY, the `devices` row
 * is the THING. A printer, a camera or a VM without a runner never becomes a
 * principal.
 *
 * What lives here, one contract for the pod, the CLI runner and every UI:
 * - the device manifest v1 (`DeviceManifestSchema`): what a device says about
 *   itself, sent by the runner at login and on every poll. Every section is
 *   optional: a device says what it knows;
 * - the device kinds, the connection modes and the native capability names;
 * - the per-kind `parameters` schemas, where a kind has one. An unknown kind
 *   (or a kind without a schema) takes a free-form record, so a new kind
 *   needs no migration;
 * - THE status verdict (`deriveDeviceStatus`): online, offline, degraded or
 *   unknown, read from `last_report_at` and the manifest's health. Status is
 *   never stored;
 * - the resources summary a list row shows (`summarizeDeviceResources`).
 *
 * What does NOT: storage, transport, words (the noun is the vocabulary's
 * `device`). Pure and dependency-free but zod: loaded by Node, the CLI,
 * Electron and React Native alike.
 */
import { z } from "zod";

/** The manifest version this module reads and writes. */
export const DEVICE_MANIFEST_VERSION = 1 as const;

// ─── Kinds, connections, capabilities ───────────────────────────────────────

/**
 * What a device IS. A Proxmox host is a `computer` (its role, `hypervisor`, is
 * a label). Stored as text with a shape check, never a database enum: a kind
 * added here needs no migration.
 */
export const DEVICE_KINDS = [
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
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DeviceKindSchema = z.enum(DEVICE_KINDS);

export function isDeviceKind(v: unknown): v is DeviceKind {
  return (
    typeof v === "string" && (DEVICE_KINDS as readonly string[]).includes(v)
  );
}

/**
 * How the pod hears from a device:
 * - `agent`: it runs the Synap runner itself (a computer with a key);
 * - `bridge`: another device's installation speaks for it (a printer through
 *   a Moonraker bridge, a VM through the Proxmox API);
 * - `provider`: a cloud provider started it (a compute lease);
 * - `manual`: a person described it; nothing reports.
 */
export const DEVICE_CONNECTION_MODES = [
  "agent",
  "bridge",
  "provider",
  "manual",
] as const;
export type DeviceConnectionMode = (typeof DEVICE_CONNECTION_MODES)[number];

const Id = z.string().trim().min(1).max(200);

export const DeviceConnectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("agent") }),
  z.object({
    mode: z.literal("bridge"),
    /** The device whose installation speaks for this one. */
    viaDeviceId: Id,
    installationId: Id.optional(),
    /** The bridge driver ("proxmox", "moonraker", …). */
    driver: z.string().trim().min(1).max(64),
    /**
     * What the bridge's own system calls this device (a Proxmox guest's
     * `vmid`): how a later discovery finds the device it already made.
     */
    externalId: Id.optional(),
  }),
  z.object({
    mode: z.literal("provider"),
    /** The `compute_leases` row that started it. */
    leaseId: Id.optional(),
    /** The provider's id of the machine. */
    resourceId: Id.optional(),
  }),
  z.object({ mode: z.literal("manual") }),
]);
export type DeviceConnection = z.output<typeof DeviceConnectionSchema>;

/**
 * What a device can do natively, as names it reports. For a computer, the
 * tools INSTALLED on it come from `installations`, never from here. Known
 * names are listed; any other dotted kebab name is accepted (a bridge driver
 * declares its own), so a new capability needs no release of this package.
 */
export const DEVICE_NATIVE_CAPABILITIES = [
  "run.tool",
  "run.box",
  "wake.agent",
  "serve.http",
  "print.3d",
  "capture.photo",
] as const;
export type DeviceNativeCapability =
  (typeof DEVICE_NATIVE_CAPABILITIES)[number];

/** `run.tool`, `print.3d`, `capture.photo`: lower-case words joined by dots. */
export const DEVICE_CAPABILITY_NAME =
  /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

// ─── The manifest ───────────────────────────────────────────────────────────

const Word = (max: number) => z.string().trim().min(1).max(max);
const Mb = z.number().int().nonnegative();

/**
 * A firmware UUID that names no machine: all zeros or all F, what a board or a
 * VM that never set one reports.
 */
const PLACEHOLDER_HARDWARE_ID = /^[0-]+$|^[fF-]+$/;

export const DeviceIdentitySchema = z.object({
  vendor: Word(120).optional(),
  model: Word(200).optional(),
  /** The OS as the runner reads it (`darwin`, `linux`, `win32`, "iOS 18"). */
  os: Word(64).optional(),
  /** The OS release ("15.1", "Ubuntu 24.04", "6.8.0-45-generic"). */
  osVersion: Word(120).optional(),
  arch: Word(32).optional(),
  hostname: Word(253).optional(),
  /**
   * The machine's firmware UUID (DMI `product_uuid`, macOS
   * `IOPlatformUUID`): the same machine seen by two doors (its own runner and
   * a hypervisor's bridge) is one device. A placeholder reads as absent
   * (`parseDeviceManifest`).
   */
  hardwareId: Word(64).optional(),
});
export type DeviceIdentity = z.output<typeof DeviceIdentitySchema>;

export const DeviceDiskSchema = z.object({
  /** Where it is mounted (`/`, `/data`, `C:`). */
  mount: Word(512),
  sizeMb: Mb,
  freeMb: Mb,
  fs: Word(32).optional(),
  /** The storage tier as the device knows it (`nvme`, `hdd-thin`). */
  tier: Word(64).optional(),
});
export type DeviceDisk = z.output<typeof DeviceDiskSchema>;

export const DeviceResourcesSchema = z.object({
  cpu: z
    .object({
      model: Word(200).optional(),
      cores: z.number().int().positive().max(4096).optional(),
    })
    .optional(),
  memoryMb: Mb.optional(),
  gpus: z
    .array(z.object({ model: Word(200), vramMb: Mb.optional() }))
    .max(32)
    .optional(),
  disks: z.array(DeviceDiskSchema).max(64).optional(),
});
export type DeviceResources = z.output<typeof DeviceResourcesSchema>;

/** Where a device is: a property, never an object of its own. */
export const DeviceLocationSchema = z.object({
  site: Word(120).optional(),
  region: Word(64).optional(),
  provider: Word(64).optional(),
  /** The network it is reached on (`tailnet`, `lan`). */
  network: Word(120).optional(),
});
export type DeviceLocation = z.output<typeof DeviceLocationSchema>;

/** What the device says about its own health, beside being reachable. */
export const DEVICE_HEALTH_STATES = ["ok", "degraded", "failing"] as const;
export type DeviceHealthState = (typeof DEVICE_HEALTH_STATES)[number];

export const DeviceHealthSchema = z.object({
  state: z.enum(DEVICE_HEALTH_STATES),
  /** One line a person can read ("disk / 93% full"). */
  detail: z.string().trim().max(500).optional(),
  /** ISO time the device checked itself. */
  checkedAt: z.string().max(64).optional(),
});
export type DeviceHealth = z.output<typeof DeviceHealthSchema>;

/**
 * `parameters`: what a kind knows about itself beyond resources (a printer's
 * bed, a camera's resolution). A free-form record on the wire; the kinds
 * listed in {@link DEVICE_KIND_PARAMETERS} are also checked against their own
 * schema by {@link parseDeviceManifest}. Keys a schema does not name pass
 * through.
 */
export const DeviceParametersSchema = z.record(z.string(), z.unknown());

const Mm = z.number().positive().max(100_000);

/** The kinds whose `parameters` have a known shape. */
export const DEVICE_KIND_PARAMETERS: Partial<Record<DeviceKind, z.ZodTypeAny>> =
  {
    printer: z
      .object({
        /** The build volume, in millimetres. */
        bedMm: z.object({ x: Mm, y: Mm, z: Mm.optional() }).optional(),
        nozzleMm: Mm.optional(),
        materials: z.array(Word(64)).max(64).optional(),
      })
      .passthrough(),
    camera: z
      .object({
        resolution: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .optional(),
        fps: z.number().positive().max(10_000).optional(),
      })
      .passthrough(),
  };

/**
 * The device manifest, v1. Unknown top-level keys are dropped (a newer runner
 * talking to this pod loses only what this pod cannot read). A manifest of
 * another version is refused: the runner reads the pod's answer and sends v1.
 */
export const DeviceManifestSchema = z.object({
  manifestVersion: z.literal(DEVICE_MANIFEST_VERSION),
  identity: DeviceIdentitySchema.optional(),
  resources: DeviceResourcesSchema.optional(),
  capabilities: z
    .array(
      z
        .string()
        .max(64)
        .regex(DEVICE_CAPABILITY_NAME, "a capability: words joined by dots")
    )
    .max(64)
    .optional(),
  parameters: DeviceParametersSchema.optional(),
  location: DeviceLocationSchema.optional(),
  health: DeviceHealthSchema.optional(),
});
export type DeviceManifest = z.output<typeof DeviceManifestSchema>;
export type DeviceManifestInput = z.input<typeof DeviceManifestSchema>;

/** The largest manifest the pod stores, serialized (bytes of JSON). */
export const DEVICE_MANIFEST_MAX_BYTES = 64 * 1024;

export type ParsedDeviceManifest =
  { ok: true; manifest: DeviceManifest } | { ok: false; error: string };

/**
 * THE manifest check: the v1 shape, its size, and, for a kind with a known
 * `parameters` schema, that schema. The error is one line naming the first
 * field that failed.
 */
export function parseDeviceManifest(
  raw: unknown,
  opts: { kind?: string | null } = {}
): ParsedDeviceManifest {
  const parsed = DeviceManifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const manifest = parsed.data;
  if (
    manifest.identity?.hardwareId !== undefined &&
    PLACEHOLDER_HARDWARE_ID.test(manifest.identity.hardwareId)
  )
    delete manifest.identity.hardwareId;
  const kindSchema =
    opts.kind && isDeviceKind(opts.kind)
      ? DEVICE_KIND_PARAMETERS[opts.kind]
      : undefined;
  if (kindSchema && manifest.parameters) {
    const p = kindSchema.safeParse(manifest.parameters);
    if (!p.success)
      return { ok: false, error: firstIssue(p.error, "parameters") };
    manifest.parameters = p.data as Record<string, unknown>;
  }
  if (
    new TextEncoder().encode(JSON.stringify(manifest)).length >
    DEVICE_MANIFEST_MAX_BYTES
  )
    return {
      ok: false,
      error: `the manifest is larger than ${DEVICE_MANIFEST_MAX_BYTES} bytes`,
    };
  return { ok: true, manifest };
}

function firstIssue(
  error: { issues: Array<{ path: PropertyKey[]; message: string }> },
  prefix?: string
): string {
  const i = error.issues[0];
  const path = [prefix, ...(i?.path ?? []).map(String)]
    .filter(Boolean)
    .join(".");
  return `${path || "manifest"}: ${i?.message ?? "invalid"}`;
}

// ─── Several processes report one device ────────────────────────────────────

/**
 * Who on the device sent a report: one computer runs several Synap processes
 * (the worker's host runner, the waker, a one-shot `synap login`), each
 * knowing only PART of what the device can do. A report names its reporter;
 * the pod keeps each reporter's latest capabilities apart, so one process
 * never erases another's.
 */
export const DEVICE_REPORTER = /^[a-z][a-z0-9-]{0,31}$/;

/** The reporter a door uses when the report names none. */
export const DEVICE_DEFAULT_REPORTER = "runner";

/**
 * A reporter's capabilities count while it reported within this window: a
 * process that stopped (its capabilities are gone with it) drops out by
 * itself. A live reporter refreshes it on every report, with or without a
 * manifest, so a process should report at least every 10 minutes.
 */
export const DEVICE_CAPABILITY_TTL_MS = 30 * 60 * 1000;

/**
 * The most reporters a device keeps: each report drops those older than the
 * TTL, then the oldest beyond this many, so a device whose processes come
 * and go under new names never grows without bound.
 */
export const DEVICE_CAPABILITY_REPORTERS_MAX = 16;

/** Each reporter's latest capabilities and when it last reported. */
export type DeviceCapabilityReports = Record<
  string,
  { capabilities: string[]; at: string }
>;

/**
 * THE capabilities of a device at `now`: the union of every reporter that
 * reported within {@link DEVICE_CAPABILITY_TTL_MS}, sorted. Null when no
 * reporter ever said any (the caller then reads the manifest as stored).
 */
export function effectiveDeviceCapabilities(
  reports: DeviceCapabilityReports | null | undefined,
  now: Date | number = Date.now()
): string[] | null {
  const entries = Object.values(reports ?? {});
  if (entries.length === 0) return null;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const live = new Set<string>();
  for (const r of entries) {
    const at = new Date(r.at).getTime();
    if (Number.isNaN(at) || nowMs - at > DEVICE_CAPABILITY_TTL_MS) continue;
    for (const c of r.capabilities ?? []) live.add(c);
  }
  return [...live].sort();
}

/**
 * The reports after `reporter` reported at `now`: its capabilities replaced
 * when the report carries a list (`[]` = this reporter has none), kept (and
 * their time refreshed) when it carries none (unknown). The other reporters
 * older than {@link DEVICE_CAPABILITY_TTL_MS} are dropped, then the oldest
 * beyond {@link DEVICE_CAPABILITY_REPORTERS_MAX}.
 */
export function recordCapabilityReport(
  reports: DeviceCapabilityReports | null | undefined,
  reporter: string,
  capabilities: string[] | undefined,
  now: Date
): DeviceCapabilityReports {
  const prev = (reports ?? {})[reporter];
  const nowMs = now.getTime();
  const others = Object.entries(reports ?? {})
    .filter(([k]) => k !== reporter)
    .map(([k, v]) => [k, v, new Date(v.at).getTime()] as const)
    .filter(
      ([, , at]) => !Number.isNaN(at) && nowMs - at <= DEVICE_CAPABILITY_TTL_MS
    )
    .sort((a, b) => b[2] - a[2])
    .slice(0, DEVICE_CAPABILITY_REPORTERS_MAX - 1);
  return {
    ...Object.fromEntries(others.map(([k, v]) => [k, v])),
    [reporter]: {
      capabilities: capabilities ?? prev?.capabilities ?? [],
      at: now.toISOString(),
    },
  };
}

/**
 * A report merged into the stored manifest, section by section: a section
 * the report carries replaces the stored one, a section it leaves out is
 * KEPT (the waker that knows nothing of disks never erases them). The
 * `capabilities` of the result are the given union, never one report's.
 */
export function mergeDeviceManifest(
  stored: DeviceManifest | null | undefined,
  incoming: DeviceManifest,
  capabilities: string[] | null
): DeviceManifest {
  const merged: DeviceManifest = {
    ...(stored ?? {}),
    manifestVersion: DEVICE_MANIFEST_VERSION,
  };
  for (const key of [
    "identity",
    "resources",
    "parameters",
    "location",
    "health",
  ] as const) {
    if (incoming[key] !== undefined)
      (merged as Record<string, unknown>)[key] = incoming[key];
  }
  if (capabilities !== null) merged.capabilities = capabilities;
  else if (incoming.capabilities !== undefined)
    merged.capabilities = incoming.capabilities;
  return merged;
}

// ─── Status: a read verdict ─────────────────────────────────────────────────

export const DEVICE_STATUSES = [
  "online",
  "offline",
  "degraded",
  "unknown",
  "retired",
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * A device that reported within this window is reachable. The runner polls
 * every 30 s when idle and the pod records a report at most once a minute
 * (`DEVICE_REPORT_WRITE_MS`), so five minutes is five missed writes.
 */
export const DEVICE_ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** The pod writes a report with no new manifest at most this often. */
export const DEVICE_REPORT_WRITE_MS = 60 * 1000;

/**
 * THE status of a device, at read time:
 * - `unknown`: it never reported (a manual device, or a computer whose runner
 *   has not run since the registry existed);
 * - `offline`: its last report is older than the window;
 * - `degraded`: it reports, and says its own health is degraded or failing;
 * - `online`: it reports;
 * - `retired`: the person removed it (a revoked computer): whatever it last
 *   said, it is not a device that is merely off, and a reconnect brings it
 *   back.
 */
export function deriveDeviceStatus(
  device: {
    lastReportAt: Date | string | null;
    retiredAt?: Date | string | null;
    manifest?: { health?: { state?: string } | null } | null;
  },
  now: Date | number = Date.now()
): DeviceStatus {
  if (device.retiredAt) return "retired";
  if (!device.lastReportAt) return "unknown";
  const at = new Date(device.lastReportAt).getTime();
  if (Number.isNaN(at)) return "unknown";
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (nowMs - at > DEVICE_ONLINE_WINDOW_MS) return "offline";
  const health = device.manifest?.health?.state;
  if (health === "degraded" || health === "failing") return "degraded";
  return "online";
}

// ─── Resources summary ──────────────────────────────────────────────────────

/** What a list row shows of a device's resources. Absent = not reported. */
export interface DeviceResourcesSummary {
  cpuModel: string | null;
  cpuCores: number | null;
  memoryMb: number | null;
  gpus: Array<{ model: string; vramMb: number | null }>;
  /** Summed over the reported disks; null when none was reported. */
  diskSizeMb: number | null;
  diskFreeMb: number | null;
  /** Whole percent used over the reported disks; null when none. */
  diskUsedPct: number | null;
}

export function summarizeDeviceResources(
  manifest: Pick<DeviceManifest, "resources"> | null | undefined
): DeviceResourcesSummary {
  const r = manifest?.resources;
  const disks = r?.disks ?? [];
  const size = disks.reduce((n, d) => n + d.sizeMb, 0);
  const free = disks.reduce((n, d) => n + Math.min(d.freeMb, d.sizeMb), 0);
  return {
    cpuModel: r?.cpu?.model ?? null,
    cpuCores: r?.cpu?.cores ?? null,
    memoryMb: r?.memoryMb ?? null,
    gpus: (r?.gpus ?? []).map((g) => ({
      model: g.model,
      vramMb: g.vramMb ?? null,
    })),
    diskSizeMb: disks.length ? size : null,
    diskFreeMb: disks.length ? free : null,
    diskUsedPct:
      disks.length && size > 0
        ? Math.round(((size - free) / size) * 100)
        : null,
  };
}

// ─── What the pod answers ───────────────────────────────────────────────────

/** Whose device it is (the 0388 words, shared with computers). */
export const DEVICE_BELONGS_TO = ["person", "agent", "shared"] as const;
export type DeviceBelongsTo = (typeof DEVICE_BELONGS_TO)[number];

/** One device as `fleet.list` / `fleet.get` answer it. */
export interface FleetDevice {
  id: string;
  kind: string;
  name: string;
  parentDeviceId: string | null;
  /** The machine user when it runs the Synap runner (`computers[].agentUserId`). */
  principalUserId: string | null;
  ownerUserId: string;
  workspaceId: string | null;
  belongsTo: DeviceBelongsTo;
  connection: DeviceConnection;
  labels: string[];
  status: DeviceStatus;
  lastReportAt: string | null;
  createdAt: string;
  retiredAt: string | null;
  identity: DeviceIdentity;
  resources: DeviceResourcesSummary;
  capabilities: string[];
  location: DeviceLocation | null;
  health: DeviceHealth | null;
}

/** A device in the tree: its children are the devices it hosts. */
export type FleetDeviceNode = DeviceTreeNode<FleetDevice>;

/** `fleet.get`: the device with its whole manifest, as last reported. */
export interface FleetDeviceDetail extends FleetDevice {
  manifest: DeviceManifest | null;
}

/**
 * What the pod answers a runner's report (`POST /computers/me/report`, and
 * `device` on `POST /host-jobs/lease`):
 * - `accepted`: the manifest is stored;
 * - `absent`: the call carried none, only the report time moved;
 * - `refused`: the manifest is not v1 (`error` names the field); the report
 *   time still moved, the last good manifest is kept.
 * `recorded: false` = the pod could not record this report (`error`); the
 * runner's call itself succeeded.
 */
export interface DeviceReportAck {
  recorded: boolean;
  deviceId: string | null;
  manifest: "accepted" | "absent" | "refused";
  error?: string;
}

/** A device in a tree built by {@link buildDeviceTree}. */
export type DeviceTreeNode<T> = T & { children: DeviceTreeNode<T>[] };

/**
 * Builds the tree from flat devices: a device whose parent is not in the list
 * is a root. Order is kept (the caller sorts). A parent cycle cannot hang it:
 * every device is placed once, and a cycle's members are roots.
 */
export function buildDeviceTree<
  T extends { id: string; parentDeviceId: string | null },
>(devices: readonly T[]): DeviceTreeNode<T>[] {
  const nodes = new Map<string, DeviceTreeNode<T>>();
  for (const d of devices) nodes.set(d.id, { ...d, children: [] });
  const roots: DeviceTreeNode<T>[] = [];
  for (const d of devices) {
    const node = nodes.get(d.id)!;
    const parent = d.parentDeviceId ? nodes.get(d.parentDeviceId) : undefined;
    if (parent && !isAncestor(node, parent, nodes)) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** True when `node` is `candidate` or one of its ancestors (a cycle guard). */
function isAncestor<N extends { id: string; parentDeviceId: string | null }>(
  node: N,
  candidate: N,
  nodes: Map<string, N>
): boolean {
  const seen = new Set<string>();
  let cur: N | undefined = candidate;
  while (cur && !seen.has(cur.id)) {
    if (cur.id === node.id) return true;
    seen.add(cur.id);
    cur = cur.parentDeviceId ? nodes.get(cur.parentDeviceId) : undefined;
  }
  return false;
}
