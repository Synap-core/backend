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
import { and, asc, db, drizzleSql, eq, isNull } from "@synap/database";
import {
  devices,
  users,
  type AgentMetadata,
  type Device,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import { isUuid } from "@synap-core/types/property-render";
import {
  DEVICE_CAPABILITY_REPORTERS_MAX,
  DEVICE_CAPABILITY_TTL_MS,
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
  type DeviceIdentity,
  type DeviceManifest,
  type DeviceReportAck,
  type FleetDevice,
  type FleetDeviceDetail,
  type FleetDeviceNode,
} from "@synap-core/types/device-manifest";
import { scopedDb, type AccessContext } from "../../access/index.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import { machineName } from "../machine-roster.js";

const logger = createLogger({ module: "fleet/devices" });

/**
 * What a report reads of its device. `rev` is `updated_at` in whole
 * microseconds, as text: the manifest merge writes only over the row it read
 * (a JS Date would drop the microseconds and never match).
 */
const REPORT_COLUMNS = {
  id: devices.id,
  kind: devices.kind,
  manifest: devices.manifest,
  capabilityReports: devices.capabilityReports,
  lastReportAt: devices.lastReportAt,
  retiredAt: devices.retiredAt,
  rev: drizzleSql<string>`(extract(epoch from ${devices.updatedAt}) * 1000000)::bigint::text`,
};

type ReportRow = {
  id: string;
  kind: string;
  manifest: DeviceManifest | null;
  capabilityReports: Device["capabilityReports"];
  lastReportAt: Date | null;
  retiredAt: Date | null;
  rev: string;
};

const sameRev = (rev: string) =>
  drizzleSql`(extract(epoch from ${devices.updatedAt}) * 1000000)::bigint::text = ${rev}`;

// ── Enrolment ───────────────────────────────────────────────────────────────

/**
 * The device of computer `machineUserId`, made when it has none: kind
 * `computer`, connection `agent`, owned by the person who approved it, named
 * as the person reads it (`machineName`), its identity from what the
 * terminal sent (`agent_metadata`: hostname, platform, arch).
 *
 * A device that exists already is kept, never twinned. A reconnect brings a
 * retired one back and refreshes its identity from `agent_metadata` when the
 * terminal now says something else (a renamed host, a reinstalled OS).
 *
 * Returns the device row, or null for a row that is not a computer with a
 * person behind it (nothing to own it).
 */
export async function ensureComputerDevice(
  machineUserId: string
): Promise<ReportRow | null> {
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
  const fresh = m ? identityOf(m.meta) : {};
  const existing = await deviceOfPrincipal(machineUserId);
  if (existing) {
    const stale = staleIdentity(existing.manifest?.identity, fresh);
    if (!existing.retiredAt && !stale) return existing;
    const [row] = await db
      .update(devices)
      .set({
        retiredAt: null,
        updatedAt: new Date(),
        ...(stale
          ? {
              manifest: drizzleSql`jsonb_set(
                COALESCE(${devices.manifest}, ${JSON.stringify({ manifestVersion: DEVICE_MANIFEST_VERSION })}::jsonb),
                '{identity}',
                COALESCE(${devices.manifest}->'identity', '{}'::jsonb) || ${JSON.stringify(fresh)}::jsonb
              )`,
            }
          : {}),
      })
      .where(eq(devices.id, existing.id))
      .returning(REPORT_COLUMNS);
    return (row as ReportRow | undefined) ?? existing;
  }
  if (!m?.owner) return null;
  const identity = parseDeviceManifest({
    manifestVersion: DEVICE_MANIFEST_VERSION,
    identity: fresh,
  });
  try {
    const [row] = await db
      .insert(devices)
      .values({
        ownerUserId: m.owner,
        belongsTo: m.belongsTo ?? "person",
        kind: "computer",
        name: machineName({ name: m.name, agentMetadata: m.meta }).slice(
          0,
          200
        ),
        principalUserId: machineUserId,
        connection: { mode: "agent" },
        manifest: identity.ok ? identity.manifest : null,
      })
      .returning(REPORT_COLUMNS);
    return (row as ReportRow | undefined) ?? null;
  } catch (err) {
    // Two doors raced for the same principal: the unique index kept one.
    const raced = await deviceOfPrincipal(machineUserId);
    if (raced) return raced;
    throw err;
  }
}

/** The identity the terminal sent at enrolment (`agent_metadata`). */
function identityOf(
  metaRaw: unknown
): Pick<DeviceIdentity, "hostname" | "os" | "arch"> {
  const meta = (metaRaw ?? {}) as AgentMetadata;
  const hostname = word(meta.hostname, 253);
  const os = word(meta.platform, 64);
  const arch = word(meta.arch, 32);
  return {
    ...(hostname ? { hostname } : {}),
    ...(os ? { os } : {}),
    ...(arch ? { arch } : {}),
  };
}

/** True when the terminal now says something the stored identity does not. */
function staleIdentity(
  stored: DeviceIdentity | undefined,
  fresh: Pick<DeviceIdentity, "hostname" | "os" | "arch">
): boolean {
  return (Object.keys(fresh) as Array<keyof typeof fresh>).some(
    (k) => stored?.[k] !== fresh[k]
  );
}

function word(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

async function deviceOfPrincipal(
  machineUserId: string
): Promise<ReportRow | null> {
  const [row] = await db
    .select(REPORT_COLUMNS)
    .from(devices)
    .where(eq(devices.principalUserId, machineUserId))
    .limit(1);
  return (row as ReportRow | undefined) ?? null;
}

// ── A runner's report ───────────────────────────────────────────────────────

/**
 * Record that computer `machineUserId` reported, with its manifest when the
 * process sent one (`manifest` undefined or null = none). Never throws: the
 * report rides on a call that must answer whatever happens here, so a failure
 * comes back as `recorded: false` with the reason (and is logged).
 *
 * One computer runs several processes (the host runner, the worker, the
 * waker), each knowing only part of the device: `reporter` names the one
 * reporting. A manifest is MERGED section by section (a section the report
 * leaves out keeps the stored one), and each reporter's capabilities are kept
 * apart (`capability_reports`): the device's capabilities are the union of
 * the reporters seen within `DEVICE_CAPABILITY_TTL_MS`, so neither process
 * erases the other's and a stopped one drops out by itself.
 *
 * Concurrent reports never lose each other:
 * - a reporter's own entry is set in one statement over the stored value
 *   (`reportEntriesAfter`), so two processes never overwrite each other's;
 * - the manifest merge writes only over the row it read (`rev`); a report
 *   that lost the race reads again and merges once more.
 *
 * Writes at most once a minute per reporter when nothing changed
 * ({@link DEVICE_REPORT_WRITE_MS}); a changed manifest or capability set is
 * written at once. A refused manifest keeps the last good one.
 */
export async function recordDeviceReport(args: {
  machineUserId: string;
  manifest?: unknown;
  /**
   * Which process reports (`DEVICE_REPORTER`), as the body sent it; anything
   * else is the door's default.
   */
  reporter?: unknown;
  now?: Date;
}): Promise<DeviceReportAck> {
  const now = args.now ?? new Date();
  const sent = args.manifest !== undefined && args.manifest !== null;
  const reporter =
    typeof args.reporter === "string" && DEVICE_REPORTER.test(args.reporter)
      ? args.reporter
      : DEVICE_DEFAULT_REPORTER;
  try {
    let row =
      (await deviceOfPrincipal(args.machineUserId)) ??
      (await ensureComputerDevice(args.machineUserId));
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
    const capabilities = incoming?.capabilities;
    let lostRace = false;
    for (let attempt = 0; ; attempt++) {
      const stored = storedManifest(row);
      const manifest = incoming
        ? mergeDeviceManifest(
            stored,
            incoming,
            effectiveDeviceCapabilities(
              recordCapabilityReport(
                row.capabilityReports,
                reporter,
                capabilities,
                now
              ),
              now
            )
          )
        : stored;
      const manifestChanged =
        incoming !== null &&
        stableStringify(manifest) !== stableStringify(stored);
      const own = row.capabilityReports?.[reporter];
      const capabilitiesChanged =
        capabilities !== undefined &&
        stableStringify([...capabilities].sort()) !==
          stableStringify([...(own?.capabilities ?? [])].sort());
      if (
        !manifestChanged &&
        !capabilitiesChanged &&
        !reportDue(row, reporter, now)
      )
        break;
      if (!manifestChanged) {
        await writeReport(row.id, { reporter, capabilities, now });
        break;
      }
      if (
        await writeReport(row.id, {
          reporter,
          capabilities,
          now,
          manifest: { value: manifest, overRev: row.rev },
        })
      )
        break;
      const reread =
        attempt === 0 ? await deviceOfPrincipal(args.machineUserId) : null;
      if (!reread) {
        // Lost twice (or the row went): the report time and this process's
        // entry still land; its manifest waits for its next report.
        lostRace = true;
        await writeReport(row.id, { reporter, capabilities, now });
        break;
      }
      row = reread;
    }
    if (parsed && !parsed.ok)
      return {
        recorded: true,
        deviceId: row.id,
        manifest: "refused",
        error: parsed.error,
      };
    if (lostRace)
      return {
        recorded: true,
        deviceId: row.id,
        manifest: "refused",
        error:
          "Another report changed this device at the same time; the next report stores this manifest.",
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

/**
 * A report with nothing new is written when the row has not been written for
 * a minute, OR when THIS reporter's own time is a minute old: two processes
 * reporting out of phase must each move their own time, or the one that
 * never wins the row's minute would see its capabilities expire while alive.
 */
function reportDue(row: ReportRow, reporter: string, now: Date): boolean {
  const nowMs = now.getTime();
  if (
    !row.lastReportAt ||
    nowMs - row.lastReportAt.getTime() >= DEVICE_REPORT_WRITE_MS
  )
    return true;
  const ownAt = Date.parse(row.capabilityReports?.[reporter]?.at ?? "");
  return !(nowMs - ownAt < DEVICE_REPORT_WRITE_MS);
}

/**
 * One report written. The reporter's entry is set over the STORED reports in
 * the same statement; with `manifest`, the row is written only when it is
 * still the one read (`overRev`). Returns false when that row moved.
 */
async function writeReport(
  deviceId: string,
  w: {
    reporter: string;
    capabilities: string[] | undefined;
    now: Date;
    manifest?: { value: DeviceManifest | null; overRev: string };
  }
): Promise<boolean> {
  const rows = await db
    .update(devices)
    .set({
      lastReportAt: drizzleSql`GREATEST(${devices.lastReportAt}, ${w.now.toISOString()}::timestamptz)`,
      // Always moves, to the microsecond: the next merge's `rev` sees it.
      updatedAt: drizzleSql`clock_timestamp()`,
      capabilityReports: reportEntriesAfter(w.reporter, w.capabilities, w.now),
      ...(w.manifest ? { manifest: w.manifest.value } : {}),
    })
    .where(
      w.manifest
        ? and(eq(devices.id, deviceId), sameRev(w.manifest.overRev))
        : eq(devices.id, deviceId)
    )
    .returning({ id: devices.id });
  return rows.length > 0;
}

/**
 * The stored reports after `reporter` reported, as SQL over the stored
 * value: the other reporters seen within the TTL (the newest
 * `DEVICE_CAPABILITY_REPORTERS_MAX - 1`), then this one's entry. Its
 * capabilities are replaced when the report carries a list (`[]` = it has
 * none) and kept when it carries none (`recordCapabilityReport`'s rule); its
 * time moves either way.
 */
function reportEntriesAfter(
  reporter: string,
  capabilities: string[] | undefined,
  now: Date
) {
  const cutoff = new Date(
    now.getTime() - DEVICE_CAPABILITY_TTL_MS
  ).toISOString();
  const sent = capabilities === undefined ? null : JSON.stringify(capabilities);
  return drizzleSql`(
    SELECT COALESCE(jsonb_object_agg(s.k, s.v), '{}'::jsonb) FROM (
      SELECT e.k, e.v FROM jsonb_each(${devices.capabilityReports}) AS e(k, v)
      WHERE e.k <> ${reporter}
        AND CASE WHEN e.v->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
              THEN (e.v->>'at')::timestamptz END >= ${cutoff}::timestamptz
      ORDER BY (e.v->>'at')::timestamptz DESC
      LIMIT ${DEVICE_CAPABILITY_REPORTERS_MAX - 1}
    ) s
  ) || jsonb_build_object(
    ${reporter}::text,
    jsonb_build_object(
      'capabilities',
      COALESCE(
        ${sent}::jsonb,
        (${devices.capabilityReports} -> (${reporter}::text)) -> 'capabilities',
        '[]'::jsonb
      ),
      'at',
      ${now.toISOString()}::text
    )
  )`;
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
    parentDeviceId: row.parentDeviceId,
    principalUserId: row.principalUserId,
    ownerUserId: row.ownerUserId,
    workspaceId: row.workspaceId,
    belongsTo: row.belongsTo,
    connection: row.connection,
    labels: row.labels,
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

/**
 * The computer an agent door's `computer` / `computerId` names, when the
 * caller named it by its DEVICE instead (`device` / `deviceId`: aliases,
 * never a code rename). A device id the caller may read
 * whose device runs the Synap runner answers its computer (the machine user
 * id every computer door takes); any other value is passed through as it is
 * (a computer's id or name, "mac", "pod"), so the door's own lookup and its
 * refusals stay the ones it has. Both names given and naming different
 * computers is refused.
 */
export async function computerFromDeviceArgs(
  access: AccessContext,
  args: { computer?: unknown; device?: unknown }
): Promise<
  { ok: true; computer: string | undefined } | { ok: false; error: string }
> {
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const computer = text(args.computer);
  const device = text(args.device);
  if (device === undefined) return { ok: true, computer };
  let viaDevice = device;
  if (isUuid(device)) {
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
