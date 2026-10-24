/**
 * control-plane-link — the ONE place a pod reads WHICH Control Plane it is
 * linked to and WHICH plan that CP says it is on (lane cp-link, 2026-10-23).
 *
 * Two facts, each with the door that knows it:
 *
 *   link   CP url, issuer, this pod's CP id — written by the registration door
 *          (`synap register`) or the enroll door (`synap pod-key enroll`) into
 *          the deploy dir's enrollment record, read here through
 *          `readPodEnrollment` (the pod→CP auth door reads the same record).
 *   plan   tier, status, trial end — answered by the CP (`GET /internal/plan`),
 *          pulled by `@synap/jobs` `cp-entitlement-sync` into the singleton
 *          `pod_settings.settings.controlPlaneEntitlement`.
 *
 * Pod-level facts never live in a workspace's settings. The pre-July record
 * `workspaces.settings.controlPlane` lost its writers in bda48e071 (2026-07-14)
 * and is read HERE ONLY: as the link of a pod that has no enrollment record yet
 * (`source: "legacy"`, removed at the R1 legacy-auth cut-over), and once by
 * `migrateLegacyControlPlaneRecord` at boot. Tripwire:
 * `packages/api/src/__tripwires__/control-plane-link-one-door.test.ts`.
 *
 * Every reader THROWS on a failed read: "could not read" is never "not linked"
 * or "no plan".
 */

import { asc, eq, sql as drizzleSql } from "drizzle-orm";

import { db } from "../index.js";
import { workspaces } from "../schema/workspaces.js";
import {
  podSettings,
  type ControlPlaneEntitlement,
  type ControlPlaneEntitlementSync,
} from "../schema/pod-settings.js";
import { readPodEnrollment } from "./pod-cp-auth.js";

export interface ControlPlaneLink {
  /** This pod's id at its Control Plane. */
  podId: string;
  /** The CP transport URL (where the pod sends its calls). */
  url: string | null;
  /** The CP issuer origin (the `iss` of the CP's tokens). */
  issuer: string | null;
  /** When the link was made (ISO), if recorded. */
  since: string | null;
  /** `enrollment` = the deploy dir's record; `legacy` = the pre-July record. */
  source: "enrollment" | "legacy";
}

