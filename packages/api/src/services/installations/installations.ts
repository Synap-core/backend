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
 *                         desired removed → remove; a failed lifecycle → a
 *                         check, then a repair; a failed check → install
 *                         again from the approved snapshot (a repair); each
 *                         retried on its own with a back-off and a cap
 *                         (`self-heal.ts`); a drifted version → one repair;
 *                         a check that is due → verify; an install waits
 *                         for the prerequisites it names.
 *
 * Who may write what the computer OBSERVED: only its own key with
 * `host.runner`, through the host-job routes. An agent hosted on the computer
 * (`users.host_user_id`) may READ its computer's installations here, never
 * report them.
 */

import { and, db, desc, drizzleSql, eq, inArray, ne } from "@synap/database";
import {
  capabilities,
  hostJobs,
  installations,
  ProposalStatus,
  proposals,
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
import {
  listMachines,
  machineName,
  type MachineView,
} from "../machine-roster.js";
import {
  installationHealth,
  isoDurationSeconds,
  TOOL_REVERIFY_DEFAULT_SECONDS,
  type InstallationHealthVerdict,
} from "../host-jobs/host-jobs.js";
import {
  loadInstallationJobHistory,
  selfHealGate,
  type InstallationJobHistoryEntry,
} from "./self-heal.js";
import { askForPrerequisites } from "./self-heal-notice.js";

/**
 * Was this installation request already approved? The approve executor's
 * re-approval check (re-approving does nothing), read here like the package
 * update's (`isPackageUpdateProposalApproved`).
 */
export async function isInstallationRequestApproved(
  proposalId: string
): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

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

/** A computer of the person's roster, as the installation doors name it. */
export function computerRefOf(
  personId: string,
  m: Pick<MachineView, "id" | "name" | "platform" | "arch" | "hostsServices">
): ComputerRef {
  return {
    id: m.id,
    ownerUserId: personId,
    name: m.name,
    os: m.platform,
    arch: m.arch,
    installsFromPod: m.hostsServices,
  };
}

/**
 * One of the person's computers by id, or null (a stranger's reads as none).
 * Read through the ONE roster (`machine-roster.ts` `listMachines`), the read
 * an ask names a computer through (`listPersonsComputers`), so the computer
 * an agent's ask was filed for is the computer its approval finds.
 */
export async function loadPersonsComputer(
  personId: string,
  computerId: string
): Promise<ComputerRef | null> {
  const m = (await listMachines(personId)).find((c) => c.id === computerId);
  return m ? computerRefOf(personId, m) : null;
}

/**
 * Why `computerId` is not one of the person's computers, as the end of a
 * refusal: it is gone, it is not a computer, or it is someone else's. Only
 * for wording a refusal after `loadPersonsComputer` found nothing; it
 * decides nothing.
 */
export async function whyNotPersonsComputer(
  personId: string,
  computerId: string
): Promise<string> {
  const [row] = await db
    .select({ ...computerColumns, userType: users.userType })
    .from(users)
    .where(eq(users.id, computerId))
    .limit(1);
  if (!row) return "this computer is no longer on the pod";
  const name = row.agentType === MACHINE_AGENT_TYPE ? machineName(row) : null;
  if (row.userType !== "agent" || !name)
    return `${row.name?.trim() || "what it names"} is not a computer`;
  if (row.owner !== personId) return `${name} is not one of your computers`;
  return `${name} is not on your list of computers`;
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
  return toViews(rows);
}

/**
 * What is installed on ONE computer, read for that computer's own key: its
 * person's live rows on it (owner AND machine), the floor the host-job
 * routes read on, never through a grant. The caller is the computer itself
 * (`resolveCallerComputer` returned it for its own key): a computer reads
 * what is on it whatever its key's grant names, and nothing on another
 * computer or of another person.
 */
export async function listComputerOwnInstallations(
  computer: ComputerRef,
  filter: { capabilityKey?: string } = {}
): Promise<InstallationView[]> {
  const rows = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.userId, computer.ownerUserId),
        eq(installations.machineUserId, computer.id),
        ne(installations.status, "removed"),
        filter.capabilityKey
          ? eq(installations.capabilityKey, filter.capabilityKey)
          : undefined
      )
    );
  return toViews(rows);
}

