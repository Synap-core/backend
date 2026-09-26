/**
 * STAGE DOMAIN — where a track's stage is worked (W2a, concept consolidation).
 *
 * A method's stage may name a DOMAIN: a workspace TEMPLATE slug
 * (`stage.domain`, matched against `workspaces.package_slug`), never a workspace
 * id, so the method stays portable across pods. This module turns that slug
 * into a live workspace for ONE caller, or says honestly why it cannot.
 *
 * The candidate floor, in order (each step can only narrow):
 *   1. installed from that template: `package_slug = slug`, not archived;
 *   2. VISIBLE to the caller (`userVisibleWhere`, the `workspaces.list` floor)
 *      — a workspace the caller cannot see reads exactly like none at all;
 *   3. a DOMAIN HOME (`isDomainHomeWorkspace`): a stage's entities are filed
 *      there, and an admin/operational surface refuses domain data;
 *   4. WRITABLE by the caller (`assertWorkspaceWrite`, editor+) — the session
 *      is created there.
 * Among survivors, one the project already `uses` wins; else the earliest
 * installed (deterministic).
 *
 * The fallback reason names the FIRST step that emptied the set, so the
 * caller is told what would fix it (install the template / ask for access /
 * re-type the workspace), never a generic "not found".
 */

import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  isDomainHomeWorkspace,
  userVisibleWhere,
  workspaces,
  type getDb,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { deriveTrackStages } from "@synap-core/types/units";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { listWorkspacesUsedByProjects } from "../../utils/project-workspace.js";

type Db = Awaited<ReturnType<typeof getDb>>;

export type StageDomainFallbackReason =
  /** No live workspace installed from that template is visible to the caller. */
  | "no_workspace"
  /** Only admin/operational workspaces carry it — domain data is refused there. */
  | "not_a_domain_home"
  /** The caller can see one but is not an editor of any. */
  | "no_write_access";

export type StageDomainResolution =
  | {
      resolved: true;
      slug: string;
      workspaceId: string;
      /** The project already ran through this workspace (`uses` edge). */
      alreadyUsed: boolean;
    }
  | { resolved: false; slug: string; reason: StageDomainFallbackReason };

/** Live, caller-visible workspaces installed from `slug`, earliest first. */
async function visibleTemplateWorkspaces(
  db: Db,
  slugs: readonly string[],
  userId: string
) {
  if (slugs.length === 0) return [];
  return db
    .select({
      id: workspaces.id,
      packageSlug: workspaces.packageSlug,
      workspaceType: workspaces.workspaceType,
      systemSlug: workspaces.systemSlug,
      settings: workspaces.settings,
    })
    .from(workspaces)
    .where(
      and(
        inArray(workspaces.packageSlug, [...slugs]),
        isNull(workspaces.archivedAt),
        userVisibleWhere(workspaces.id, userId)
      )
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
}

export async function resolveStageDomainWorkspace(
  db: Db,
  args: { slug: string; projectId: string; userId: string }
): Promise<StageDomainResolution> {
  const { slug, projectId, userId } = args;
  const rows = await visibleTemplateWorkspaces(db, [slug], userId);
  if (rows.length === 0) {
    return { resolved: false, slug, reason: "no_workspace" };
  }
  const homes = rows.filter((w) =>
    isDomainHomeWorkspace({
      workspaceType: w.workspaceType,
      systemSlug: w.systemSlug,
      settings: w.settings as { surfaceClass?: string; systemSlug?: string },
    })
  );
  if (homes.length === 0) {
    return { resolved: false, slug, reason: "not_a_domain_home" };
  }
  const writable: string[] = [];
  for (const w of homes) {
    try {
      await assertWorkspaceWrite(db, userId, { workspaceId: w.id });
      writable.push(w.id);
    } catch (err) {
      // FORBIDDEN is the answer "not writable" — the one thing this probe
      // asks. Anything else is a FAILED read, never folded into "no access".
      if (!(err instanceof TRPCError && err.code === "FORBIDDEN")) throw err;
    }
  }
  if (writable.length === 0) {
    return { resolved: false, slug, reason: "no_write_access" };
  }
  const used = new Set(
    (await listWorkspacesUsedByProjects(db, [projectId], userId)).get(
      projectId
    ) ?? []
  );
  const preferred = writable.find((id) => used.has(id));
  return {
    resolved: true,
    slug,
    workspaceId: preferred ?? writable[0]!,
    alreadyUsed: preferred !== undefined,
  };
}

/**
 * The stage domains (in stage order, deduped) with NO live workspace visible
 * to the caller — the advisory `startTrack` returns. It never blocks: a stage
 * whose domain is missing falls back to the project's home when its session
 * starts. Visibility-floored like the resolver, so it never reveals a
 * workspace the caller cannot see.
 */
export async function listMissingStageDomains(
  db: Db,
  stages: unknown,
  userId: string
): Promise<string[]> {
  const wanted = stageDomains(stages);
  if (wanted.length === 0) return [];
  const present = new Set(
    (await visibleTemplateWorkspaces(db, wanted, userId)).map(
      (w) => w.packageSlug
    )
  );
  return wanted.filter((slug) => !present.has(slug));
}

/** Distinct declared stage domains, in stage order — read by the ONE stage read. */
function stageDomains(stages: unknown): string[] {
  const out: string[] = [];
  for (const { domain } of deriveTrackStages(stages, null)) {
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/** The workspace's template slug, or null — used to re-stamp `uses` on reuse. */
export async function workspacePackageSlug(
  db: Db,
  workspaceId: string
): Promise<string | null> {
  const [row] = await db
    .select({ packageSlug: workspaces.packageSlug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.packageSlug ?? null;
}

/**
 * The honest sentence a door (MCP / Hub) shows beside a stage session that
 * could not be worked in its domain. `undefined` when nothing needs saying.
 */
export function stageDomainFallbackNote(
  fallback: { wanted: string; reason: StageDomainFallbackReason } | undefined
): string | undefined {
  if (!fallback) return undefined;
  const { wanted, reason } = fallback;
  const why =
    reason === "no_workspace"
      ? `no workspace installed from the "${wanted}" template is available to you — install that workspace template to work this stage there`
      : reason === "not_a_domain_home"
        ? `the only "${wanted}" workspace is an admin/operational surface, which cannot hold domain data`
        : `you are not an editor of the "${wanted}" workspace — ask its owner for editor access`;
  return `This stage is worked in the "${wanted}" domain, but ${why}. The session was started in the project's home workspace instead.`;
}

/** The advisory sentence for `startTrack`'s `missingDomains`. */
export function missingStageDomainsNote(
  missing: readonly string[]
): string | undefined {
  if (missing.length === 0) return undefined;
  return `No workspace is installed for ${missing.length === 1 ? "this stage domain" : "these stage domains"}: ${missing.map((d) => `"${d}"`).join(", ")}. Those stages' sessions will start in the project's home workspace until the template is installed.`;
}
