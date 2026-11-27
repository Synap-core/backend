/**
 * The device registry's doors (devices plan 767a5978 §3, P1; decision
 * 78fc3fa1: internal namespace `fleet`, product word "Devices").
 *
 * WRITES — two, both for a computer that runs the Synap runner:
 * - {@link ensureComputerDevice}: a computer is enrolled (the device flow's
 *   `ensureMachineAgent`). It gets its device row, once: one device per
 *   principal (`devices_principal_uidx`), so a reconnect reuses it.
 * - {@link recordDeviceReport}: the runner reports (`POST /host-jobs/lease`,
 *   `POST /computers/me/report`, the waker's `GET /computers/me/wakes`). The
 *   report time moves; a v1 manifest, when sent, is stored. A manifest the
 *   pod cannot read is refused with the field that failed and NEVER fails
 *   the call it rode on: an older CLI that sends none keeps working.
 *
 * READS — `fleet.list` / `fleet.get` and the MCP `devices[]`, through the
 * access layer (`scopedDb`, registry rule on `devices`): a person reads their
 * own devices and the shared devices of their spaces. Status is the read
 * verdict `deriveDeviceStatus`, never stored.
 */

import { createLogger } from "@synap-core/core";
import { and, asc, db, eq, isNull } from "@synap/database";
import {
  devices,
  users,
  type AgentMetadata,
  type Device,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  DEVICE_DEFAULT_REPORTER,
  DEVICE_MANIFEST_VERSION,
  DEVICE_REPORTER,
  DEVICE_REPORT_WRITE_MS,
  DeviceManifestSchema,
  buildDeviceTree,
  deriveDeviceStatus,
  effectiveDeviceCapabilities,
  mergeDeviceManifest,
  parseDeviceManifest,
  recordCapabilityReport,
  summarizeDeviceResources,
  type DeviceCapabilityReports,
  type DeviceConnection,
  type DeviceManifest,
  type DeviceReportAck,
  type FleetDevice,
  type FleetDeviceDetail,
  type FleetDeviceNode,
} from "@synap-core/types/device-manifest";
import { scopedDb, type AccessContext } from "../../access/index.js";
import { machineName } from "../machine-roster.js";

const logger = createLogger({ module: "fleet/devices" });

// ── Enrolment ───────────────────────────────────────────────────────────────

/**
 * The device of computer `machineUserId`, made when it has none: kind
 * `computer`, connection `agent`, owned by the person who approved it, named
 * as the person reads it (`machineName`), its identity from what the
 * terminal sent (`agent_metadata`: hostname, platform, arch). A device the
 * person retired comes back when the computer is connected again.
 *
 * Returns the device id, or null for a row that is not a computer with a
 * person behind it (nothing to own it).
 */
export async function ensureComputerDevice(
  machineUserId: string
): Promise<string | null> {
  const existing = await deviceOfPrincipal(machineUserId);
  if (existing) {
    if (existing.retiredAt)
      await db
        .update(devices)
        .set({ retiredAt: null, updatedAt: new Date() })
        .where(eq(devices.id, existing.id));
    return existing.id;
  }
  const [m] = await db
    .select({
      name: users.name,
      owner: users.createdByUserId,
      meta: users.agentMetadata,
      belongsTo: users.computerBelongsTo,
    })
    .from(users)
    .where(
      and(eq(users.id, machineUserId), eq(users.agentType, MACHINE_AGENT_TYPE))
    )
    .limit(1);
  if (!m?.owner) return null;
  const meta = (m.meta ?? {}) as AgentMetadata;
  const identity = parseDeviceManifest({
    manifestVersion: DEVICE_MANIFEST_VERSION,
    identity: {
      ...(word(meta.hostname, 253) ? { hostname: word(meta.hostname, 253) } : {}),
      ...(word(meta.platform, 64) ? { os: word(meta.platform, 64) } : {}),
      ...(word(meta.arch, 32) ? { arch: word(meta.arch, 32) } : {}),
    },
  });
  try {
    const [row] = await db
      .insert(devices)
      .values({
        ownerUserId: m.owner,
        belongsTo: m.belongsTo ?? "person",
        kind: "computer",
        name: machineName({ name: m.name, agentMetadata: m.meta }).slice(0, 200),
        principalUserId: machineUserId,
        connection: { mode: "agent" },
        manifest: identity.ok ? identity.manifest : null,
      })
      .returning({ id: devices.id });
    return row?.id ?? null;
  } catch (err) {
    // Two doors raced for the same principal: the unique index kept one.
    const raced = await deviceOfPrincipal(machineUserId);
    if (raced) return raced.id;
    throw err;
  }
}

