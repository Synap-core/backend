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
import {
  formatTeamRosterBlock,
  loadTeamRosterForCapture,
} from "../team-roster-context.js";

export type DiscoverDetail = "light" | "full";
export type DiscoverScope = "workspaces" | "projects" | "profiles";

const ALL_SCOPES: DiscoverScope[] = ["workspaces", "projects", "profiles"];

/**
 * A pinned `workspaceId` the caller cannot see. Thrown — never returned as an
 * empty success, which is the lie this class exists to prevent: orient is the
 * agent's FIRST call, so "0 workspaces" reads as "the pod is empty" and the
 * agent goes on to re-create data that already exists.
 *
 * Deliberately does NOT distinguish "no such workspace" from "exists but not
 * yours": we never load the row, and telling them apart would hand any caller
 * an existence oracle for workspace UUIDs. One condition, one message.
 */
export class WorkspaceNotAccessibleError extends Error {
  readonly code = "workspace_not_accessible";
  readonly workspaceId: string;
  constructor(message: string, workspaceId: string) {
    super(message);
    this.name = "WorkspaceNotAccessibleError";
    this.workspaceId = workspaceId;
  }
}

/**
 * Build the not-accessible error, naming the workspaces the caller DOES have.
 *
 * Ordering is load-bearing: the recovery advice comes BEFORE the workspace
 * list because the MCP error door (`mcp/tool-errors.ts`) truncates messages at
 * 500 chars — truncation must eat the tail of the list, never the fix.
 */
async function workspaceNotAccessible(
  workspaceId: string,
  accessibleIds: string[]
): Promise<WorkspaceNotAccessibleError> {
  const rows = accessibleIds.length
    ? await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, accessibleIds))
    : [];
  const advice =
    `Workspace ${workspaceId} isn't accessible to you (it may not exist, or isn't shared with you). ` +
    `This pin — not an empty pod — is why nothing came back. ` +
    `If it came from your MCP URL's ?workspaceId= pin, that pin applies to every call: fix or remove it there. ` +
    `Otherwise retry without workspaceId. `;

  if (!rows.length) {
    return new WorkspaceNotAccessibleError(
      `${advice}You have no accessible workspaces.`,
      workspaceId
    );
  }

  // Fit whole entries inside the MCP door's 500-char cap rather than a guessed
  // count: a mid-UUID truncation would hand the agent an id it might copy.
  // Entries are dropped whole, and the remainder is always accounted for.
  const BUDGET = 500 - advice.length - "Yours: , +99 more.".length;
  const shown: string[] = [];
  let used = 0;
  for (const w of rows) {
    const entry = `${w.name.slice(0, 32)} (${w.id})`;
    if (used + entry.length + 2 > BUDGET) break;
    shown.push(entry);
    used += entry.length + 2;
  }
  const more =
    rows.length > shown.length ? `, +${rows.length - shown.length} more` : "";
  const yours = shown.length
    ? `Yours: ${shown.join(", ")}${more}.`
    : `You have ${rows.length} workspace(s) — retry without workspaceId to list them.`;

  return new WorkspaceNotAccessibleError(advice + yours, workspaceId);
}

interface DiscoverOptions {
  detail?: DiscoverDetail;
  scope?: DiscoverScope[];
  workspaceId?: string;
  projectId?: string;
}

export interface DiscoverParams extends DiscoverOptions {
  /** A hub-protocol caller (for profiles.listProfiles). Built by the call site. */
  caller: HubProtocolCaller;
  userId: string;
  /** The caller's auth scopes — echoed to `me.scopes` (NOT the section filter). */
  authScopes: string[];
}

interface OnboardingSpec {
  goal?: string;
  [k: string]: unknown;
}

/**
 * A profile in the orient sample. Carries the Kind + Facets discriminator so an
 * agent can tell a primary type (kind) from an attachable role (facet) at
 * orient time, before it lists profiles or creates entities.
 */
interface ProfileSample {
  slug: string;
  name: string;
  profileKind: "kind" | "role";
  applicableKinds?: string[] | null;
  /** Visibility — who can use the type (system|shared|workspace|user). */
  scope?: string | null;
  /** Placement — where its entities live (pod|workspace). */
  entityScope?: string | null;
}

interface DiscoverWorkspace {
  id: string;
  name: string;
  /** Operational-domain label: settings.workspaceSubtype ?? workspaceType. */
  domain: string | null;
  entityCount: number;
  /** light: `{ goal }` only; full: the whole onboarding interview spec. */
  onboarding?: OnboardingSpec;
  /** full only */
  description?: string | null;
  /** full only — this workspace's profiles (slug + name + kind). */
  profiles?: ProfileSample[];
}

interface DiscoverProject {
  id: string;
  name: string;
  description: string | null;
  status: string | null;
  workspaceId: string | null;
  homeWorkspace: string | null;
}

/**
 * Prompt-facing team roster (no emails). Same OUR TEAM context capture
 * injects into structure — agents that orient get it without a second call.
 */
export interface DiscoverTeamRoster {
  instructionBlock: string | null;
  /** Dedup aliases (names/handles) — emails stripped for prompt safety. */
  names: string[];
  members: Array<{ displayName: string; personId?: string | null }>;
}

interface DiscoverResult {
  me: { userId: string; scopes: string[] };
  detail: DiscoverDetail;
  projects: DiscoverProject[];
  projectCount: number;
  workspaces: DiscoverWorkspace[];
  workspaceCount: number;
  /** Representative profile sample from the pinned / first workspace. */
  profiles: ProfileSample[];
  note: string;
  /**
   * Internal team for the pinned / sample workspace. Omitted when empty.
   * No emails — display names + person ids only.
   */
  teamRoster?: DiscoverTeamRoster;
}

