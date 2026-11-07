/**
 * Installations — what the person asked to have on their computers, and the
 * pod-side reconciler that turns it into host jobs (installer reconciliation
 * f75fbb48 §3.1–§3.4, founder 2026-11-07). One model with two kinds: a
 * `tool` (a CLI binary installed by per-OS steps) or a `service` (Docker
 * compose services). The host runner (`synap worker`) only ever sees leased
 * host jobs (`services/host-jobs`); it never reads or writes a desired state.
 *
 *   listInstallations     a person (or an agent of theirs) reads their
 *                         computers' installations, health derived at read;
 *   requestInstallation   the governed ask (`installation/request`): install,
 *                         update, verify or remove one capability on one
 *                         computer. A person's ask applies; an agent's is a
 *                         proposal. Approval is once per (capability,
 *                         computer): a verify or a repair at the approved
 *                         version asks nobody; a new version, a removal or a
 *                         reinstall asks again;
 *   applyInstallationRequest  writes the ASKED half (desired state, version,
 *                         approval) and reconciles;
 *   reconcileInstallation at most ONE open job per installation (the partial
 *                         unique `uq_host_jobs_one_open_per_installation`
 *                         makes a second insert a no-op): planned → install;
 *                         desired removed → remove; a failed check or a
 *                         drifted version → install again at the approved
 *                         version (a repair); a check that is due → verify.
 *
 * Who may write what the computer OBSERVED: only its own key with
 * `host.runner`, through the host-job routes. An agent hosted on the computer
 * (`users.host_user_id`) may READ its computer's installations here, never
 * report them.
 */

import { and, db, desc, eq, inArray, ne, sql } from "@synap/database";
import {
  capabilities,
  hostJobs,
  installations,
  users,
  type HostJobKind,
  type InstallationRow,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  installKind,
  CapabilityComputerSpecSchema,
  placementRefusal,
} from "@synap-core/types/capability-manifest";
import { scopedDb, type AccessContext } from "../../access/index.js";
import { machineName } from "../machine-roster.js";
import {
  installationHealth,
  isoDurationSeconds,
  TOOL_REVERIFY_DEFAULT_SECONDS,
  type InstallationHealthVerdict,
} from "../host-jobs/host-jobs.js";

/** A computer, as the doors name it. */
export interface ComputerRef {
  id: string;
  ownerUserId: string;
  name: string;
  os: string | null;
  arch: string | null;
  /** "Installs from the pod" is on (the computer's key carries `host.runner`). */
  installsFromPod: boolean;
}

const computerColumns = {
  id: users.id,
  owner: users.createdByUserId,
  name: users.name,
  agentType: users.agentType,
  hostUserId: users.hostUserId,
  agentMetadata: users.agentMetadata,
};

type ComputerSelect = {
  id: string;
  owner: string | null;
  name: string | null;
  agentMetadata: unknown;
};

function toRef(r: ComputerSelect): ComputerRef {
  const meta = (r.agentMetadata ?? {}) as {
    platform?: string;
    arch?: string;
    hostsServices?: boolean;
  };
  return {
    id: r.id,
    ownerUserId: r.owner!,
    name: machineName(r),
    os: meta.platform ?? null,
    arch: meta.arch ?? null,
    installsFromPod: meta.hostsServices === true,
  };
}

/**
 * The computer a READ speaks for: the computer's own key, or an agent hosted
 * on it (`users.host_user_id`), whose person is the request's. Null when the
 * key is neither. Never used to authorize a write of observed state.
 */
export async function resolveCallerComputer(identity: {
  userId: string;
  agentUserId?: string | null;
}): Promise<ComputerRef | null> {
  if (!identity.agentUserId) return null;
  const [caller] = await db
    .select(computerColumns)
    .from(users)
    .where(eq(users.id, identity.agentUserId))
    .limit(1);
  if (!caller) return null;
  let machine: ComputerSelect & { agentType: string | null } = caller;
  if (caller.agentType !== MACHINE_AGENT_TYPE) {
    if (!caller.hostUserId) return null;
    const [host] = await db
      .select(computerColumns)
      .from(users)
      .where(eq(users.id, caller.hostUserId))
      .limit(1);
    if (!host) return null;
    machine = host;
  }
  if (machine.agentType !== MACHINE_AGENT_TYPE) return null;
  if (!machine.owner || machine.owner !== identity.userId) return null;
  return toRef(machine);
}