/** Rows by computer then capability, each as the doors return it. */
async function toViews(rows: InstallationRow[]): Promise<InstallationView[]> {
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
  capability: Pick<InstallableCapability, "manifest">,
  computer: ComputerRef
): string | null {
  if (!computer.installsFromPod)
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
  return (req.version ?? row.desiredVersion ?? null) !== row.desiredVersion;
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
    // The person asked: it runs now, whatever the ladder's back-off.
    kindHint = "remove";
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
    // The person approved a repair (their own ask, or the pod's "try
    // again" card): it runs now, whatever the self-heal ladder says.
    else if (
      input.action === "install" &&
      (live.status === "installed" || live.status === "failed")
    )
      kindHint = "install";
  }
  const jobId = await reconcileInstallation(row, { kind: kindHint });
  if (input.action === "install" && !jobId) {
    // An install that waits for a prerequisite nobody approved on this
    // computer: ONE ask, now, never one per lease.
    const prerequisites = await loadPrerequisiteState(row);
    if (prerequisites.missing.length > 0) {
      await askForPrerequisites(row, prerequisites.missing);
    }
  }
  return { installation: row, jobId };
}

export class InstallationRequestError extends Error {
  constructor(readonly code: "NOT_INSTALLED") {
    super(code);
  }
}

// ── The reconciler ──────────────────────────────────────────────────────────

/** An installation's prerequisites (`placement.requires.capabilities`) as they stand on its computer. */
export interface PrerequisiteState {
  /** Approved on this computer, not installed and working yet: an install waits for it. */
  waiting: string[];
  /** Not approved on this computer: an install waits for the person's yes. */
  missing: string[];
}

export const NO_PREREQUISITES: PrerequisiteState = { waiting: [], missing: [] };

/**
 * The capability keys an installation's manifest needs first on its computer,
 * for that computer's system (an entry with `os` counts only there). Pure.
 */
export function requiredCapabilityKeys(
  row: Pick<InstallationRow, "capabilityKey" | "manifest">,
  os: string | null
): string[] {
  const placement = (row.manifest.placement ?? {}) as {
    requires?: { capabilities?: Array<{ slug?: unknown; os?: unknown }> };
  };
  const keys = new Set<string>();
  for (const dep of placement.requires?.capabilities ?? []) {
    if (typeof dep?.slug !== "string" || dep.slug === row.capabilityKey)
      continue;
    if (typeof dep.os === "string" && os && dep.os !== os) continue;
    keys.add(dep.slug);
  }
  return [...keys];
}

/**
 * Where each prerequisite of this installation stands on the same computer:
 * ready (installed, its last check not failed), waiting (approved, not ready
 * yet) or missing (no live installation the person still wants).
 */
export async function loadPrerequisiteState(
  row: InstallationRow
): Promise<PrerequisiteState> {
  let os = row.observedOs;
  if (!os) {
    const [computer] = await db
      .select({ agentMetadata: users.agentMetadata })
      .from(users)
      .where(eq(users.id, row.machineUserId))
      .limit(1);
    const platform = (computer?.agentMetadata as { platform?: unknown } | null)
      ?.platform;
    os = typeof platform === "string" ? platform : null;
  }
  const keys = requiredCapabilityKeys(row, os);
  if (keys.length === 0) return NO_PREREQUISITES;
  const deps = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.machineUserId, row.machineUserId),
        eq(installations.userId, row.userId),
        inArray(installations.capabilityKey, keys),
        ne(installations.status, "removed")
      )
    );
  const state: PrerequisiteState = { waiting: [], missing: [] };
  for (const key of keys) {
    const dep = deps.find((d) => d.capabilityKey === key);
    if (!dep || dep.desiredState === "removed") state.missing.push(key);
    else if (
      dep.status !== "installed" ||
      installationHealth(dep).health === "failed"
    )
      state.waiting.push(key);
  }
  return state;
}

