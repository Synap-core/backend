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
 *     onboarding trimmed to its `goal` line.
 *   - detail:'full' — adds workspace descriptions, the FULL onboarding spec,
 *     per-workspace profile lists (the old CLI `--details` fanout), the flat
 *     profile sample, and every workspace including the empty ones.
 *
 * ── WHY LIGHT SUBTRACTS (2026-09-05) ──────────────────────────────────────
 * Orient is the FIRST call of every session, so its payload is the agent's
 * whole first impression of the pod. Measured live, light was dominated by
 * INVENTORY rather than briefing: 26 profile rows (a schema listing that the
 * profile-listing tool already serves on demand), 4 workspaces holding zero
 * entities, and a `description` that was a rendering of the `domain` field
 * sitting on the same row ("Domain: personal" on 9 of 14). None of it helps
 * an agent decide where to write. Light now carries only what shapes the next
 * action; `detail:'full'` keeps returning everything, unchanged — which is
 * what makes the subtraction safe rather than lossy.
 */

import {
  db,
  entities,
  projects,
  proposals,
  workspaces,
  eq,
  and,
  or,
  isNull,
  inArray,
  drizzleSql,
  profileSlugScopeCondition,
} from "@synap/database";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";
import { ownAgentUserFilter } from "../agent-identity-service.js";
import {
  getUserAccessibleWorkspaceIds,
  type HubProtocolCaller,
} from "../../routers/hub-protocol/rest/_shared.js";
import {
  formatTeamRosterBlock,
  loadTeamRosterForCapture,
} from "../team-roster-context.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

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
  /**
   * When-to-use for this domain. Full detail uses workspace.description;
   * light uses description or onboarding.goal so agents place work without
   * detail:full. Never invent product names — only live workspace metadata.
   */
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
  /** Workspaces ACTUALLY LISTED above (light hides empty ones — see below). */
  workspaceCount: number;
  /**
   * Empty domains hidden from the light list. Reported, never silently
   * swallowed: orient's whole failure mode is absence reading as emptiness.
   * Omitted when zero, and always zero under detail:'full'.
   */
  hiddenEmptyWorkspaceCount?: number;
  /**
   * Representative profile sample from the pinned / first workspace.
   * FULL only — or when the caller explicitly asked for scope:['profiles'].
   * The schema inventory is what the profile-listing tool is for; repeating it
   * on every session bootstrap paid ~26 rows × 6 fields for nothing.
   */
  profiles?: ProfileSample[];
  /**
   * Durable user model, as prose — the person, not the building. Sourced from
   * validated / high-confidence `user_observation` entities (the same rows the
   * IS bootstrap injects as "What I Know About You"). ABSENT when there are
   * none: an empty scaffold would teach the agent the pod knows nothing.
   */
  who?: string;
  /**
   * Pending-review backlog, omitted when empty. Surfaced here because the queue
   * is invisible to recall AND to dedup: unreviewed work reads as missing and
   * gets duplicated, and a pending template update keeps its capabilities off.
   */
  pendingReview?: { count: number; oldestDays: number };
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
function buildNote(
  projectCount: number,
  workspaceCount: number,
  pending: { count: number; oldestDays: number } | undefined,
  opts: { light: boolean; hiddenEmpty: number }
): string {
  // ── THE REVIEW QUEUE, SURFACED AT THE ONE CALL EVERY SESSION MAKES ─────────
  // Live dogfood (2026-07-24) proved the review queue is a uniform BLIND SPOT:
  // `ask` does not recall pending proposals, capture's dedup does not see them,
  // and `resolve_identity` answered match:"none" for a company sitting in TWO
  // pending proposals. So an unreviewed queue makes the pod amnesiac about its
  // own recent work AND mechanically drives the next agent to duplicate it.
  //
  // Worse, the queue gates the PLATFORM: a workspace-template update carrying
  // the user's `exa` capability sat unreviewed for days, so an agent correctly
  // reported the capability as unavailable — it was, pending one click.
  //
  // Indexing pending proposals into recall/dedup is the real fix. This is the
  // cheap half: `orient` is the mandated first call of every session, so naming
  // the backlog here turns every session start into a review nudge.
  const queue =
    pending && pending.count > 0
      ? `⚠ ${pending.count} proposal(s) awaiting your review` +
        (pending.oldestDays >= 1 ? `, oldest ${pending.oldestDays}d old` : "") +
        `. Pending proposals are NOT yet in the graph: recall will not find them and dedup cannot see them, ` +
        `so unreviewed work looks missing and gets duplicated — and a pending workspace/template update ` +
        `keeps its capabilities switched off. Surface this to the user early: list the ` +
        `pending proposals with whichever proposal-listing tool this door exposes ` +
        `to you, and offer to walk the queue before doing more work. `
      : "";
  // NOTE — do NOT name a concrete tool here. This is a RUNTIME RESPONSE
  // STRING, not a tool description: the Control Plane rewrites `synap_x` ->
  // `pod__x` only in tool DESCRIPTIONS, so a tool name baked into a response
  // body reaches claude.ai verbatim and points at a name that door does not
  // expose. This sentence said "call synap_list_proposals" for three external
  // test passes; each one reported it as a dead end. Describe the ACTION.
  // Same rule as the queue sentence above: name the ACTION, never a tool. The
  // entity-type inventory left the light payload — say where it went, or an
  // agent reads its absence as "this pod has no types" and invents its own.
  const light = opts.light
    ? `Entity types are not listed here — call the profile-listing tool this door exposes ` +
      `(or re-run this with detail:'full') before creating anything, so you write an existing kind. ` +
      (opts.hiddenEmpty > 0
        ? `${opts.hiddenEmpty} empty domain(s) are hidden from this list — they exist and detail:'full' shows them. `
        : ``)
    : ``;
  return (
    queue +
    light +
    `Domain map: ${projectCount} project(s), ${workspaceCount} domain app(s). ` +
    `WRITE by kind/profile (+ roles as facets when known) — omit workspaceId unless deliberately pinning; ` +
    `server places via installed profile metadata (never invent a workspace name). ` +
    `READ by name/id/role across everything you can access; pass workspaceId only to narrow a list. ` +
    (projectCount > 0
      ? // The project lens is the half agents never reach for. Measured: project
        // is set on ~7% of proposals and 0% of channels, while the SAME agents
        // place a workspace on essentially everything — because the workspace
        // lens is sticky (`set_workspace_focus`) and the project lens was not.
        // So SAY it is choosable, say it STICKS, and say the one thing that
        // makes project different from workspace: guessing it grants access.
        `A project is a cross-domain engagement thread that runs THROUGH ` +
        `workspaces (a client mandate, a venture) — a thing has one workspace ` +
        `but can belong to several projects. Pin it with set_project_focus and ` +
        `every later write inherits it; pass projectId to narrow a read. NEVER ` +
        `infer a project from content — filing work into one grants access to ` +
        `its members, so unset is the correct answer when nobody said. `
      : ``) +
    `If a domain is missing for the job, propose installing/attaching a template — do not invent workspaces.`
  );
}

