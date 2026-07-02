/**
 * Canonical orientation / discovery service.
 *
 * ONE place that shapes the "lens map" an agent sees at session start:
 * workspaces (operational domains) + projects (cross-cutting initiatives) +
 * a representative profile sample + identity. Every entry point — the MCP
 * `synap_orient` tool, the Hub REST `GET /orient` route, and the CLI `orient`
 * command — routes through here so the disclosure never drifts.
 *
 * Disclosure (the good defaults the CLI already had, now shared):
 *   - detail:'light' (default) — names / ids / domain / live entity counts,
 *     onboarding trimmed to its `goal` line, a flat profile sample.
 *   - detail:'full' — adds workspace descriptions, the FULL onboarding spec,
 *     and per-workspace profile lists (the old CLI `--details` fanout).
 */

import {
  db,
  entities,
  projects,
  workspaces,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  drizzleSql,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  getUserAccessibleWorkspaceIds,
  type HubProtocolCaller,
} from "../../routers/hub-protocol/rest/_shared.js";

export type DiscoverDetail = "light" | "full";
export type DiscoverScope = "workspaces" | "projects" | "profiles";

const ALL_SCOPES: DiscoverScope[] = ["workspaces", "projects", "profiles"];

export interface DiscoverOptions {
  detail?: DiscoverDetail;
  scope?: DiscoverScope[];
  workspaceId?: string;
  projectId?: string;
}

export interface DiscoverParams extends DiscoverOptions {
  /** A hub-protocol caller (for profiles.listProfiles). Built by the call site. */
  caller: HubProtocolCaller;
  userId: string;
  scopes: string[];
}

interface OnboardingSpec {
  goal?: string;
  [k: string]: unknown;
}

export interface DiscoverWorkspace {
  id: string;
  name: string;
  /** Operational-domain label: settings.workspaceSubtype ?? workspaceType. */
  domain: string | null;
  entityCount: number;
  /** light: `{ goal }` only; full: the whole onboarding interview spec. */
  onboarding?: OnboardingSpec;
  /** full only */
  description?: string | null;
  /** full only — this workspace's profiles (slug + name). */
  profiles?: Array<{ slug: string; name: string }>;
}

export interface DiscoverProject {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  workspaceId: string | null;
  homeWorkspace: string | null;
}

export interface DiscoverResult {
  me: { userId: string; scopes: string[] };
  detail: DiscoverDetail;
  projects: DiscoverProject[];
  projectCount: number;
  workspaces: DiscoverWorkspace[];
  workspaceCount: number;
  /** Representative profile sample from the pinned / first workspace. */
  profiles: Array<{ slug: string; name: string }>;
  note: string;
}

/** Take listProfiles's `{ profiles }` shape → a light slug+name list. */
function trimProfiles(res: unknown): Array<{ slug: string; name: string }> {
  const list = ((res as { profiles?: unknown }).profiles ?? []) as Array<{
    slug?: string;
    name?: string;
    displayName?: string;
  }>;
  return list.flatMap((p) =>
    p.slug ? [{ slug: p.slug, name: p.displayName ?? p.name ?? p.slug }] : []
  );
}

/**
 * The lens-map guidance note. Dynamic (counts) + action-oriented; the lens
 * model itself is taught once in the agent prompt, not re-taught per call.
 */
function buildNote(projectCount: number, workspaceCount: number): string {
  return (
    `Lens map: ${projectCount} project(s), ${workspaceCount} workspace(s). ` +
    (workspaceCount > 1
      ? `Reads auto-scope across all your workspaces; pass workspaceId to narrow to one domain, projectId to one project. `
      : `Tools default to your one workspace; pass projectId on reads/recall to narrow to a project. `) +
    (projectCount > 0
      ? `A project's data can span workspaces — see synap_get_entities(projectId) or the project digest. `
      : ``) +
    `If a project clearly lacks an operational domain it needs (and the user hasn't declined it), offer once — see the agent-os skill.`
  );
}