/** Take listProfiles's `{ profiles }` shape → a light slug+name+kind list. */
function trimProfiles(res: unknown): ProfileSample[] {
  const list = ((res as { profiles?: unknown }).profiles ?? []) as Array<{
    slug?: string;
    name?: string;
    displayName?: string;
    profileKind?: "kind" | "role";
    applicableKinds?: string[] | null;
    scope?: string | null;
    entityScope?: string | null;
  }>;
  return list.flatMap((p) =>
    p.slug
      ? [
          {
            slug: p.slug,
            name: p.displayName ?? p.name ?? p.slug,
            // Kind + Facets discriminator (defaults to "kind" for legacy rows).
            profileKind: p.profileKind ?? "kind",
            applicableKinds: p.applicableKinds ?? null,
            // Visibility (who can see) + placement (where entities live).
            scope: p.scope ?? null,
            entityScope: p.entityScope ?? null,
          },
        ]
      : []
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
  const { caller, userId, authScopes, workspaceId, projectId } = params;
  const detail: DiscoverDetail = params.detail ?? "light";
  const wantScopes =
    params.scope && params.scope.length ? params.scope : ALL_SCOPES;
  const want = (s: DiscoverScope): boolean => wantScopes.includes(s);

  // Accessible workspace ids (memberships + pod-visible), narrowed when pinned.
  // A pin that isn't in the allow-list is REJECTED, not filtered away: filtering
  // collapsed wsIds to [] and every section below then fell out empty *by
  // construction*, reporting an inaccessible workspace as an empty pod.
  const wsIds = await getUserAccessibleWorkspaceIds(userId);
  if (workspaceId && !wsIds.includes(workspaceId)) {
    throw await workspaceNotAccessible(workspaceId, wsIds);
  }
  const lensWsIds = workspaceId ? [workspaceId] : wsIds;

  const needWorkspaces = want("workspaces");
  const needProfiles = want("profiles");

  // Workspace rows + per-workspace live entity counts (same count semantics as
  // GET /workspaces, so orient reports the truth instead of "empty").
  const [wsRaw, countRows] = await Promise.all([
    (needWorkspaces || needProfiles) && lensWsIds.length
      ? db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            description: workspaces.description,
            settings: workspaces.settings,
            workspaceType: workspaces.workspaceType,
          })
          .from(workspaces)
          .where(inArray(workspaces.id, lensWsIds))
      : Promise.resolve([]),
    needWorkspaces && lensWsIds.length
      ? db
          .select({
            workspaceId: entities.workspaceId,
            count: drizzleSql<number>`cast(count(*) as integer)`,
          })
          .from(entities)
          .where(
            and(
              inArray(entities.workspaceId, lensWsIds),
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
  const sampleWsId = workspaceId ?? lensWsIds[0];
  let profileSample: ProfileSample[] = [];
  const perWsProfiles = new Map<string, ProfileSample[]>();
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
              profiles: [] as ProfileSample[],
            }))
        )
      );
      for (const r of results) perWsProfiles.set(r.id, r.profiles);
      profileSample = perWsProfiles.get(sampleWsId) ?? [];
    } else {
      // NOT best-effort: this is the single sample the agent judges the pod by.
      // Swallowing the failure into `profiles: []` reported "you have no entity
      // types" as a success — the same lie as the pin bug, one section down.
      // Let it throw; the callers' error arms say something true instead.
      const res = await caller.profiles.listProfiles({
        userId,
        workspaceId: sampleWsId,
      });
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
    // Resolve home-workspace NAMES for any project whose workspace wasn't loaded
    // above (e.g. scope:['projects'] skips the workspaces query) — a project
    // still has a real home workspace; don't mislabel it as null.
    const missingWsIds = [
      ...new Set(
        rows
          .map((p) => p.workspaceId)
          .filter((id): id is string => !!id && !wsNameById.has(id))
      ),
    ];
    if (missingWsIds.length) {
      const names = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, missingWsIds));
      for (const w of names) wsNameById.set(w.id, w.name);
    }
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

  const result: DiscoverResult = {
    me: { userId, scopes: authScopes },
    detail,
    projects: projectsOut,
    projectCount: projectsOut.length,
    workspaces: workspacesOut,
    workspaceCount: workspacesOut.length,
    profiles: profileSample,
    note: buildNote(projectsOut.length, workspacesOut.length),
  };

  // Team roster — same loader capture uses for structure. One workspace only
  // (pinned or first accessible sample) so light orient stays cheap. Best-
  // effort: never fail orient on roster errors. No emails in the payload.
  const rosterWsId = sampleWsId;
  if (rosterWsId) {
    try {
      const roster = await loadTeamRosterForCapture(db, {
        workspaceId: rosterWsId,
        userId,
      });
      // Strip email from every prompt-facing field (loader may fall back
      // displayName → email when the user has no name set).
      const members = roster.members.map((m) => ({
        displayName: m.displayName.includes("@") ? "Member" : m.displayName,
        personId: m.personId ?? null,
      }));
      const names = roster.names.filter((n) => !n.includes("@"));
      const instructionBlock =
        roster.instructionBlock && !roster.instructionBlock.includes("@")
          ? roster.instructionBlock
          : formatTeamRosterBlock(
              members.map((m) => ({
                displayName: m.displayName,
                personId: m.personId,
              }))
            );
      if (members.length > 0 || instructionBlock) {
        result.teamRoster = {
          instructionBlock,
          names,
          members,
        };
      }
    } catch {
      // Best-effort — orient proceeds without team context.
    }
  }

  return result;
}