function word(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

async function deviceOfPrincipal(machineUserId: string) {
  const [row] = await db
    .select({
      id: devices.id,
      kind: devices.kind,
      manifest: devices.manifest,
      capabilityReports: devices.capabilityReports,
      lastReportAt: devices.lastReportAt,
      retiredAt: devices.retiredAt,
    })
    .from(devices)
    .where(eq(devices.principalUserId, machineUserId))
    .limit(1);
  return row ?? null;
}

// ── A runner's report ───────────────────────────────────────────────────────

/**
 * Record that computer `machineUserId` reported, with its manifest when the
 * process sent one (`manifest` undefined or null = none). Never throws: the
 * report rides on a call that must answer whatever happens here, so a failure
 * comes back as `recorded: false` with the reason (and is logged).
 *
 * One computer runs several processes (the host runner, the waker, a one-shot
 * `synap login`), each knowing only part of the device: `reporter` names the
 * one reporting. A manifest is MERGED section by section (a section the
 * report leaves out keeps the stored one), and each reporter's capabilities
 * are kept apart (`capability_reports`): the device's capabilities are the
 * union of the reporters seen within `DEVICE_CAPABILITY_TTL_MS`, so neither
 * process erases the other's and a stopped one drops out by itself.
 *
 * Writes at most once a minute when nothing changed
 * ({@link DEVICE_REPORT_WRITE_MS}); a changed manifest or capability set is
 * written at once. A refused manifest keeps the last good one.
 */
export async function recordDeviceReport(args: {
  machineUserId: string;
  manifest?: unknown;
  /** Which process reports (`DEVICE_REPORTER`); the door's default else. */
  reporter?: string;
  now?: Date;
}): Promise<DeviceReportAck> {
  const now = args.now ?? new Date();
  const sent = args.manifest !== undefined && args.manifest !== null;
  const reporter =
    args.reporter && DEVICE_REPORTER.test(args.reporter)
      ? args.reporter
      : DEVICE_DEFAULT_REPORTER;
  try {
    let row = await deviceOfPrincipal(args.machineUserId);
    if (!row) {
      await ensureComputerDevice(args.machineUserId);
      row = await deviceOfPrincipal(args.machineUserId);
    }
    if (!row)
      return {
        recorded: false,
        deviceId: null,
        manifest: sent ? "refused" : "absent",
        error: "This key is not a connected computer of a person.",
      };
    const parsed = sent
      ? parseDeviceManifest(args.manifest, { kind: row.kind })
      : null;
    const incoming = parsed?.ok ? parsed.manifest : null;
    const reports = recordCapabilityReport(
      row.capabilityReports,
      reporter,
      incoming?.capabilities,
      now
    );
    const stored = storedManifest(row);
    const manifest = incoming
      ? mergeDeviceManifest(
          stored,
          incoming,
          effectiveDeviceCapabilities(reports, now)
        )
      : stored;
    const changed =
      stableJson(manifest) !== stableJson(stored) ||
      stableJson(capabilitySets(reports)) !==
        stableJson(capabilitySets(row.capabilityReports));
    const due =
      !row.lastReportAt ||
      now.getTime() - row.lastReportAt.getTime() >= DEVICE_REPORT_WRITE_MS;
    if (changed || due) {
      await db
        .update(devices)
        .set({
          lastReportAt: now,
          updatedAt: now,
          capabilityReports: reports,
          ...(manifest !== stored ? { manifest } : {}),
        })
        .where(eq(devices.id, row.id));
    }
    if (parsed && !parsed.ok)
      return {
        recorded: true,
        deviceId: row.id,
        manifest: "refused",
        error: parsed.error,
      };
    return {
      recorded: true,
      deviceId: row.id,
      manifest: sent ? "accepted" : "absent",
    };
  } catch (err) {
    logger.warn(
      { err, machineUserId: args.machineUserId },
      "device report not recorded"
    );
    return {
      recorded: false,
      deviceId: null,
      manifest: sent ? "refused" : "absent",
      error: "The pod could not record this report; the next one will.",
    };
  }
}

/** Each reporter's capability set, without its report time. */
function capabilitySets(
  reports: DeviceCapabilityReports | null | undefined
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(reports ?? {}).map(([k, v]) => [
      k,
      [...(v.capabilities ?? [])].sort(),
    ])
  );
}

/** JSON with sorted keys: jsonb reorders keys, so a plain stringify differs. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : val
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** A stored manifest, read back: a row that no longer parses reads as none. */
function storedManifest(
  row: Pick<Device, "id" | "manifest">
): DeviceManifest | null {
  if (!row.manifest) return null;
  const parsed = DeviceManifestSchema.safeParse(row.manifest);
  if (parsed.success) return parsed.data;
  logger.warn({ deviceId: row.id }, "stored device manifest is not v1");
  return null;
}