export async function discover(
  params: DiscoverParams
): Promise<DiscoverResult> {
  const { caller, userId, scopes, workspaceId, projectId } = params;
  const detail: DiscoverDetail = params.detail ?? "light";
  const wantScopes =
    params.scope && params.scope.length ? params.scope : ALL_SCOPES;
  const want = (s: DiscoverScope): boolean => wantScopes.includes(s);

  // Accessible workspace ids (memberships + pod-visible), narrowed when pinned.
  let wsIds = await getUserAccessibleWorkspaceIds(userId);
  if (workspaceId) wsIds = wsIds.filter((id) => id === workspaceId);

  const needWorkspaces = want("workspaces");
  const needProfiles = want("profiles");

  // Workspace rows + per-workspace live entity counts (same count semantics as
  // GET /workspaces, so orient reports the truth instead of "empty").
  const [wsRaw, countRows] = await Promise.all([
    (needWorkspaces || needProfiles) && wsIds.length
      ? db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            description: workspaces.description,
            settings: workspaces.settings,
            workspaceType: workspaces.workspaceType,
          })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds))
      : Promise.resolve([]),
    needWorkspaces && wsIds.length
      ? db
          .select({
            workspaceId: entities.workspaceId,
            count: drizzleSql<number>`cast(count(*) as integer)`,
          })
          .from(entities)
          .where(
            and(
              inArray(entities.workspaceId, wsIds),
              isNull(entities.deletedAt)
            )
          )
          .groupBy(entities.workspaceId)
      : Promise.resolve([]),
  ]);
  const entityCountByWs = new Map(
    countRows.map((r) => [r.workspaceId, r.count])
  );
  const wsNameById = new Map(wsRaw.map((w) => [w.id, w.name]));

  // ── Profiles: representative sample (light) or per-workspace (full) ──
  const sampleWsId = workspaceId ?? wsIds[0];
  let profileSample: Array<{ slug: string; name: string }> = [];
  const perWsProfiles = new Map<
    string,
    Array<{ slug: string; name: string }>
  >();
  if (needProfiles && sampleWsId) {
    if (detail === "full") {
      // Per-workspace profiles — the old CLI `--details` N+1 fanout, now server-
      // side and shared. Best-effort per workspace; one failure never breaks all.
      const results = await Promise.all(
        wsRaw.map((w) =>
          caller.profiles
            .listProfiles({ userId, workspaceId: w.id })
            .then((res) => ({ id: w.id, profiles: trimProfiles(res) }))
            .catch(() => ({
              id: w.id,
              profiles: [] as Array<{ slug: string; name: string }>,
            }))
        )
      );
      for (const r of results) perWsProfiles.set(r.id, r.profiles);
      profileSample = perWsProfiles.get(sampleWsId) ?? [];
    } else {
      const res = await caller.profiles
        .listProfiles({ userId, workspaceId: sampleWsId })
        .catch(() => ({ profiles: [] }));
      profileSample = trimProfiles(res);
    }
  }

  // ── Workspaces DTO ──
  const workspacesOut: DiscoverWorkspace[] = needWorkspaces
    ? wsRaw.map((w) => {
        const settings = (w.settings ?? {}) as Record<string, unknown>;
        const onboarding = settings.onboarding as OnboardingSpec | undefined;
        const domain =
          (settings.workspaceSubtype as string | undefined) ??
          w.workspaceType ??
          null;
        const out: DiscoverWorkspace = {
          id: w.id,
          name: w.name,
          domain,
          entityCount: entityCountByWs.get(w.id) ?? 0,
        };
        if (onboarding) {
          out.onboarding =
            detail === "full"
              ? onboarding
              : onboarding.goal !== undefined
                ? { goal: onboarding.goal }
                : undefined;
        }
        if (detail === "full") {
          out.description = w.description ?? null;
          out.profiles = perWsProfiles.get(w.id) ?? [];
        }
        return out;
      })
    : [];

  // ── Projects DTO ── (dual-mode visibility, parity with GET /projects)
  let projectsOut: DiscoverProject[] = [];
  if (want("projects")) {
    const conditions: ReturnType<typeof eq>[] = [
      or(
        and(isNull(projects.workspaceId), eq(projects.userId, userId)),
        and(
          isNotNull(projects.workspaceId),
          userVisibleWhere(projects.workspaceId, userId)
        )
      )!,
    ];
    if (projectId) conditions.push(eq(projects.id, projectId));
    if (workspaceId) conditions.push(eq(projects.workspaceId, workspaceId));
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        status: projects.status,
        workspaceId: projects.workspaceId,
      })
      .from(projects)
      .where(and(...conditions));
    projectsOut = rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: p.status,
      workspaceId: p.workspaceId,
      homeWorkspace: p.workspaceId
        ? (wsNameById.get(p.workspaceId) ?? null)
        : null,
    }));
  }

  return {
    me: { userId, scopes },
    detail,
    projects: projectsOut,
    projectCount: projectsOut.length,
    workspaces: workspacesOut,
    workspaceCount: workspacesOut.length,
    profiles: profileSample,
    note: buildNote(projectsOut.length, workspacesOut.length),
  };
}