/** An observation is worth a session's first impression at or above this. */
const WHO_MIN_CONFIDENCE = 0.7;
/** Hard cap — this is a briefing line, not the user-model store. */
const WHO_MAX_LINES = 6;

/**
 * The durable user model as prose.
 *
 * Reads the SAME rows the IS bootstrap already injects as "What I Know About
 * You" (`fetchUserObservations` in `bootstrap-assembler.ts`) — pod-scoped
 * `user_observation` entities with `uo_observation` / `uo_category` /
 * `uo_confidence` / `uo_validated`. This is not a second user model; it is the
 * same one, reaching the door that every non-IS agent actually walks through.
 *
 * Floor: a row the user CONFIRMED (`uo_validated`), or an inference the writer
 * was confident about. A low-confidence unvalidated guess is exactly what an
 * agent should not be told in its first sentence about a person.
 *
 * The type match goes through `profileSlugScopeCondition` — the ONE polymorphic
 * read door — not a hand-written type equality. `user_observation` is a primary
 * kind today, so the door resolves to exactly that predicate; writing it by hand
 * would have been correct only until the day it isn't, which is the whole reason
 * the door and its kind-blind-read tripwire exist.
 *
 * Returns undefined — never an empty heading — when nothing qualifies.
 */
async function buildWhoBlock(userId: string): Promise<string | undefined> {
  try {
    const typeMatch = await profileSlugScopeCondition(
      db,
      "user_observation",
      // Identity-wide: the durable user model is pod-scoped, and orient's lens
      // pin narrows WORKSPACES, never who the user is.
      await resolveFacetVisibilityScope(userId, undefined)
    );
    const rows = await db
      .select({ title: entities.title, properties: entities.properties })
      .from(entities)
      .where(
        and(eq(entities.userId, userId), typeMatch, isNull(entities.deletedAt))
      )
      .limit(40);

    const lines: string[] = [];
    for (const r of rows) {
      const props = (r.properties ?? {}) as Record<string, unknown>;
      const text = props.uo_observation ?? r.title;
      if (typeof text !== "string" || !text.trim()) continue;
      const validated = props.uo_validated === true;
      const confidence =
        typeof props.uo_confidence === "number" ? props.uo_confidence : 0;
      if (!validated && confidence < WHO_MIN_CONFIDENCE) continue;
      const category =
        typeof props.uo_category === "string" && props.uo_category
          ? `[${props.uo_category}] `
          : "";
      // Unvalidated rows are marked as inferences — the agent must be able to
      // tell what the user confirmed from what an agent guessed about them.
      const hedge = validated ? "" : " (inferred)";
      lines.push(`- ${category}${text.trim()}${hedge}`);
      if (lines.length >= WHO_MAX_LINES) break;
    }
    return lines.length ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
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
  // Light drops the profile inventory — UNLESS the caller asked for it by name.
  // An explicit `scope:['profiles']` is a direct request; answering it with
  // silence would be the same absence-reads-as-emptiness lie the pin guard
  // above exists to prevent. Default light simply never asks for it.
  const explicitProfiles = (params.scope ?? []).includes("profiles");
  const needProfiles =
    want("profiles") && (detail === "full" || explicitProfiles);

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

  // ── Profiles: full-only inventory (or an explicit scope:['profiles']) ──
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

  // ── Workspaces DTO (domains for agents) ──
  // Light orient always surfaces a short "when to use" so agents pick domain
  // by meaning (CRM vs Operations vs Builder), not by inventing UUIDs. Source
  // is live workspace metadata (description / onboarding.goal / subtype) —
  // never a hard-coded product map of slug→purpose.
  let hiddenEmptyWorkspaces = 0;
  const workspacesOut: DiscoverWorkspace[] = needWorkspaces
    ? wsRaw
        .filter((w) => {
          // Hide pure admin/system surfaces from the default domain map.
          const t = w.workspaceType ?? "";
          return t !== "operational" && t !== "agent";
        })
        .filter((w) => {
          if (detail === "full") return true;
          // Light hides EMPTY domains — an agent choosing where to write gains
          // nothing from a workspace holding no entities, and four of them were
          // half the list on the live pod.
          //
          // A pin is never hidden: if the caller asked for exactly this
          // workspace, showing it empty is the answer, not noise.
          if (workspaceId === w.id) return true;
          if ((entityCountByWs.get(w.id) ?? 0) > 0) return true;
          // Empty-but-MEANINGFUL: a fresh template install carries an
          // onboarding spec — it is empty because it is waiting for the user,
          // and that is exactly the domain an agent should be told about.
          const settings = (w.settings ?? {}) as Record<string, unknown>;
          if (settings.onboarding) return true;
          hiddenEmptyWorkspaces++;
          return false;
        })
        .map((w) => {
          const settings = (w.settings ?? {}) as Record<string, unknown>;
          const onboarding = settings.onboarding as OnboardingSpec | undefined;
          const domain =
            (settings.workspaceSubtype as string | undefined) ??
            w.workspaceType ??
            null;
          // A REAL purpose only — never a `Domain: ${domain}` rendering of the
          // `domain` field sitting on this very row. That fallback was bytes
          // for zero information and read like an authored description (9 of
          // 14 live workspaces said "Domain: personal"); both full and light
          // now emit `description` only when there is a real one.
          const authored =
            (typeof w.description === "string" && w.description.trim()) ||
            (typeof onboarding?.goal === "string" && onboarding.goal.trim()) ||
            null;
          const purpose = authored;
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
          // Full: real description/goal, or nothing. Light: same, truncated.
          if (detail === "full") {
            out.description = purpose
              ? (w.description ?? purpose)
              : (w.description ?? null);
          } else if (authored) {
            out.description =
              authored.length > 220 ? `${authored.slice(0, 217)}…` : authored;
          }
          if (detail === "full") {
            out.profiles = perWsProfiles.get(w.id) ?? [];
          }
          return out;
        })
    : [];

  // ── Projects DTO ── (dual-mode visibility, parity with GET /projects)
  let projectsOut: DiscoverProject[] = [];
  if (want("projects")) {
    const conditions: ReturnType<typeof eq>[] = [
      ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)!,
    ];
    if (projectId) conditions.push(eq(projects.id, projectId));
    if (workspaceId) conditions.push(eq(projects.workspaceId, workspaceId));
    // Discovery surfaces (orient/CLI/MCP) show ACTIVE projects only — archiving
    // must actually declutter. An explicitly-requested projectId is exempt so a
    // direct lookup of an archived project still resolves.
    if (!projectId) conditions.push(eq(projects.status, "active"));
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

  // Pending-review backlog. Best-effort: orient must never fail because the
  // proposals read hiccuped — a missing nudge is far better than a broken map.
  //
  // MUST match what `synap_list_proposals` returns (the tool the nudge tells the
  // user to call), or the count and the tool disagree. The canonical queue floors
  // by AUTHOR — me OR an agent I created (`proposals-service.ts`) — with a
  // workspaceId only NARROWING. An earlier version floored by workspace
  // MEMBERSHIP instead, which on a multi-user pod counted a teammate's pending
  // proposals for this user (both a wrong count and a small disclosure of their
  // backlog). Floor by author, user-wide, exactly like the tool's default.
  //
  // `count` and `oldest` are aggregated over the SAME floored population as the
  // list: widening the list without widening this would make `oldestDays` a
  // number computed over a different set than the count printed beside it.
  let pendingSummary: { count: number; oldestDays: number } | undefined;
  try {
    // COUNT + MIN in one aggregate row — never load the rows themselves. On a
    // busy pod the pending queue can be large, and orient runs on every session
    // start; a full-row fetch just to count would tax the mandated first call.
    const [agg] = await db
      .select({
        count: drizzleSql<number>`count(*)::int`,
        oldest: drizzleSql<Date | null>`min(${proposals.createdAt})`,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.status, "pending"),
          or(
            eq(proposals.createdBy, userId),
            ownAgentUserFilter(proposals.agentUserId, userId),
            ownAgentUserFilter(proposals.createdBy, userId)
          )
        )
      );
    if (agg && agg.count > 0) {
      pendingSummary = {
        count: agg.count,
        oldestDays: agg.oldest
          ? Math.floor(
              (Date.now() - new Date(agg.oldest).getTime()) / 86_400_000
            )
          : 0,
      };
    }
  } catch {
    pendingSummary = undefined;
  }

  // Who the user IS — the one thing orient never carried. Best-effort, same
  // rule as the roster: a failed read costs a prose block, never the map.
  const who = await buildWhoBlock(userId);

  const result: DiscoverResult = {
    me: { userId, scopes: authScopes },
    detail,
    projects: projectsOut,
    projectCount: projectsOut.length,
    workspaces: workspacesOut,
    workspaceCount: workspacesOut.length,
    ...(hiddenEmptyWorkspaces > 0
      ? { hiddenEmptyWorkspaceCount: hiddenEmptyWorkspaces }
      : {}),
    ...(needProfiles ? { profiles: profileSample } : {}),
    ...(pendingSummary ? { pendingReview: pendingSummary } : {}),
    ...(who ? { who } : {}),
    note: buildNote(projectsOut.length, workspacesOut.length, pendingSummary, {
      light: detail !== "full",
      hiddenEmpty: hiddenEmptyWorkspaces,
    }),
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
