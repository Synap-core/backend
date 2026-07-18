/**
 * CP Project Sync Worker (P4-lite Wave 1)
 *
 * Announces the pod's FULL project list to the Control Plane's `pod_projects`
 * mirror directory: POST ${CONTROL_PLANE_URL}/internal/projects/sync with
 * X-Internal-Key. The pod stays authoritative — the CP holds a read-time
 * mirror keyed by podId (never a URL).
 *
 * Runs every 30 minutes (reconcile) + once on startup, and is also enqueued
 * as a one-off by ProjectRepository create/update/delete via the
 * `registerCpProjectSyncTrigger` IoC slot (wired in workers/index.ts) —
 * the push is cheap and idempotent, so no debounce.
 *
 * CONTRACT (the CP receiver implements this exact shape — do not drift):
 *   {
 *     "podId": string,           // this pod's CP pod id (workspace settings)
 *     "full": true,              // full-snapshot semantics → CP tombstones absentees
 *     "projects": [ {
 *       "id": uuid, "slug": string|null, "name": string,
 *       "status": "active"|"archived"|"completed",
 *       "updatedAt": iso8601, "deletedAt": iso8601|null
 *     } ]
 *   }
 * Chunked at 200 projects per request (CP edge rate limits); every chunk of
 * the same run carries full:true and the same podId.
 *
 * Skips silently (one info log) when CONTROL_PLANE_URL or
 * SYNAP_POD_INTERNAL_KEY is unset — absence is normal for self-hosted pods —
 * or when the pod has no CP identity (no workspace settings controlPlane.podId,
 * written by the provision flow).
 *
 * postgres.js gotchas honored: timestamps are serialized via toISOString()
 * (never a raw Date in the JSON body) and computed/driver values that arrive
 * as strings are normalized through new Date().
 */

import { db, drizzleSql } from "@synap/database";
import { projects, workspaces } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cp-project-sync" });

export const CP_PROJECT_SYNC_QUEUE = "cp-project-sync";
/** Cron schedule — every 30 minutes (periodic reconcile). */
export const CP_PROJECT_SYNC_CRON = "*/30 * * * *";
/** Max projects per request — first reconcile must batch (CP edge rate limits). */
export const PROJECT_SYNC_CHUNK_SIZE = 200;

/** A project row as read from the pod DB (driver may hand back string dates). */
export interface PodProjectRow {
  id: string;
  slug: string | null;
  name: string;
  status: string;
  updatedAt: Date | string;
}

export interface ProjectSyncEntry {
  id: string;
  slug: string | null;
  name: string;
  status: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ProjectSyncPayload {
  podId: string;
  full: true;
  projects: ProjectSyncEntry[];
}

/** Never pass Date params through JSON — always ISO strings (postgres.js rule). */
function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/**
 * Pure payload builder (unit-tested): full project list → chunked CONTRACT
 * payloads. An empty list still yields ONE payload (empty `projects`) so the
 * CP can tombstone everything when the pod deleted its last project.
 */
export function buildProjectSyncPayloads(
  podId: string,
  rows: PodProjectRow[]
): ProjectSyncPayload[] {
  const entries: ProjectSyncEntry[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug ?? null,
    name: r.name,
    status: r.status,
    updatedAt: toIso(r.updatedAt),
    // Projects are hard-deleted on the pod (no deletedAt column) — absence
    // from this full snapshot is how the CP learns about deletions.
    deletedAt: null,
  }));

  if (entries.length === 0) {
    return [{ podId, full: true, projects: [] }];
  }

  const payloads: ProjectSyncPayload[] = [];
  for (let i = 0; i < entries.length; i += PROJECT_SYNC_CHUNK_SIZE) {
    payloads.push({
      podId,
      full: true,
      projects: entries.slice(i, i + PROJECT_SYNC_CHUNK_SIZE),
    });
  }
  return payloads;
}

/**
 * The pod's CP identity: workspace settings `controlPlane.podId`, written by
 * the ES256 provision flow (same source connectors-trpc's
 * getControlPlaneSettings reads). Null = pod never provisioned against a CP.
 */
async function resolveCpPodId(): Promise<string | null> {
  const rows = await db
    .select({
      podId: drizzleSql<
        string | null
      >`${workspaces.settings} -> 'controlPlane' ->> 'podId'`,
    })
    .from(workspaces)
    .where(
      drizzleSql`${workspaces.settings} -> 'controlPlane' ->> 'podId' IS NOT NULL`
    )
    .limit(1);
  return rows[0]?.podId ?? null;
}

// One-shot skip logs — absence of CP config is normal, don't spam every 30min.
let loggedEnvSkip = false;
let loggedPodIdSkip = false;

/** Called by the cron tick, the startup enqueue, and repository-triggered one-offs. */
export async function handleCpProjectSync(): Promise<void> {
  const cpUrl = (process.env.CONTROL_PLANE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  if (!cpUrl || !internalKey) {
    if (!loggedEnvSkip) {
      logger.info(
        "CONTROL_PLANE_URL / SYNAP_POD_INTERNAL_KEY unset — CP project directory sync disabled (normal for self-hosted pods)"
      );
      loggedEnvSkip = true;
    }
    return;
  }

  const podId = await resolveCpPodId();
  if (!podId) {
    if (!loggedPodIdSkip) {
      logger.info(
        "No controlPlane.podId in workspace settings — pod has no CP identity yet; skipping project directory sync"
      );
      loggedPodIdSkip = true;
    }
    return;
  }

  const rows: PodProjectRow[] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      status: projects.status,
      updatedAt: projects.updatedAt,
    })
    .from(projects);

  const payloads = buildProjectSyncPayloads(podId, rows);

  for (const payload of payloads) {
    let res: Response;
    try {
      res = await fetch(`${cpUrl}/internal/projects/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": internalKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      // Transient (network/timeout) — the 30-min reconcile is the retry.
      logger.warn({ err }, "CP unreachable — project directory sync deferred");
      return;
    }
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "CP rejected project directory sync — deferred to next reconcile"
      );
      return;
    }
  }

  logger.info(
    { projects: rows.length, requests: payloads.length },
    "Synced project directory to CP"
  );
}