/**
 * What job (if any) turns this installation's asked state into its observed
 * one. Pure; {@link reconcileInstallation} queues it. `hint` is a person's own
 * ask (an approved upgrade is an `update`, a repair an `install`, a removal a
 * `remove`): it runs now. The rest is derived, and every job runs the
 * manifest snapshot the person approved:
 *   - desired removed and not removing        → remove
 *   - planned                                 → install
 *   - failed (an install or an update that
 *     did not finish)                         → a check first (the tool may
 *                                               work after all: tonight's
 *                                               ffmpeg, installed, recorded
 *                                               failed after a timeout); after
 *                                               a failed check → install
 *   - installed, last check failed            → install (a repair)
 *   - installed, drifted                      → install, ONCE per finding: a
 *                                               package manager that cannot
 *                                               pin a version would drift
 *                                               forever
 *   - installed, check due (never, or past
 *     `verify.reverifyEvery`, default P7D, or
 *     a tool not checked for 10 min when the
 *     runner came back: `recheckTools`)       → verify
 * A job that failed is tried again only through the ladder
 * ({@link selfHealGate}: back-off, cap, a person's stop). An install (first
 * or repair) waits, counting no failure, while a prerequisite is not ready.
 */
export function nextJobFor(
  row: InstallationRow,
  now: Date = new Date(),
  hint?: HostJobKind,
  history: readonly InstallationJobHistoryEntry[] = [],
  prerequisites: PrerequisiteState = NO_PREREQUISITES,
  recheckTools = false
): HostJobKind | null {
  if (row.status === "removed" || row.status === "removing") return null;
  if (row.desiredState === "removed") {
    return hint === "remove" || selfHealGate(history, now).open
      ? "remove"
      : null;
  }
  if (hint) return hint;
  const install = (): HostJobKind | null =>
    prerequisites.waiting.length === 0 && prerequisites.missing.length === 0
      ? "install"
      : null;
  if (row.status === "planned") return install();
  if (row.status === "failed") {
    if (!selfHealGate(history, now).open) return null;
    const last = history[0];
    return last?.kind === "verify" && last.status === "failed"
      ? install()
      : "verify";
  }
  if (row.status !== "installed") return null;
  const health = installationHealth(row, now).health;
  if (health === "failed") {
    return selfHealGate(history, now).open ? install() : null;
  }
  if (health === "drifted") {
    const last = history[0]?.kind ?? null;
    return last === "install" || last === "update" ? null : install();
  }
  const verify = (row.manifest.verify ?? {}) as { reverifyEvery?: unknown };
  const cadence =
    isoDurationSeconds(verify.reverifyEvery) ?? TOOL_REVERIFY_DEFAULT_SECONDS;
  const every =
    recheckTools && row.kind === "tool"
      ? Math.min(cadence, TOOL_RECHECK_MIN_AGE_SECONDS)
      : cadence;
  if (
    row.verifiedAt === null ||
    (now.getTime() - row.verifiedAt.getTime()) / 1000 > every
  )
    return "verify";
  return null;
}

/**
 * When the computer's runner comes back (`noteHostRunner`), every tool on it
 * not checked in this long is checked again: a version check, cheap, and the
 * moment a tool removed by hand is found (instead of its next `reverifyEvery`).
 */
export const TOOL_RECHECK_MIN_AGE_SECONDS = 10 * 60;

/**
 * Queue the next job for this installation, at most ONE open per
 * installation: a second insert meets the partial unique index and is a
 * no-op. Returns the queued job's id, or null when nothing was due, the
 * ladder holds it back, or a job is already open.
 */
export async function reconcileInstallation(
  row: InstallationRow,
  opts: { now?: Date; kind?: HostJobKind; recheckTools?: boolean } = {}
): Promise<string | null> {
  const history = await loadInstallationJobHistory(row.id);
  const prerequisites =
    row.desiredState === "installed"
      ? await loadPrerequisiteState(row)
      : NO_PREREQUISITES;
  const kind = nextJobFor(
    row,
    opts.now,
    opts.kind,
    history,
    prerequisites,
    opts.recheckTools ?? false
  );
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
export async function reconcileComputer(
  runner: {
    machineUserId: string;
    ownerUserId: string;
  },
  opts: { recheckTools?: boolean } = {}
): Promise<number> {
  const rows = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.machineUserId, runner.machineUserId),
        eq(installations.userId, runner.ownerUserId),
        ne(installations.status, "removed"),
        // Skip the ones with an open job without a round trip per row.
        drizzleSql`NOT EXISTS (SELECT 1 FROM ${hostJobs} WHERE ${hostJobs.installationId} = ${installations.id} AND ${hostJobs.status} IN ('queued', 'leased', 'running'))`
      )
    );
  let queued = 0;
  const now = new Date();
  for (const row of rows)
    if (
      await reconcileInstallation(row, {
        now,
        recheckTools: opts.recheckTools,
      })
    )
      queued += 1;
  return queued;
}