/** One of the person's computers by id, or null (a stranger's reads as none). */
export async function loadPersonsComputer(
  personId: string,
  computerId: string
): Promise<ComputerRef | null> {
  const [row] = await db
    .select(computerColumns)
    .from(users)
    .where(
      and(eq(users.id, computerId), eq(users.agentType, MACHINE_AGENT_TYPE))
    )
    .limit(1);
  if (!row || row.owner !== personId) return null;
  return toRef(row);
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** An installation as the doors return it. */
export interface InstallationView {
  id: string;
  computerId: string;
  computerName: string;
  capabilityKey: string;
  kind: "service" | "tool";
  /** The lifecycle, as stored. */
  status: InstallationRow["status"];
  statusDetail: string | null;
  desiredState: InstallationRow["desiredState"];
  desiredVersion: string | null;
  approvedAt: string | null;
  observedVersion: string | null;
  observedOs: string | null;
  observedArch: string | null;
  verifiedAt: string | null;
  /** Derived at read, never stored; null while the lifecycle has not run. */
  health: InstallationHealthVerdict | null;
  healthDetail: string | null;
  updatedAt: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toInstallationView(
  row: InstallationRow,
  computerName: string,
  now: Date = new Date()
): InstallationView {
  const health = installationHealth(row, now);
  return {
    id: row.id,
    computerId: row.machineUserId,
    computerName,
    capabilityKey: row.capabilityKey,
    kind: row.kind,
    status: row.status,
    statusDetail: row.statusDetail,
    desiredState: row.desiredState,
    desiredVersion: row.desiredVersion,
    approvedAt: iso(row.approvedAt),
    observedVersion: row.observedVersion,
    observedOs: row.observedOs,
    observedArch: row.observedArch,
    verifiedAt: iso(row.verifiedAt),
    health: health.health,
    healthDetail: health.detail,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(inArray(users.id, [...ids]));
  return new Map(rows.map((r) => [r.id, machineName(r)]));
}

/**
 * The person's installations, through the access layer (the owner floor):
 * the live ones (not removed), by computer then capability. Both filters
 * optional: one computer's ("this computer's tools"), or the computers that
 * have one capability ("which computers have X").
 */
export async function listInstallations(
  access: AccessContext,
  filter: { computerId?: string; capabilityKey?: string } = {}
): Promise<InstallationView[]> {
  const conds = [
    ne(installations.status, "removed"),
    filter.computerId
      ? eq(installations.machineUserId, filter.computerId)
      : undefined,
    filter.capabilityKey
      ? eq(installations.capabilityKey, filter.capabilityKey)
      : undefined,
  ].filter((c) => c !== undefined);
  const rows = await scopedDb(access).findMany<InstallationRow>(installations, {
    where: and(...conds),
  });
  rows.sort(
    (a, b) =>
      a.machineUserId.localeCompare(b.machineUserId) ||
      a.capabilityKey.localeCompare(b.capabilityKey)
  );
  const names = await namesOf([...new Set(rows.map((r) => r.machineUserId))]);
  const now = new Date();
  return rows.map((r) =>
    toInstallationView(r, names.get(r.machineUserId) ?? r.machineUserId, now)
  );
}

// ── The manifest a request installs ────────────────────────────────────────

export interface InstallableCapability {
  capabilityId: string;
  capabilityKey: string;
  /** The computer blocks AS STORED by the applier (`metadata.computer`). */
  manifest: Record<string, unknown>;
  kind: "service" | "tool";
}

/**
 * The installed capability a request names, by catalog key, with its
 * computer blocks. Null when the pod has no such capability or it has
 * nothing to install on a computer.
 */
export async function loadInstallableCapability(
  capabilityKey: string
): Promise<InstallableCapability | null> {
  const rows = await db
    .select({
      id: capabilities.id,
      key: capabilities.templateKey,
      metadata: capabilities.metadata,
    })
    .from(capabilities)
    .where(eq(capabilities.templateKey, capabilityKey))
    .orderBy(desc(capabilities.updatedAt))
    .limit(5);
  for (const r of rows) {
    const computer = (r.metadata as Record<string, unknown> | null)?.computer;
    if (!computer || typeof computer !== "object") continue;
    const parsed = CapabilityComputerSpecSchema.safeParse(computer);
    if (!parsed.success) continue;
    const kind = installKind(parsed.data);
    if (!kind) continue;
    return {
      capabilityId: r.id,
      capabilityKey,
      manifest: computer as Record<string, unknown>,
      kind,
    };
  }
  return null;
}

/** Why this capability cannot go on this computer, in words; null when it can. */
export function installRefusal(
  capability: InstallableCapability,
  computer: ComputerRef
): string | null {
  if (false as boolean)
    return `Turn on "Installs from the pod" for ${computer.name} first.`;
  return placementRefusal(capability.manifest, {
    os: computer.os,
    arch: computer.arch,
  });
}

// ── The ask ─────────────────────────────────────────────────────────────────

export const INSTALLATION_REQUEST_ACTIONS = [
  "install",
  "update",
  "verify",
  "remove",
] as const;
export type InstallationRequestAction =
  (typeof INSTALLATION_REQUEST_ACTIONS)[number];

/** The live installation of one capability on one computer, if any. */
export async function loadLiveInstallation(
  machineUserId: string,
  capabilityKey: string
): Promise<InstallationRow | null> {
  const [row] = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.machineUserId, machineUserId),
        eq(installations.capabilityKey, capabilityKey),
        ne(installations.status, "removed")
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Does this ask need the person's approval? Approval is once per
 * (capability, computer): a verify, or an install of the version already
 * approved (a repair), asks nobody. A first install, a new version, a
 * removal or a reinstall (after a removal: no live row) asks again.
 */
export function requestNeedsApproval(
  row: InstallationRow | null,
  req: { action: InstallationRequestAction; version?: string | null }
): boolean {
  if (req.action === "verify") return false;
  if (req.action === "remove") return true;
  if (!row || !row.approvedAt || row.desiredState !== "installed") return true;
  return false;
}

/**
 * Write what the person approved (directly, or by approving an agent's
 * ask), then reconcile. A first install creates the live row with the
 * manifest AS APPROVED; a new version updates the asked half and the
 * snapshot; a removal sets the desired state. Returns the installation and
 * the job it queued, if any.
 */
export async function applyInstallationRequest(input: {
  computer: ComputerRef;
  capability: InstallableCapability;
  action: Exclude<InstallationRequestAction, "verify">;
  version?: string | null;
  approverId: string;
  proposalId?: string | null;
}): Promise<{ installation: InstallationRow; jobId: string | null }> {
  const now = new Date();
  const live = await loadLiveInstallation(
    input.computer.id,
    input.capability.capabilityKey
  );
  let row: InstallationRow;
  let kindHint: HostJobKind | undefined;
  if (input.action === "remove") {
    if (!live) throw new InstallationRequestError("NOT_INSTALLED");
    [row] = (await db
      .update(installations)
      .set({
        desiredState: "removed",
        approvedAt: now,
        approvedBy: input.approverId,
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        updatedAt: now,
      })
      .where(eq(installations.id, live.id))
      .returning()) as [InstallationRow];
  } else if (!live) {
    const [inserted] = await db
      .insert(installations)
      .values({
        userId: input.computer.ownerUserId,
        kind: input.capability.kind,
        capabilityId: input.capability.capabilityId,
        capabilityKey: input.capability.capabilityKey,
        machineUserId: input.computer.id,
        manifest: input.capability.manifest,
        desiredState: "installed",
        desiredVersion: input.version ?? null,
        approvedAt: now,
        approvedBy: input.approverId,
        proposalId: input.proposalId ?? null,
        status: "planned",
      })
      // Another ask won the race for the one live row: read it below.
      .onConflictDoNothing()
      .returning();
    row =
      inserted ??
      (await loadLiveInstallation(
        input.computer.id,
        input.capability.capabilityKey
      ))!;
  } else {
    const upgrade =
      live.status === "installed" &&
      (input.version ?? null) !== (live.desiredVersion ?? null);
    [row] = (await db
      .update(installations)
      .set({
        desiredState: "installed",
        desiredVersion: input.version ?? live.desiredVersion,
        manifest: input.capability.manifest,
        capabilityId: input.capability.capabilityId,
        approvedAt: now,
        approvedBy: input.approverId,
        ...(input.proposalId ? { proposalId: input.proposalId } : {}),
        updatedAt: now,
      })
      .where(eq(installations.id, live.id))
      .returning()) as [InstallationRow];
    if (upgrade || input.action === "update") kindHint = "update";
  }
  const jobId = await reconcileInstallation(row, { kind: kindHint });
  return { installation: row, jobId };
}

export class InstallationRequestError extends Error {
  constructor(readonly code: "NOT_INSTALLED") {
    super(code);
  }
}

// ── The reconciler ──────────────────────────────────────────────────────────

/**
 * What job (if any) turns this installation's asked state into its observed
 * one. Pure; {@link reconcileInstallation} queues it. `hint` is the request's
 * own (an approved upgrade is an `update`); the rest is derived:
 *   - desired removed and not removing        → remove
 *   - planned                                 → install
 *   - installed, last check failed or drifted → install (a repair at the
 *                                               approved version), ONCE per
 *                                               finding: when the last job
 *                                               was itself an install or an
 *                                               update, the repair did not
 *                                               take and it waits for the
 *                                               person (no loop: a package
 *                                               manager that cannot pin a
 *                                               version would drift forever)
 *   - installed, check due (never, or past
 *     `verify.reverifyEvery`, default P7D)    → verify
 * A `failed` lifecycle is not retried on its own: the person (or an agent,
 * which needs no approval for it) asks again (a repair at the same version).
 */
export function nextJobFor(
  row: InstallationRow,
  now: Date = new Date(),
  hint?: HostJobKind,
  lastJobKind: HostJobKind | null = null
): HostJobKind | null {
  if (row.status === "removed" || row.status === "removing") return null;
  if (row.desiredState === "removed") return "remove";
  if (hint) return hint;
  if (row.status === "planned") return "install";
  if (row.status !== "installed") return null;
  const health = installationHealth(row, now).health;
  if (health === "failed" || health === "drifted")
    return "install";
  const verify = (row.manifest.verify ?? {}) as { reverifyEvery?: unknown };
  const every =
    isoDurationSeconds(verify.reverifyEvery) ?? TOOL_REVERIFY_DEFAULT_SECONDS;
  if (
    row.verifiedAt === null ||
    (now.getTime() - row.verifiedAt.getTime()) / 1000 > every
  )
    return "verify";
  return null;
}

/**
 * Queue the next job for this installation, at most ONE open per
 * installation: a second insert meets the partial unique index and is a
 * no-op. Returns the queued job's id, or null when nothing was due or a job
 * is already open.
 */
export async function reconcileInstallation(
  row: InstallationRow,
  opts: { now?: Date; kind?: HostJobKind } = {}
): Promise<string | null> {
  const [last] = await db
    .select({ kind: hostJobs.kind })
    .from(hostJobs)
    .where(eq(hostJobs.installationId, row.id))
    .orderBy(desc(hostJobs.queuedAt))
    .limit(1);
  const kind = nextJobFor(row, opts.now, opts.kind, last?.kind ?? null);
  if (!kind) return null;
  const [job] = await db
    .insert(hostJobs)
    .values({
      kind,
      installationId: row.id,
      userId: row.userId,
      machineUserId: row.machineUserId,
      workspaceId: row.workspaceId,
      proposalId: row.proposalId,
      spec: {
        op: kind,
        capabilityKey: row.capabilityKey,
        version: row.desiredVersion,
      },
    })
    .onConflictDoNothing()
    .returning({ id: hostJobs.id });
  return job?.id ?? null;
}

/**
 * Reconcile every live installation on one computer: the door a lease calls
 * before it picks the queue head, so a computer waking from sleep finds the
 * one job each installation is due (a verify past its cadence), never a pile.
 * This replaces a separate timer: a computer that never leases has nothing
 * to run anyway.
 */
export async function reconcileComputer(runner: {
  machineUserId: string;
  ownerUserId: string;
}): Promise<number> {
  const rows = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.machineUserId, runner.machineUserId),
        eq(installations.userId, runner.ownerUserId),
        ne(installations.status, "removed"),
        // Skip the ones with an open job without a round trip per row.
        sql`NOT EXISTS (SELECT 1 FROM ${hostJobs} WHERE ${hostJobs.installationId} = ${installations.id} AND ${hostJobs.status} IN ('queued', 'leased', 'running'))`
      )
    );
  let queued = 0;
  const now = new Date();
  for (const row of rows)
    if (await reconcileInstallation(row, { now })) queued += 1;
  return queued;
}