/** The pre-July `workspaces.settings.controlPlane` block, as it was written. */
interface LegacyControlPlaneRecord {
  url?: unknown;
  podId?: unknown;
  connectedAt?: unknown;
  tier?: unknown;
  trialEnd?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

async function readLegacyControlPlaneRecord(): Promise<LegacyControlPlaneRecord | null> {
  const [row] = await db
    .select({
      cp: drizzleSql<LegacyControlPlaneRecord | null>`${workspaces.settings} -> 'controlPlane'`,
    })
    .from(workspaces)
    .where(
      drizzleSql`jsonb_typeof(${workspaces.settings} -> 'controlPlane') = 'object'`
    )
    .orderBy(asc(workspaces.createdAt))
    .limit(1);
  return row?.cp ?? null;
}

/**
 * This pod's Control Plane link, or null when it has none (a self-hosted pod
 * that never registered). Throws when the enrollment record or the database
 * cannot be read.
 */
export async function readControlPlaneLink(): Promise<ControlPlaneLink | null> {
  const enrollment = readPodEnrollment();
  if (enrollment) {
    return {
      podId: enrollment.podId,
      url:
        enrollment.controlPlaneUrl ??
        str(process.env.CONTROL_PLANE_URL) ??
        enrollment.issuer,
      issuer: enrollment.issuer,
      since: enrollment.enrolledAt,
      source: "enrollment",
    };
  }
  const legacy = await readLegacyControlPlaneRecord();
  const podId = str(legacy?.podId);
  if (!legacy || !podId) return null;
  const url = str(legacy.url);
  return {
    podId,
    url,
    // The pre-July record kept the CP URL as its issuer binding.
    issuer: url,
    since: str(legacy.connectedAt),
    source: "legacy",
  };
}

async function podSettingsRowId(): Promise<string | null> {
  const [row] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(asc(podSettings.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Replace ONE top-level key of the singleton row, creating the row if absent. */
async function writePodSettingsKey(key: string, value: unknown): Promise<void> {
  const id = await podSettingsRowId();
  if (!id) {
    await db.insert(podSettings).values({ settings: { [key]: value } });
    return;
  }
  await db
    .update(podSettings)
    .set({
      settings: drizzleSql`coalesce(${podSettings.settings}, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(podSettings.id, id));
}

async function readPodSettingsBlob() {
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(asc(podSettings.createdAt))
    .limit(1);
  return row?.settings ?? null;
}

/** The plan this pod enforces, or null when its CP never answered. Throws on a failed read. */
export async function readControlPlaneEntitlement(): Promise<ControlPlaneEntitlement | null> {
  return (await readPodSettingsBlob())?.controlPlaneEntitlement ?? null;
}

/** The last attempt to pull the plan, or null when none was made. */
export async function readControlPlaneEntitlementSync(): Promise<ControlPlaneEntitlementSync | null> {
  return (await readPodSettingsBlob())?.controlPlaneEntitlementSync ?? null;
}

/** The CP's answer, as `GET /internal/plan` sends it. */
export interface PulledPlan {
  tier: string | null;
  status: string | null;
  trialEnd: string | null;
  lab: boolean;
}

/** Record a SUCCESSFUL pull: the plan and an "ok" attempt. */
export async function recordControlPlaneEntitlement(
  plan: PulledPlan,
  now: Date = new Date()
): Promise<void> {
  const at = now.toISOString();
  const value: ControlPlaneEntitlement = {
    tier: plan.tier,
    status: plan.status,
    trialEnd: plan.trialEnd,
    lab: plan.lab,
    source: "pull",
    checkedAt: at,
  };
  await writePodSettingsKey("controlPlaneEntitlement", value);
  await writePodSettingsKey("controlPlaneEntitlementSync", {
    lastAttemptAt: at,
    outcome: "ok",
    message: null,
  } satisfies ControlPlaneEntitlementSync);
}

/** Record a FAILED pull. The last good plan is left exactly as it was. */
export async function recordControlPlaneEntitlementFailure(
  outcome: Exclude<ControlPlaneEntitlementSync["outcome"], "ok">,
  message: string,
  now: Date = new Date()
): Promise<void> {
  await writePodSettingsKey("controlPlaneEntitlementSync", {
    lastAttemptAt: now.toISOString(),
    outcome,
    message,
  } satisfies ControlPlaneEntitlementSync);
}

export interface LegacyControlPlaneMigration {
  /** The old tier/trial became the plan (none had been pulled yet). */
  planSeeded: boolean;
  /** Workspaces whose `settings.controlPlane` was removed. */
  workspacesCleared: number;
}

/**
 * One-time boot migration of the pre-July record. Seeds the plan from its
 * tier/trial when no plan exists yet (the first pull replaces it), then — once
 * the pod's link lives in its enrollment record — removes the old block from
 * every workspace. Without an enrollment record the block stays: it is still
 * that pod's link (`readControlPlaneLink`, `source: "legacy"`).
 */
export async function migrateLegacyControlPlaneRecord(): Promise<LegacyControlPlaneMigration> {
  const legacy = await readLegacyControlPlaneRecord();
  if (!legacy) return { planSeeded: false, workspacesCleared: 0 };

  let planSeeded = false;
  const tier = str(legacy.tier);
  const trialEnd = str(legacy.trialEnd);
  if ((tier || trialEnd) && !(await readControlPlaneEntitlement())) {
    await writePodSettingsKey("controlPlaneEntitlement", {
      tier,
      // The old record never said whether its trial was still running, so a
      // migrated trial end never blocks (the trial guard needs "trialing").
      status: null,
      trialEnd,
      lab: false,
      source: "legacy",
      checkedAt: null,
    } satisfies ControlPlaneEntitlement);
    planSeeded = true;
  }

  if (!readPodEnrollment()) return { planSeeded, workspacesCleared: 0 };
  const cleared = await db
    .update(workspaces)
    .set({ settings: drizzleSql`${workspaces.settings} - 'controlPlane'` })
    .where(drizzleSql`${workspaces.settings} -> 'controlPlane' IS NOT NULL`)
    .returning({ id: workspaces.id });
  return { planSeeded, workspacesCleared: cleared.length };
}