/** One device row as the fleet reads it, its status derived at `now`. */
export function toFleetDevice(
  row: Device,
  now: Date = new Date()
): FleetDeviceDetail {
  const stored = storedManifest(row);
  // The capabilities are the live reporters' union at `now`; a device no
  // process reports for (a bridge's, a manual one) keeps its manifest's.
  const live = effectiveDeviceCapabilities(row.capabilityReports, now);
  const manifest =
    stored && live !== null ? { ...stored, capabilities: live } : stored;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentDeviceId: row.parentDeviceId ?? null,
    principalUserId: row.principalUserId ?? null,
    ownerUserId: row.ownerUserId,
    workspaceId: row.workspaceId ?? null,
    belongsTo: row.belongsTo,
    connection: (row.connection ?? { mode: "manual" }) as DeviceConnection,
    labels: row.labels ?? [],
    status: deriveDeviceStatus(
      { lastReportAt: row.lastReportAt, retiredAt: row.retiredAt, manifest },
      now
    ),
    lastReportAt: row.lastReportAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
    identity: manifest?.identity ?? {},
    resources: summarizeDeviceResources(manifest),
    capabilities: live ?? manifest?.capabilities ?? [],
    location: manifest?.location ?? null,
    health: manifest?.health ?? null,
    manifest,
  };
}

/** Without the whole manifest: what a list row carries. */
function listRow(d: FleetDeviceDetail): FleetDevice {
  const { manifest: _manifest, ...rest } = d;
  return rest;
}

/**
 * The devices `access` may read, flat, oldest first (a host before the VMs
 * made on it). Retired devices only when asked.
 */
export async function listFleetDevices(
  access: AccessContext,
  opts: { includeRetired?: boolean; now?: Date } = {}
): Promise<FleetDevice[]> {
  const rows = await scopedDb(access).findMany<Device>(devices, {
    ...(opts.includeRetired ? {} : { where: isNull(devices.retiredAt) }),
    orderBy: [asc(devices.createdAt), asc(devices.id)],
  });
  const now = opts.now ?? new Date();
  return rows.map((r) => listRow(toFleetDevice(r, now)));
}

/** The same devices as a tree: each device under the one it runs on. */
export async function readFleetTree(
  access: AccessContext,
  opts: { includeRetired?: boolean; now?: Date } = {}
): Promise<FleetDeviceNode[]> {
  return buildDeviceTree(await listFleetDevices(access, opts));
}

/** One device `access` may read, with its whole manifest; null otherwise. */
export async function getFleetDevice(
  access: AccessContext,
  id: string,
  now: Date = new Date()
): Promise<FleetDeviceDetail | null> {
  const row = await scopedDb(access).findFirst<Device>(devices, {
    where: eq(devices.id, id),
  });
  return row ? toFleetDevice(row, now) : null;
}

// ── `device` as an alias of `computer` (agent doors) ────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The computer an agent door's `computer` / `computerId` names, when the
 * caller named it by its DEVICE instead (`device` / `deviceId`, devices plan
 * 767a5978 §2: aliases, never a code rename). A device id the caller may read
 * whose device runs the Synap runner answers its computer (the machine user
 * id every computer door takes); any other value is passed through as it is
 * (a computer's id or name, "mac", "pod"), so the door's own lookup and its
 * refusals stay the ones it has. Both names given and naming different
 * computers is refused.
 */
export async function computerFromDeviceArgs(
  access: AccessContext,
  args: { computer?: unknown; device?: unknown }
): Promise<{ ok: true; computer: string | undefined } | { ok: false; error: string }> {
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const computer = text(args.computer);
  const device = text(args.device);
  if (device === undefined) return { ok: true, computer };
  let viaDevice = device;
  if (UUID.test(device)) {
    const row = await getFleetDevice(access, device);
    if (row && !row.principalUserId)
      return {
        ok: false,
        error: `The device "${row.name}" runs no Synap runner: name one of the person's computers.`,
      };
    if (row?.principalUserId) viaDevice = row.principalUserId;
  }
  if (computer !== undefined && computer !== viaDevice && computer !== device)
    return {
      ok: false,
      error: "`computer` and `device` name two different computers: pass one.",
    };
  return { ok: true, computer: computer ?? viaDevice };
}

/**
 * One device as an agent reads it in `synap_list_agents` `devices[]`: what it
 * is, whether it answers, what it has. Compact on purpose (the reply is read
 * by a model): the whole manifest is `fleet.get`'s.
 */
export function agentDeviceRow(d: FleetDevice) {
  return {
    id: d.id,
    kind: d.kind,
    name: d.name,
    status: d.status,
    lastReportAt: d.lastReportAt,
    parentDeviceId: d.parentDeviceId,
    principalUserId: d.principalUserId,
    belongsTo: d.belongsTo,
    os: d.identity.os ?? null,
    arch: d.identity.arch ?? null,
    resources: {
      cpuCores: d.resources.cpuCores,
      memoryMb: d.resources.memoryMb,
      gpus: d.resources.gpus,
      diskSizeMb: d.resources.diskSizeMb,
      diskFreeMb: d.resources.diskFreeMb,
    },
    capabilities: d.capabilities,
    labels: d.labels,
  };
}
