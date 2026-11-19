/**
 * App Connect — the ONE service behind every door that asks for, issues,
 * renames, revokes or removes an Application's access: Hub REST
 * `/api/hub/apps*` (the CLI) and tRPC `apps.*` (a signed-in person). Errors
 * are `TRPCError`s; the Hub door maps their codes (`httpStatusForTrpcError`).
 *
 * Every lifecycle act is an event on the app's timeline (`subjectType: "app"`,
 * `app_id` = public_id): `app.{request|approve|issue_key|revoke|rename|
 * remove_for_good}.completed` (`APP_EVENT_ACTIONS`, vocabulary verbs). A key's
 * plaintext is never logged.
 *
 * An app acts as its OWN agent user (`apps.agent_user_id`) with the
 * `ask-first` posture: its key is held by that agent and linked to the owner,
 * so every write runs the ONE agent ladder (`resolveAgentGovernanceDecision`)
 * — a grant permits, it never auto-approves. The grant carries
 * `client_id = public_id` ("via <app>"). The agent is shown only as its app
 * (`notAnAppAgent`).
 */

import { createHash, randomBytes } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  inArray,
  isNull,
  ne,
  sql,
  drizzleSql,
  getActingAgentUserId,
  getRequestGrant,
  isFullAccessGrant,
  ApiKeyRepository,
  AppNameTakenError,
  APP_EVENT_ACTIONS,
  readAppConnectRequests,
  AppRepository,
  EventRepository,
  GrantRepository,
  proposals,
  readReversibleDefault,
  ProposalStatus,
  type AppWithGrants,
} from "@synap/database";
import {
  APP_PERSON_KEY_TYPE,
  apiKeys,
  apps,
  oauthAuthorizationCodes,
  profiles,
  projects,
  users,
  webhookSubscriptions,
  workspaceMembers,
  workspaces,
  KEY_PREFIXES,
  isPodWideReadPermission,
  type AppApprovedRequest,
  type RequestedKindGroup,
} from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import {
  applyAgentPosture,
  readAgentGovernance,
  readAgentWritePostures,
  type AgentGovernanceState,
} from "@synap/database/agent-governance";
import {
  AGENT_WRITE_MODE_LINE,
  resolveAgentWriteMode,
  type AgentWriteMode,
} from "@synap-core/types/agents";
import {
  assertPermissions,
  InvalidPermissionError,
  parsePermission,
} from "@synap/governance-policy/grants";
import { createPendingProposal } from "../utils/permission-check.js";
import { openLink } from "../utils/deep-links.js";
import { auditLog } from "../utils/audit-log.js";
import { getUserWorkspaceIds } from "../utils/workspace-membership.js";
import {
  attachGrantsOrRevoke,
  describeGrantLimit,
  grantWithinLive,
  liveGrantsOfKey,
  type GrantInput,
} from "./key-grant.js";
import {
  oauthClientInstancePrefix,
  parseOauthKeyInstanceId,
} from "../routers/oauth/config.js";
import { findOrCreateServiceAgentUser } from "./agent-identity-service.js";
import { revokeConnectionRefreshTokens } from "../routers/oauth/refresh.js";
import { isSynapApp, type PodAppActsAs } from "../routers/oauth/config.js";
import type { Context } from "../types/context.js";
import { isAgentCaller } from "./library/agent-door.js";
import { assertPresencePass, type PresencePass } from "./presence/pass.js";
import { AccessContext } from "../access/context.js";
import { projectVisibleWhere } from "../access/project-visibility.js";
import {
  addPermissionsToAccess,
  appAccessBeyond,
  appAccessGivesAnything,
  clampAppAccess,
  candidateAccess,
  normalizeAppAccess,
  pairsOfAccess,
  type AccessBeyond,
  type AccessWritePlace,
  type AppAccessCeiling,
  type NamedAppAccess,
  type NamedProject,
  type NamedSpace,
  type ReconsentView,
  type ReconsentWas,
  appAccessWithin,
  assertNeverPlace,
  EVERYWHERE_IN_POD,
  grantScopesForAccess,
  liftApprovedRequests,
  pairsOfRequests,
  pairsWithin,
  expandAppAccess,
  parseAppAccess,
  parseRequestPlace,
  permissionWithin,
  PlaceError,
  permissionsForKinds,
  withAppRequestScope,
  type AppAccess,
  type Place,
} from "@synap-core/types/grants";

/**
 * A request as a door sends it: a permission plus EITHER the workspace's id
 * (the UI) or its NAME (the CLI manifest).
 */
export type AccessRequestInput =
  | { permission: string; workspaceId: string }
  | { permission: string; workspace: string };

/**
 * A request in ONE space: what the asking door (`requestAccess`, the CLI and
 * Hub REST) files. Only a pod app's consent offers a pod-wide read
 * (`connectOAuthApp`, decision e1b59d38 "B"); nothing here can ask for one.
 */
type SpaceRequest = AppApprovedRequest & { workspaceId: string };

/** The wire shape of an app — snake_case, the fields the CLI + UI read. */
export function serializeApp(row: AppWithGrants) {
  const { app } = row;
  return {
    id: app.id,
    public_id: app.publicId,
    name: app.name,
    description: app.description,
    logo_url: app.logoUrl,
    mode: app.mode,
    approved_requests: app.approvedRequests ?? null,
    pending_request: row.pendingRequest
      ? {
          proposal_id: row.pendingRequest.proposalId,
          requests: row.pendingRequest.requests,
          requested_at: row.pendingRequest.requestedAt,
        }
      : null,
    created_at: app.createdAt,
    revoked_at: app.revokedAt,
    removed_at: app.removedAt,
    /**
     * The app's own agent user (null until its first key is issued). Its
     * writes are governed by rules on THIS agent (`governanceRules.create`,
     * target agent) — the app page's "ask first / apply automatically".
     */
    agent_user_id: app.agentUserId,
    /**
     * "Sign in with Synap": where a person's sign-in code may be delivered
     * (exact match). Empty = the app signs no one in. Set by the owner only.
     */
    redirect_uris: app.redirectUris ?? [],
    /**
     * May a person signed in to this app approve its OWN agent's proposals
     * from inside it? Owner-set (`setAppSignInPolicy`); absent = true.
     */
    person_may_decide_own_agent_proposals:
      (app.metadata as Record<string, unknown> | null)
        ?.personMayDecideOwnAgentProposals !== false,
    last_used_at: row.lastUsedAt,
    grants: row.grants,
  };
}
export type AppWire = ReturnType<typeof serializeApp>;

/**
 * The pod admin's reading of apps (`apps.adminList` / `apps.adminGet`): the
 * owner's wire row plus what an admin cannot read from their own seat — its
 * keys (`keysByApp`, batched), its OWNER, and the names of the spaces its
 * reach and request name (`workspace_names`, the `workspaceNames` input of
 * `appHolderAccess`). An admin is often not a member of the space an app
 * reaches, so the names cannot come from the admin's own space list. Four
 * queries for any number of apps.
 */
export async function serializeAppsForAdmin(rows: readonly AppWithGrants[]) {
  if (rows.length === 0) return [];
  const keys = await new AppRepository(db).keysByApp(
    rows.map((r) => r.app.publicId)
  );
  const ownerIds = [...new Set(rows.map((r) => r.app.ownerUserId))];
  const owners = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, ownerIds));
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const spaceIdsOf = (row: AppWithGrants): string[] =>
    [
      ...row.grants.flatMap((g) => g.workspaceIds ?? []),
      ...(row.pendingRequest?.requests ?? []).map((r) => r.workspaceId),
      ...(row.app.approvedRequests ?? []).map((r) => r.workspaceId),
    ].filter((id): id is string => id !== null);
  const spaceIds = [...new Set(rows.flatMap(spaceIdsOf))];
  const spaces =
    spaceIds.length > 0
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, spaceIds))
      : [];
  const spaceName = new Map(spaces.map((s) => [s.id, s.name]));
  return rows.map((row) => {
    const names: Record<string, string> = {};
    for (const id of spaceIdsOf(row)) {
      const name = spaceName.get(id);
      if (name !== undefined) names[id] = name;
    }
    return {
      ...serializeApp(row),
      keys: keys.get(row.app.publicId) ?? [],
      /** null when the owner's user row is gone. */
      owner: ownerById.get(row.app.ownerUserId) ?? null,
      workspace_names: names,
    };
  });
}

/** One of the owner's apps by public id; NOT_FOUND for anyone else. */
export async function loadOwnedApp(
  publicId: string,
  ownerUserId: string
): Promise<AppWithGrants> {
  const found = await new AppRepository(db).getByPublicId(publicId);
  if (!found || found.app.ownerUserId !== ownerUserId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  }
  return found;
}

/**
 * The app an END act (revoke, remove for good) targets: the caller's own
 * (`loadOwnedApp`), or — with `podAdmin`, which ONLY a `podAdminProcedure`
 * sets (`apps.adminRevoke` / `apps.adminRemove`, the console's Apps page) —
 * any owner's. Ending is the one lifecycle act a pod admin needs on someone
 * else's app (a leaked key, a member who left); asking, issuing and renaming
 * stay the owner's. Everything after the load is the same service, so an
 * admin's revoke stops exactly what the owner's would.
 */
async function loadAppToEnd(
  publicId: string,
  callerUserId: string,
  podAdmin: boolean | undefined
): Promise<AppWithGrants> {
  if (!podAdmin) return loadOwnedApp(publicId, callerUserId);
  const found = await new AppRepository(db).getByPublicId(publicId);
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  }
  return found;
}

/**
 * The ONE credential check every app-lifecycle WRITE runs (register/revive,
 * issue key, rename, revoke, remove): the caller must be the owner signed in
 * AS THEMSELVES — neither an agent's credential (`actorAgentUserId`, or the
 * request's ambient acting agent) nor a grant-bound key. An agent key resolves
 * `userId` to the human it acts for, so without this a scoped agent could
 * revoke its owner's apps (its own parent included) or revive a revoked one.
 * Reads stay open.
 *
 * "Grant-bound" means a NARROWED grant. Since P5 (2026-10-11) every key
 * carries a grant: the person's own key (`apiKeys.connectIntegration`,
 * `pods add`) holds the explicit full-access `*` — their whole reach, not a
 * bound. Refusing ANY ambient grant locked the owner's own key out of every
 * lifecycle write. A `*` limited to a space, project or object is a scoped key
 * (S1) and stays refused; `isFullAccessGrant` is the one predicate for that.
 *
 * "An agent's credential" is `isAgentCaller`: an agent key OR the Intelligence
 * Service's internal key. The IS (D4 delegation) is remapped to its operator
 * with no acting agent and the full-access `*` — without its `keyType` the
 * `*` rule above would let it mint (and receive) an app key as the operator.
 */
export function assertOwnerCredential(
  act: string,
  caller: { agentUserId?: string | null; keyType?: string | null } = {}
): void {
  if (
    isAgentCaller({
      agentUserId: caller.agentUserId ?? getActingAgentUserId(),
      keyType: caller.keyType,
    })
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `An agent credential cannot ${act} — sign in as the app's owner.`,
    });
  }
  const grant = getRequestGrant();
  if (grant && !isFullAccessGrant(grant)) {
    // Name the limit AND the fix: "a scoped key" alone sent the owner hunting
    // for which of their keys was scoped, and why (2026-10-20).
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        `A scoped key cannot ${act}: this key is ${describeGrantLimit(grant)}. ` +
        `Use a full-access key — create one in Pod Admin → Keys (Personal, ` +
        `"Full access", with the hub-protocol.write scope), or widen this ` +
        `key's access there. \`synap whoami\` shows what a key may touch.`,
    });
  }
}

/**
 * Register (or revive, by owner + name) an app — the ONE service behind
 * `POST /api/hub/apps` and `apps.create`. Reviving clears the old approval
 * (`AppRepository.register`). Returns the app through the one read projection.
 */
export async function registerApp(args: {
  ownerUserId: string;
  name: string;
  description?: string | null;
  logoUrl?: string | null;
  mode?: "specific";
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
}): Promise<AppWithGrants> {
  assertOwnerCredential("register an app", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  let record;
  try {
    record = await new AppRepository(db).register({
      ownerUserId: args.ownerUserId,
      name: args.name,
      description: args.description,
      logoUrl: args.logoUrl,
      mode: args.mode,
    });
  } catch (err) {
    // The name belongs to a pod app the owner connected (`connectOAuthApp`).
    if (err instanceof AppNameTakenError)
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    throw err;
  }
  return loadOwnedApp(record.publicId, args.ownerUserId);
}

function assertNotRevoked(found: AppWithGrants): void {
  // Revoked is terminal until the app is registered again (which clears it).
  if (found.app.revokedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app was revoked — register it again to reconnect.",
    });
  }
}

async function recordAppEvent(
  found: AppWithGrants,
  actorUserId: string,
  action: (typeof APP_EVENT_ACTIONS)[keyof typeof APP_EVENT_ACTIONS],
  data: Record<string, unknown> = {}
): Promise<void> {
  await auditLog({
    subjectType: "app",
    action,
    phase: "completed",
    subjectId: found.app.id,
    userId: actorUserId,
    workspaceId: null,
    appId: found.app.publicId,
    data: { name: found.app.name, publicId: found.app.publicId, ...data },
  });
}

/**
 * Resolve each request to `{ permission, workspaceId }` within the workspaces
 * the owner can reach. An unknown name or an unreachable id fails LOUD.
 */
async function resolveRequests(
  ownerUserId: string,
  requests: AccessRequestInput[]
): Promise<Array<SpaceRequest & { workspaceName: string }>> {
  try {
    assertPermissions(requests.map((r) => r.permission));
  } catch (err) {
    if (err instanceof InvalidPermissionError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
  const reachable = await getUserWorkspaceIds(ownerUserId);
  const rows =
    reachable.length > 0
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, reachable))
      : [];
  const ids = new Set(rows.map((r) => r.id));
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const nameOf = new Map(rows.map((r) => [r.id, r.name]));
  return requests.map((r) => {
    const id =
      "workspaceId" in r
        ? ids.has(r.workspaceId)
          ? r.workspaceId
          : undefined
        : byName.get(r.workspace.toLowerCase());
    if (!id) {
      const named = "workspaceId" in r ? r.workspaceId : `"${r.workspace}"`;
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Unknown workspace ${named} — no workspace of that ${
          "workspaceId" in r ? "id" : "name"
        } is visible to you.`,
      });
    }
    // The name rides along so the review card can say "Create People ·
    // Sales" without a second read; the approval records only the pair.
    return {
      permission: r.permission,
      workspaceId: id,
      workspaceName: nameOf.get(id)!,
    };
  });
}

/** A `workspace_members.role` that may write in its space. */
const WRITE_ROLES = ["owner", "admin", "editor"];

/** Is this permission a READ (everything else, `*` included, is a write)? */
const isReadPermission = (permission: string): boolean =>
  parsePermission(permission).at(-1) === "read";

/**
 * Of `ids`, the spaces where `ownerUserId` may give an app a WRITE: spaces
 * they OWN, or where they are an owner / admin / editor member.
 */
async function spacesOwnerMayWriteIn(
  ownerUserId: string,
  ids: readonly string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [owned, editing] = await Promise.all([
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          inArray(workspaces.id, [...ids]),
          eq(workspaces.ownerId, ownerUserId)
        )
      ),
    db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(
        and(
          inArray(workspaceMembers.workspaceId, [...ids]),
          eq(workspaceMembers.userId, ownerUserId),
          inArray(workspaceMembers.role, WRITE_ROLES)
        )
      ),
  ]);
  return new Set([...owned, ...editing].map((r) => r.id));
}

/**
 * An owner gives an app only what they can do themselves (invariant 1 at the
 * GIVING side). `resolveRequests` bounds a request by the spaces the owner can
 * READ — member ∪ owned ∪ pod-visible — but approving a WRITE makes the app's
 * agent an `editor` member there (`syncAppAgentMemberships`). So a write
 * (anything but `…read`, `*` included) needs the owner to OWN the space or be
 * an owner / admin / editor member of it; a read stays bounded by what they
 * can read. Run when the request is filed AND when it is approved (a role can
 * drop in between).
 */
/**
 * The write requests among `requests` that the owner may NOT give: a write in
 * a space they neither own nor hold owner / admin / editor in. The ONE rule
 * behind `assertOwnerMayGrant` (asking, approving) and `ownerGrantableNow`
 * (every sign-in request, PR #29 H1/L1).
 */
async function writesBeyondOwner<T extends AppApprovedRequest>(
  ownerUserId: string,
  requests: readonly T[]
): Promise<T[]> {
  const writes = requests.filter((r) => !isReadPermission(r.permission));
  if (writes.length === 0) return [];
  const may = await spacesOwnerMayWriteIn(ownerUserId, [
    ...new Set(writes.flatMap((r) => (r.workspaceId ? [r.workspaceId] : []))),
  ]);
  // A write is never given pod-wide: one with no space is always beyond.
  return writes.filter(
    (r) => r.workspaceId === null || !may.has(r.workspaceId)
  );
}

/**
 * What of an app's approval its owner could STILL give right now: reads in
 * spaces they can read, writes where they still edit. An approval outlives
 * the owner's role; a person signed in to the app must not (PR #29 H1/L1) —
 * so every sign-in request is bounded by this, not by the approval alone.
 */
export async function ownerGrantableNow(
  ownerUserId: string,
  approved: readonly AppApprovedRequest[]
): Promise<AppApprovedRequest[]> {
  if (approved.length === 0) return [];
  const readable = new Set(await getUserWorkspaceIds(ownerUserId));
  const beyond = new Set(
    (await writesBeyondOwner(ownerUserId, approved)).map(
      (r) => `${r.workspaceId} ${r.permission}`
    )
  );
  return approved.filter((r) =>
    r.workspaceId === null
      ? // A pod-wide read reads only what the person reads (grant ∩ floor).
        isPodWideReadPermission(r.permission)
      : readable.has(r.workspaceId) &&
        !beyond.has(`${r.workspaceId} ${r.permission}`)
  );
}

export async function assertOwnerMayGrant(
  ownerUserId: string,
  requests: ReadonlyArray<
    AppApprovedRequest & { workspaceName?: string | null }
  >
): Promise<void> {
  assertPodWideReadsOnly(requests);
  const beyond = await writesBeyondOwner(ownerUserId, requests);
  if (beyond.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You can only give an app what you can do yourself — you cannot edit in ${[
        ...new Set(beyond.map((r) => r.workspaceName ?? r.workspaceId)),
      ].join(", ")}: ${beyond
        .map((r) => r.permission)
        .join(
          ", "
        )}. Ask for read access there, or for edit rights in that space first.`,
    });
  }
}

/**
 * A pod-wide pair (no space) is a READ of one named kind and nothing else
 * (`isPodWideReadPermission`, decision e1b59d38 "B"): every write stays
 * pinned to a space. Run wherever an approval is checked (consent, the
 * `app/connect` executor, through `assertOwnerMayGrant`).
 */
export function assertPodWideReadsOnly(
  requests: readonly AppApprovedRequest[]
): void {
  const beyond = requests.filter(
    (r) => r.workspaceId === null && !isPodWideReadPermission(r.permission)
  );
  if (beyond.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Only a read of one kind, or of a subject on the pod-wide list, can be given everywhere in your pod; every other permission is given in a space: ${beyond
        .map((r) => r.permission)
        .join(", ")}.`,
    });
  }
}

/**
 * A request may never be wider than the credential that files it (invariant
 * 1 at the ASKING door). A signed-in session or the owner's own unbounded `*`
 * key asks with the owner's whole reach (`resolveRequests` bounds that to
 * their spaces). Any narrower credential — an agent's key, a scoped key, an
 * app's own key — may ask only for what its LIVE grant already covers, each
 * (permission × space) by one live scope (`grantWithinLive`, the rule a
 * hosted agent is bounded by its computer with). Otherwise one approval click
 * would launder a wider credential than the asker holds.
 */
function assertRequestsWithinCaller(
  requests: ReadonlyArray<SpaceRequest & { workspaceName: string }>
): void {
  const grant = getRequestGrant();
  if (!grant || isFullAccessGrant(grant)) return;
  const live = grant.scopes.map((s) => ({
    permissions: [...s.permissions],
    workspaceIds: s.workspaceIds ? [...s.workspaceIds] : null,
    projectIds: s.projectIds ? [...s.projectIds] : null,
    entityIds: s.entityIds ? [...s.entityIds] : null,
    expiresAt: null,
  }));
  const beyond = requests.filter(
    (r) =>
      !grantWithinLive(
        { permissions: [r.permission], workspaceIds: [r.workspaceId] },
        live
      )
  );
  if (beyond.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This credential cannot ask for more than it holds itself: ${beyond
        .map((r) => `${r.permission} in ${r.workspaceName}`)
        .join(", ")}. Ask with your own sign-in, or with a key that holds it.`,
    });
  }
}

/**
 * Ask for access: file ONE `app/connect` proposal (always — through
 * `createPendingProposal`, never the gate ladder, which could answer
 * `granted` and authorize reach with no review).
 *
 * An AGENT may ask (it is how an agent gets an app connected), but the
 * proposal is filed AS the agent — `agentUserId` / `createdBy` the agent,
 * `proposedByUserId` null — so the reviewer sees who is asking; it is never
 * disguised as the person's own request. Approving stays the owner's step
 * (the agent-approver floor + the executor's owner check).
 */
export async function requestAccess(args: {
  publicId: string;
  ownerUserId: string;
  requests: AccessRequestInput[];
  /** The acting agent, when an agent's key files it (else the request ALS). */
  actorAgentUserId?: string | null;
}): Promise<{ proposalId: string; reviewUrl: string }> {
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const requests = await resolveRequests(args.ownerUserId, args.requests);
  assertRequestsWithinCaller(requests);
  await assertOwnerMayGrant(args.ownerUserId, requests);
  const agentUserId = args.actorAgentUserId ?? getActingAgentUserId() ?? null;
  const proposal = await createPendingProposal({
    userId: args.ownerUserId,
    workspaceId: null,
    targetType: "app",
    targetId: found.app.id,
    proposalType: "connect",
    data: {
      appId: found.app.id,
      publicId: found.app.publicId,
      name: found.app.name,
      // Each with its explicit place (`scope`, access model B).
      requests: requests.map(withAppRequestScope),
      // Frozen at filing: what an approval may narrow, never widen.
      asked: requests.map(({ permission, workspaceId }) => ({
        permission,
        workspaceId,
      })),
    },
    agentUserId,
    createdBy: agentUserId ?? args.ownerUserId,
    proposedByUserId: agentUserId ? null : args.ownerUserId,
    notificationDescription: `${found.app.name} is asking for access`,
  });
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.requested, {
    proposalId: proposal.id,
    requests,
    ...(agentUserId ? { requestedByAgentUserId: agentUserId } : {}),
  });
  return { proposalId: proposal.id, reviewUrl: openLink(proposal.id) };
}

const touchesAsked = (fields: unknown): boolean => {
  if (!fields || typeof fields !== "object") return false;
  const f = fields as Record<string, unknown>;
  const nested = f.data as Record<string, unknown> | null | undefined;
  return (
    Object.hasOwn(f, "asked") ||
    (!!nested && typeof nested === "object" && Object.hasOwn(nested, "asked"))
  );
};

/** An approval in either form: the old pairs, or a v2 access (W2). */
export type AppApprovalForm = readonly AppApprovedRequest[] | AppAccess;

const isAccessForm = (form: AppApprovalForm): form is AppAccess =>
  !Array.isArray(form);

/** The v2 form of an approval: itself, or the lossless lift of its pairs. */
function accessOfForm(form: AppApprovalForm): AppAccess | null {
  if (isAccessForm(form)) return form;
  const lifted = liftApprovedRequests(form, { examples: false });
  return "access" in lifted ? lifted.access : null;
}

/**
 * approved ⊆ asked for an APP, place by place. An app's ask with no space is a
 * pod-wide read (decision e1b59d38 "B"): it covers that same pod-wide read and
 * never the read in one space, so a forged consent cannot turn "read decisions
 * everywhere" into "member of FINANCE". An AI's ask with no space does cover
 * any space (`requestsWithin`, agent-connect).
 *
 * Two sets of pairs are compared as pairs (`pairRequestsWithin`), the rule
 * every approval was checked by before W2. With a v2 form on either side
 * (W2), approved is within asked when v2 against v2 says so place by place
 * (`appAccessWithin`, the pairs side lifted by `liftApprovedRequests`), or
 * when every pair of approved (a v2 form expanded) is within asked's pairs
 * at its own place, as the pair rule reads them. Both answers are sound, so
 * either suffices; a pair no app may hold is within nothing.
 *
 * Why pairs stay pairs: the lift compares by MEANING (W3c), so the v2 form
 * of an ask may hold a space read through its pod-wide read
 * (`entity.note.read` pod-wide and in A, where the app also writes, lifts to
 * reads in All spaces). Read back as v2 that ask no longer names
 * `entity.note.read` in A, and an approval of exactly that pair would be
 * refused although it was asked. The pair rule never loses it.
 */
export function appRequestsWithin(
  approved: AppApprovalForm,
  asked: AppApprovalForm
): boolean {
  if (!isAccessForm(approved) && !isAccessForm(asked))
    return pairRequestsWithin(approved, asked);
  if (!isAccessForm(approved) && pairsOfRequests(approved).unplaceable.length)
    return false;
  const a = accessOfForm(approved);
  const b = accessOfForm(asked);
  if (a && b && appAccessWithin(a, b)) return true;
  const pairs = (form: AppApprovalForm) =>
    isAccessForm(form) ? expandAppAccess(form) : pairsOfRequests(form).pairs;
  return pairsWithin(pairs(approved), pairs(asked));
}

/** The pair comparison (each approved pair within the asked ones at its space). */
function pairRequestsWithin(
  approved: readonly AppApprovedRequest[],
  asked: readonly AppApprovedRequest[]
): boolean {
  return approved.every((a) =>
    permissionWithin(
      a.permission,
      asked
        .filter((b) => b.workspaceId === a.workspaceId)
        .map((b) => b.permission)
    )
  );
}

/**
 * Is an `app/connect` approval within what the app ASKED for? `asked` is the
 * copy frozen at filing; the approved `requests` may have been narrowed by a
 * revise, never widened (`appRequestsWithin`).
 *
 * `asked` cannot be trusted once a revise has touched it — false. A request
 * filed before `asked` existed and never revised still holds what was filed.
 */
export function appApprovalWithinAsked(args: {
  data: unknown;
  revisionHistory: ReadonlyArray<{ patch?: unknown }> | null | undefined;
  approved: readonly AppApprovedRequest[];
}): boolean {
  const outer = (args.data ?? {}) as Record<string, unknown>;
  const inner = (outer.data ?? outer) as Record<string, unknown>;
  const history = args.revisionHistory ?? [];
  if (history.some((r) => touchesAsked(r.patch))) return false;
  if (inner.asked === undefined) return history.length === 0;
  const asked = readAppConnectRequests({ requests: inner.asked });
  return appRequestsWithin(args.approved, asked);
}

/**
 * The grants an app's key carries for what its owner approved (pairs: an
 * app's `approved_requests`, or a person's sign-in reach).
 *
 * The pairs are read as their v2 access when they lift
 * (`liftApprovedRequests`, W2): at most four scopes — reads in the read
 * spaces, reads in the read projects, writes in the write spaces, writes in
 * the write projects (`grantScopesForAccess`). A lift is lossless, so these
 * scopes give the app exactly the reach the per-space grants below give: the
 * same permits and the same spaces, as viewer or editor (types
 * `grants/app-access.test.ts` compares both on every subset of four pair
 * universes, subsumption included; `app-access-v2.pglite.test.ts` on
 * fixtures). Pairs that do not lift (a re-consent) keep the per-space grants.
 *
 * Never one grant of (all permissions × all workspaces): approving "create
 * People in Sales" and "read Notes in Finance" would then also allow creating
 * People in Finance — a reach nobody approved. Both forms keep each pair
 * bounded to its own place.
 */
export function grantsForApprovedRequests(
  approved: readonly AppApprovedRequest[]
): GrantInput[] {
  const lifted = liftApprovedRequests(approved, { examples: false });
  return "access" in lifted
    ? grantScopesForAccess(lifted.access)
    : grantsForPairs(approved);
}

/** An app's approval as stored, read once (W3d). */
export interface AppApproval {
  /**
   * Its v2 access: the stored `approved_access` when valid (the AUTHORITY
   * since W3d), else the lossless lift of its pairs, else null (the pairs
   * cannot become v2 as they are: it re-consents and keeps its pairs, Q3).
   */
  access: AppAccess | null;
  /** The stored pairs (derived from v2 since W3d; the only form before). */
  pairs: AppApprovedRequest[];
  /** Was anything approved at all (`approved_requests` is not null)? */
  approved: boolean;
}

/**
 * The ONE read of an app's approval (W3d). `approved_requests IS NULL` is no
 * approval at all (never approved, or revived after a revoke): nothing, even
 * beside a stored v2. Otherwise the stored v2 WINS (the consent writes it
 * first and derives the pairs, `AppRepository.setApprovedAccess`); a row
 * written before W3d with no valid v2 reads as the lift of its pairs.
 */
export function appApprovalOf(
  app: {
    approvedRequests: readonly AppApprovedRequest[] | null;
    approvedAccess?: unknown;
  },
  options: {
    /**
     * false: a row with no stored v2 reads `access: null` (its pairs) without
     * lifting them. For the per-request path (`appSignInGrant`): a lift is
     * lossless, so the pairs give the same reach, and a lift per request
     * would cost up to `LIFT_PROBE_BUDGET` evaluations.
     */
    lift?: boolean;
  } = {}
): AppApproval {
  if (app.approvedRequests === null || app.approvedRequests === undefined)
    return { access: null, pairs: [], approved: false };
  const pairs = [...app.approvedRequests];
  const stored = parseAppAccess(app.approvedAccess ?? null);
  if (stored) return { access: stored, pairs, approved: true };
  if (options.lift === false) return { access: null, pairs, approved: true };
  const lifted = liftApprovedRequests(pairs, { examples: false });
  return {
    access: "access" in lifted ? lifted.access : null,
    pairs,
    approved: true,
  };
}

/** Does this approval give the app anything (v2, else its pairs)? */
export function approvalGivesAnything(approval: AppApproval): boolean {
  if (!approval.approved) return false;
  return approval.access
    ? appAccessGivesAnything(approval.access)
    : approval.pairs.length > 0;
}

/**
 * The grants for an app's approval as STORED (W3d: the stored v2 is the
 * AUTHORITY, `appApprovalOf`). Its v2 access minted per tier and kind of
 * place (`grantScopesForAccess`; "all" projects as `allProjects`, the
 * projects resolved at this mint), else the per-space grants of its pairs (a
 * re-consent row keeps today's behaviour until W5, Q3). No approval (null
 * pairs): nothing, whatever v2 was left beside it.
 *
 * Before W3d a stored v2 that no longer said what the pairs said lost to the
 * pairs (it could only be a stale derivation). Now v2 is written first and
 * the pairs derived from it, so v2 wins.
 */
export function grantsForApp(
  app: {
    approvedRequests: readonly AppApprovedRequest[] | null;
    approvedAccess?: unknown;
  },
  options: { allProjects?: readonly string[] } = {}
): GrantInput[] {
  const approval = appApprovalOf(app);
  if (!approval.approved) return [];
  if (approval.access) return grantScopesForAccess(approval.access, options);
  return grantsForPairs(approval.pairs);
}

/**
 * The per-space grants of a set of pairs: ONE grant per workspace, holding
 * exactly the permissions approved IN that workspace, plus ONE grant with no
 * workspace for the pod-wide reads, if any. What every app got before W2,
 * and what pairs that do not lift still get. The key may act where ANY one
 * grant permits (`KeyGrant`), so each pair stays bounded to its own workspace.
 */
export function grantsForPairs(
  approved: readonly AppApprovedRequest[]
): GrantInput[] {
  const byWorkspace = new Map<string, Set<string>>();
  const podWide = new Set<string>();
  for (const r of approved) {
    let place: Place;
    try {
      place = parseRequestPlace(r, "app");
    } catch (err) {
      if (err instanceof PlaceError) continue; // no place: never a grant
      throw err;
    }
    switch (place.kind) {
      case "spaces": {
        const perms = byWorkspace.get(place.ids[0]) ?? new Set<string>();
        perms.add(r.permission);
        byWorkspace.set(place.ids[0], perms);
        break;
      }
      case "pod":
        podWide.add(r.permission);
        break;
      case "unbounded":
        // A write with no space: an app never holds one (dropped).
        break;
      case "projects":
        // A pair names no project: an app's projects are its v2 access.
        break;
      default:
        assertNeverPlace(place);
    }
  }
  const grants: GrantInput[] = [...byWorkspace].map(([workspaceId, perms]) => ({
    permissions: [...perms],
    workspaceIds: [workspaceId],
  }));
  // ONE unpinned scope holding exactly the pod-wide reads (decision
  // e1b59d38 "B"): it reads those kinds everywhere the person reads, and
  // writes nothing, so no write is ever checked against it.
  if (podWide.size > 0) {
    grants.push({ permissions: [...podWide] });
  }
  return grants;
}

/** Which door issued an app's key — the provenance its agent user records. */
export type AppKeyDoor = "cli" | "ui";

/**
 * The app's OWN agent user, created on first need: one per app (agent type =
 * the app's `public_id`, so the (creator × type) singleton is per app), with
 * the `ask-first` posture applied BEFORE the app is linked to it — an app is
 * never linked to an agent that could auto-approve a write.
 */
export async function ensureAppAgent(
  found: AppWithGrants,
  via: AppKeyDoor
): Promise<string> {
  if (found.app.agentUserId) return found.app.agentUserId;
  const { agentUserId } = await findOrCreateServiceAgentUser({
    creatorId: found.app.ownerUserId,
    agentType: found.app.publicId,
    label: found.app.name,
    metadata: {
      description: `${found.app.name} — connected app (${found.app.publicId})`,
    },
    createdVia: via,
  });
  await applyAgentPosture({
    db,
    agentUserId,
    posture: "ask-first",
    createdBy: found.app.ownerUserId,
  });
  return new AppRepository(db).linkAgentUser(found.app.id, agentUserId);
}

/**
 * The app agent's workspace memberships = EXACTLY the workspaces its owner
 * approved (the RBAC floor every agent write is checked against —
 * `verifyPermission` on the acting agent). The approval of `app/connect` is
 * the consent; the grant still bounds which permissions apply in each.
 * `viewer` where everything approved there is a read, else `editor`. A
 * workspace no longer approved loses the membership; `[]` removes them all
 * (revoke).
 */
async function syncAppAgentMemberships(
  agentUserId: string,
  ownerUserId: string,
  grants: readonly GrantInput[]
): Promise<void> {
  // The spaces its grants NAME (W3d: read from the minted scopes, so a v2
  // access and the pairs agree): `viewer` where it only reads, `editor`
  // where it writes. A pod-wide read names no space and a project scope is
  // no space's membership: the grant alone carries them.
  const roles = new Map<string, "viewer" | "editor">();
  for (const g of grants) {
    if (g.projectIds?.length || g.entityIds?.length) continue;
    const reads = g.permissions.every(
      (p) => parsePermission(p).at(-1) === "read"
    );
    for (const workspaceId of g.workspaceIds ?? []) {
      const prior = roles.get(workspaceId);
      roles.set(workspaceId, prior === "editor" || !reads ? "editor" : "viewer");
    }
  }
  const current = await db
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, agentUserId));
  const stale = current.filter((m) => !roles.has(m.workspaceId));
  if (stale.length > 0) {
    await db.delete(workspaceMembers).where(
      inArray(
        workspaceMembers.id,
        stale.map((m) => m.id)
      )
    );
  }
  for (const [workspaceId, role] of roles) {
    const held = current.find((m) => m.workspaceId === workspaceId);
    if (held) {
      if (held.role !== role) {
        await db
          .update(workspaceMembers)
          .set({ role })
          .where(eq(workspaceMembers.id, held.id));
      }
      continue;
    }
    await db
      .insert(workspaceMembers)
      .values({
        workspaceId,
        userId: agentUserId,
        role,
        invitedBy: ownerUserId,
      })
      .onConflictDoNothing();
  }
}

/**
 * Make the app's reach EQUAL what its owner approved: the agent's workspace
 * memberships (the RBAC floor) and each given key's grants (one per approved
 * workspace), both derived from `approved`. The ONE derivation behind
 * `issueKey`, `adoptLegacyAppKey` and a re-approval (`applyApprovedReach`).
 * Idempotent: the memberships converge and `attachMany` replaces a key's
 * active grant set, so a re-run with the same approval changes nothing.
 */
async function setApprovedReach(args: {
  app: {
    publicId: string;
    ownerUserId: string;
    approvedRequests: readonly AppApprovedRequest[] | null;
    /** The approval's v2 form (`apps.approved_access`): the authority (W3d). */
    approvedAccess?: unknown;
  };
  agentUserId: string;
  apiKeyIds: readonly string[];
}): Promise<void> {
  const owner = args.app.ownerUserId;
  const grants = grantsForApp(args.app, {
    allProjects: await allProjectsFor(owner, args.app),
  });
  await syncAppAgentMemberships(args.agentUserId, owner, grants);
  for (const apiKeyId of args.apiKeyIds) {
    await attachGrantsOrRevoke({
      apiKeyId,
      principalUserId: args.agentUserId,
      onBehalfOf: owner,
      grants,
      expiresAt: null,
      createdBy: owner,
      clientId: args.app.publicId,
    });
  }
}

/**
 * After an approval: approval is the truth, so the LIVE key(s) and the app's
 * agent are re-derived from the app's new `approved_requests` — narrowing it
 * narrows the key at once, widening it reaches the key without a re-issue.
 * Only keys the app's agent HOLDS are touched; a pre-0313 key still held by
 * the human is re-derived when it is adopted (`adoptLegacyAppKey` reads the
 * approval then). No agent, no live key, nothing approved, or a revoked app ⇒
 * nothing to do. Returns how many keys were re-granted.
 */
export async function applyApprovedReach(appId: string): Promise<number> {
  const app = await new AppRepository(db).get(appId);
  if (app && !app.revokedAt) await narrowAppPersonTokens(app);
  if (
    !app?.agentUserId ||
    app.revokedAt ||
    !approvalGivesAnything(appApprovalOf(app))
  )
    return 0;
  const live = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.userId, app.agentUserId), eq(apiKeys.isActive, true))
    );
  if (live.length === 0) return 0;
  await setApprovedReach({
    app,
    agentUserId: app.agentUserId,
    apiKeyIds: live.map((k) => k.id),
  });
  return live.length;
}

/**
 * "Sign in with Synap": the people signed in to this app hold tokens whose
 * grant was what they CONSENTED to ∩ the approval at the time. A new approval
 * may only NARROW them — never widen past what each person saw — so each live
 * token keeps what it holds that the reach rule still allows NOW
 * (`appSignInGrant`: the new approval ∩ what the owner can give ∩ the
 * person's reach), compared BY MEANING (W3d, review finding 4 of #1196:
 * `scopesWithinBound`, never literal (permission, space) keys, so a read
 * held through a wider pattern is not lost, and a project scope is kept when
 * the reach still holds it). One with nothing left is revoked. Tokens are
 * found by their instance (`oauth:<client_id>:<person>`, the client_id being
 * the public id, or a Synap pod app connection's CIMD URL), which only the
 * app-person-token door writes with this key type.
 */
async function narrowAppPersonTokens(app: {
  publicId: string;
  ownerUserId: string;
  mode: string;
  oauthClientId: string | null;
  approvedRequests: readonly AppApprovedRequest[] | null;
  approvedAccess?: unknown;
}): Promise<void> {
  const clientId =
    app.mode === "oauth" && app.oauthClientId
      ? app.oauthClientId
      : app.publicId;
  const tokens = await db
    .select({
      id: apiKeys.id,
      userId: apiKeys.userId,
      instanceId: apiKeys.instanceId,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyType, APP_PERSON_KEY_TYPE),
        eq(apiKeys.isActive, true),
        drizzleSql`starts_with(${apiKeys.instanceId}, ${oauthClientInstancePrefix(clientId)})`
      )
    );
  if (tokens.length === 0) return;
  const { appSignInGrant, narrowKeyGrant } =
    await import("../routers/oauth/app-client.js");
  for (const token of tokens) {
    if (parseOauthKeyInstanceId(token.instanceId)?.clientId !== clientId)
      continue;
    const live = await liveGrantsOfKey(token.id);
    const reach = await appSignInGrant(app, token.userId);
    const kept =
      reach === "not_for_you"
        ? []
        : narrowKeyGrant(
            { clientId: app.publicId, scopes: live },
            reach
          ).scopes.filter((s) => s.permissions.length > 0);
    const keys = (xs: ReadonlyArray<{ permissions: readonly string[] }>) =>
      xs
        .map((x) => JSON.stringify(scopeShape(x)))
        .sort()
        .join("\n");
    if (kept.length === live.length && keys(kept) === keys(live)) continue;
    if (kept.length === 0) {
      await new GrantRepository(db).revokeForKeys([token.id], app.ownerUserId);
      await revokeApiKeys(db, {
        where: eq(apiKeys.id, token.id),
        revokedBy: app.ownerUserId,
        reason: "The app's approval no longer covers this sign-in",
      });
      continue;
    }
    const endsAt = live[0]?.expiresAt ?? null;
    await attachGrantsOrRevoke({
      apiKeyId: token.id,
      principalUserId: token.userId,
      onBehalfOf: token.userId,
      grants: kept.map(scopeShape),
      expiresAt: endsAt,
      createdBy: app.ownerUserId,
      clientId: app.publicId,
    });
  }
}

/** A scope as the grant door takes it (no nulls, ids sorted). */
function scopeShape(scope: {
  permissions: readonly string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
}): GrantInput {
  return {
    permissions: [...scope.permissions].sort(),
    ...(scope.workspaceIds?.length
      ? { workspaceIds: [...scope.workspaceIds].sort() }
      : {}),
    ...(scope.projectIds?.length
      ? { projectIds: [...scope.projectIds].sort() }
      : {}),
  };
}

/** What a person may give an app, read now (W3d): their floor per tier. */
export interface AccessFloor {
  /** Spaces they read in (`getUserWorkspaceIds`). */
  readSpaces: string[];
  /** Of the asked write spaces, those they may write in. */
  writeSpaces: string[];
  /** Projects they see (`oauthAppProjectOffer.readable`); [] unless asked. */
  readProjects: string[];
  /** Projects they may write in (`oauthAppProjectOffer.writable`); [] unless asked. */
  writeProjects: string[];
}

/**
 * A person's floor for an app's reach, read NOW (an approval outlives a
 * role, PR #29 H1/L1): the spaces they read, which of `writeSpaces` they may
 * still write in, and (only when `projects`, a read the token needs only
 * when the access names projects) the projects they see and write in.
 */
export async function ownerAccessFloor(
  userId: string,
  options: { projects: boolean; writeSpaces: readonly string[] }
): Promise<AccessFloor> {
  const [readSpaces, writeSpaces, projectOffer] = await Promise.all([
    getUserWorkspaceIds(userId),
    spacesOwnerMayWriteIn(userId, options.writeSpaces),
    options.projects ? oauthAppProjectOffer(userId) : null,
  ]);
  return {
    readSpaces,
    writeSpaces: options.writeSpaces.filter((id) => writeSpaces.has(id)),
    readProjects: projectOffer?.readable.map((p) => p.projectId) ?? [],
    writeProjects: projectOffer?.writable.map((p) => p.projectId) ?? [],
  };
}

/**
 * What "all" projects means for an app key minted now (W3d, a live pin): the
 * projects its owner sees, read only when the access asks for them.
 */
async function allProjectsFor(
  ownerUserId: string,
  app: {
    approvedRequests: readonly AppApprovedRequest[] | null;
    approvedAccess?: unknown;
  }
): Promise<string[]> {
  const access = appApprovalOf(app).access;
  if (!access || access.read.spaces === "all" || access.read.projects !== "all")
    return [];
  return (await oauthAppProjectOffer(ownerUserId)).readable.map(
    (p) => p.projectId
  );
}

/**
 * A key minted before 0313 is held by the HUMAN (no agent, ungoverned). The
 * first time it authenticates it moves onto the app's agent — same plaintext,
 * so the app keeps working — and its grants are RE-DERIVED from what the owner
 * approved (`grantsForApprovedRequests`, one scope per workspace), replacing
 * the single (all permissions × all workspaces) grant it was minted with.
 * Returns the agent; `null` when the key is not an adoptable app key (not this
 * owner's, app gone or revoked, nothing approved) — the caller refuses it.
 * Idempotent: once the key is held by the agent a re-run (a cached key record)
 * only returns the agent.
 */
export async function adoptLegacyAppKey(args: {
  apiKeyId: string;
  keyOwnerUserId: string;
  publicId: string;
}): Promise<string | null> {
  const repo = new AppRepository(db);
  const found = await repo.getByPublicId(args.publicId);
  if (
    !found ||
    found.app.ownerUserId !== args.keyOwnerUserId ||
    found.app.revokedAt ||
    !approvalGivesAnything(appApprovalOf(found.app))
  ) {
    return null;
  }
  const keyIds = await repo.keyIdsFor(found.app.publicId);
  if (!keyIds.includes(args.apiKeyId)) return null;
  const [key] = await db
    .select({ userId: apiKeys.userId, keyType: apiKeys.keyType })
    .from(apiKeys)
    .where(eq(apiKeys.id, args.apiKeyId))
    .limit(1);
  // A person's own sign-in token is never moved onto the app's agent.
  if (key?.keyType === APP_PERSON_KEY_TYPE) return null;
  const agentUserId = await ensureAppAgent(found, "cli");
  if (key?.userId === agentUserId) return agentUserId;
  if (key?.userId !== found.app.ownerUserId) return null;
  // Grants first, then the key: a crash in between leaves a human-held key
  // that the next request adopts again.
  await setApprovedReach({
    app: found.app,
    agentUserId,
    apiKeyIds: [args.apiKeyId],
  });
  await repo.adoptKey({
    apiKeyId: args.apiKeyId,
    ownerUserId: found.app.ownerUserId,
    agentUserId,
  });
  return agentUserId;
}

/**
 * Boot pass: adopt every pre-0313 app key now, instead of waiting for the
 * app's first call. Until a key is adopted its app has no agent, so its owner
 * cannot set the agent's write mode ("apply automatically") before the first
 * write lands as a proposal. Same door as the lazy path (`adoptLegacyAppKey`),
 * so a key it cannot adopt stays human-held and is refused on use. Idempotent:
 * an app with an agent is skipped. Returns how many keys moved.
 */
export async function adoptLegacyAppKeys(): Promise<number> {
  const legacy = await db
    .select({ publicId: apps.publicId, ownerUserId: apps.ownerUserId })
    .from(apps)
    .where(
      and(
        isNull(apps.agentUserId),
        isNull(apps.revokedAt),
        isNull(apps.removedAt)
      )
    );
  const repo = new AppRepository(db);
  let adopted = 0;
  for (const app of legacy) {
    const keyIds = await repo.keyIdsFor(app.publicId);
    if (keyIds.length === 0) continue;
    const live = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          inArray(apiKeys.id, keyIds),
          eq(apiKeys.userId, app.ownerUserId),
          eq(apiKeys.isActive, true),
          // The owner's own sign-in token is theirs, not a legacy app key.
          ne(apiKeys.keyType, APP_PERSON_KEY_TYPE)
        )
      );
    for (const key of live) {
      const agentUserId = await adoptLegacyAppKey({
        apiKeyId: key.id,
        keyOwnerUserId: app.ownerUserId,
        publicId: app.publicId,
      });
      if (agentUserId) adopted++;
    }
  }
  return adopted;
}

/**
 * Revoke an app's keys AND their grants (the ONE grant write door).
 * `keepSignIns` spares the people's own sign-in tokens — a ROTATION of the
 * app's key must not sign every person out; revoking the app ends them too.
 */
async function revokeAppKeys(
  found: AppWithGrants,
  actorUserId: string,
  reason: string,
  opts: { keepSignIns?: boolean } = {}
): Promise<number> {
  let keyIds = await new AppRepository(db).keyIdsFor(found.app.publicId);
  if (opts.keepSignIns && keyIds.length > 0) {
    const signIns = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          inArray(apiKeys.id, keyIds),
          eq(apiKeys.keyType, APP_PERSON_KEY_TYPE)
        )
      );
    const spared = new Set(signIns.map((k) => k.id));
    keyIds = keyIds.filter((id) => !spared.has(id));
  }
  if (keyIds.length === 0) return 0;
  await new GrantRepository(db).revokeForKeys(keyIds, actorUserId);
  await revokeApiKeys(db, {
    where: inArray(apiKeys.id, keyIds),
    revokedBy: actorUserId,
    reason,
  });
  return keyIds.length;
}

/**
 * Issue the app's key AFTER approval: rotate away any key it had (keys AND
 * grants), mint a fresh key, attach one grant per approved workspace. The
 * plaintext is returned ONCE and never stored or logged.
 *
 * Who may: the app's OWNER, with a credential that is neither an agent's
 * (`actorAgentUserId`) nor grant-bound (an app key must never mint keys —
 * that would let a bounded credential re-issue itself). The CLI path works
 * because `synap login` / `pods add` keys come from
 * `apiKeys.connectIntegration`: owned by the human, no agent principal, no
 * grant.
 *
 * The key is minted to the app's OWN agent (`ensureAppAgent`) and linked to
 * the owner, so its writes are governed like an agent's.
 */
export async function issueKey(args: {
  publicId: string;
  ownerUserId: string;
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
  /** The door issuing it (the agent's provenance on first issue). */
  via: AppKeyDoor;
  /** The gate's pass for `apps.issueKey` (`passPresenceForAction`). */
  presence: PresencePass | null;
}): Promise<{ apiKey: string; keyId: string }> {
  assertPresencePass(args.presence, {
    actions: ["apps.issueKey"],
    userId: args.ownerUserId,
  });
  assertOwnerCredential("mint an app key", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  if (!approvalGivesAnything(appApprovalOf(found.app))) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This app has no approved requests yet — connect it and approve the request first.",
    });
  }
  const userId = args.ownerUserId;
  const agentUserId = await ensureAppAgent(found, args.via);
  const rotated = await revokeAppKeys(
    found,
    userId,
    `Rotated by a new app key for ${found.app.name}`,
    { keepSignIns: true }
  );

  const plaintext = `${KEY_PREFIXES.USER}${randomBytes(32).toString("hex")}`;
  const apiKeyRepo = new ApiKeyRepository(db, new EventRepository(sql));
  const keyRow = await apiKeyRepo.create(
    {
      keyName: `${found.app.name} (app)`,
      keyPrefix: KEY_PREFIXES.USER,
      key: plaintext,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      // Apps are long-lived; the grant is the bound, not the clock.
      // Held by the app's agent, acting for its owner — an agent key's shape.
      userId: agentUserId,
      linkedUserId: userId,
      keyType: "user_pat",
      description: `App key for ${found.app.name} (${found.app.publicId})`,
    },
    userId
  );
  await setApprovedReach({
    app: found.app,
    agentUserId,
    apiKeyIds: [keyRow.id],
  });
  await recordAppEvent(found, userId, APP_EVENT_ACTIONS.keyIssued, {
    keyId: keyRow.id,
    replacedKeys: rotated,
  });
  return { apiKey: plaintext, keyId: keyRow.id };
}

// ─── Pod apps (OAuth, spec 17 PB2) ───────────────────────────────────────────
//
// A pod app is an OAuth client of this pod identified by its metadata document
// URL (CIMD). A person's consent at the pod's OAuth door makes an `apps` row
// with mode 'oauth' for (person, app) and approves its reach through the SAME
// `app/connect` proposal + executor as App Connect; /token then mints a
// short-lived key for that app's own agent. Everything below reuses the App
// Connect pieces above; only the filing/approving door and the key's shape
// (1 h, hub_inbound, one per connection) are new.

/** An access token a pod app gets at /token lives this long (F5). */
export const APP_OAUTH_ACCESS_TTL_SECONDS = 60 * 60;

/**
 * GC of a connection's dead keys (spec 17 risk R3): every refresh mints a new
 * key, ~24 a day per connection. Each mint deletes the connection's revoked
 * keys beyond the newest `APP_OAUTH_DEAD_KEYS_KEPT` (their grants cascade),
 * at most `APP_OAUTH_KEY_SWEEP_BATCH` per mint, so a connection holds one
 * live key and at most this many dead ones once swept.
 */
export const APP_OAUTH_DEAD_KEYS_KEPT = 2;
const APP_OAUTH_KEY_SWEEP_BATCH = 100;

/** One `synap_requests` entry that listed its kinds (F4), as declared. */
export type OAuthAppKindGroup = RequestedKindGroup;

/** A project the consenting person may give an app a permission in. */
export interface OAuthAppOfferProject {
  projectId: string;
  projectName: string;
  /** Its home space, or null for a project that lives in no space. */
  workspaceId: string | null;
}

/** One permission a pod app asks for, and the spaces it may be given in. */
export interface OAuthAppOfferItem {
  permission: string;
  workspaces: Array<{
    workspaceId: string;
    workspaceName: string;
    /**
     * The template the space was made from (`workspaces.package_slug`), or
     * null. The consent screen starts with the spaces whose template the app
     * declared (`synap_templates`); it never changes what is offered.
     */
    templateSlug: string | null;
  }>;
  /**
   * With `kindGroups` (the consent screen): the entry this permission was
   * declared in when that entry listed its kinds (F4: `{permission:
   * "entity.read", kinds}`), else null. Items that share one draw as ONE row
   * ("Records: N kinds"). Display only: the permission is still given and
   * checked per kind (D4).
   */
  kindGroup?: OAuthAppKindGroup | null;
  /**
   * With `projects` (the consent screen, app permissions W3c): the projects
   * the person may give this permission in, by name — every project they can
   * see for a read, only those they may write in for anything else
   * (`oauthAppProjectOffer`). Offered only: no consent mints a project grant
   * yet.
   */
  projects?: OAuthAppOfferProject[];
}

/** What else the consent screen's offer carries (each additive). */
export interface OAuthAppOfferOptions {
  /**
   * The cached document's kinds grouping (`requestedKindGroups`, F4). Read
   * defensively (`kindGroupIndex`): a malformed row names no group.
   */
  kindGroups?: readonly unknown[];
  /** Offer projects beside the spaces (W3c). */
  projects?: boolean;
}

/**
 * Each permission a cached kinds grouping (`requestedKindGroups`, F4)
 * declares, to the entry it was declared in. Built once per offer. Each
 * group is expanded again (`permissionsForKinds`) rather than trusted, so a
 * group can only ever name the permissions it expands to. A malformed group
 * (not an object, no permission string, kinds that are not a list of kind
 * slugs, a kind-specific or non-record permission) names NONE: its kinds
 * then show one row each, never a failed consent. The first group that
 * declares a permission keeps it.
 */
export function kindGroupIndex(
  groups: readonly unknown[] | null | undefined
): ReadonlyMap<string, OAuthAppKindGroup> {
  const out = new Map<string, OAuthAppKindGroup>();
  for (const raw of Array.isArray(groups) ? groups : []) {
    if (!raw || typeof raw !== "object") continue;
    const { permission, kinds } = raw as Record<string, unknown>;
    if (typeof permission !== "string" || !Array.isArray(kinds)) continue;
    let expanded: string[];
    try {
      expanded = permissionsForKinds(permission, kinds);
    } catch {
      // KindsRequestError, or anything a malformed row throws: no group.
      continue;
    }
    const group = { permission, kinds: kinds as string[] };
    for (const p of expanded) if (!out.has(p)) out.set(p, group);
  }
  return out;
}

/**
 * The entry a permission was declared in, when that entry listed its kinds
 * (F4), or null (`kindGroupIndex`, for one permission).
 */
export function kindGroupOf(
  permission: string,
  groups: readonly unknown[] | null | undefined
): OAuthAppKindGroup | null {
  return kindGroupIndex(groups).get(permission) ?? null;
}

/**
 * The projects a person may give an app a permission in (app permissions
 * W3c; offered only, nothing mints a project grant yet):
 *  - `readable`: every project they can SEE (`projectVisibleWhere`, THE
 *    project visibility predicate: a member of its home space, the owner of a
 *    project in no space, or a member of the project), except an archived
 *    project or one whose home space is archived (nothing works there);
 *  - `writable`: of those, the projects whose home space they may WRITE in
 *    (`spacesOwnerMayWriteIn`, the rule the space offer and
 *    `assertOwnerMayGrant` use), and the projects in no space they OWN (the
 *    owner floor such a project's writes gate on). A project role alone
 *    (`project_members`) gives no write here: a project's own writes are
 *    gated on its home space.
 * Sorted by name.
 */
export async function oauthAppProjectOffer(ownerUserId: string): Promise<{
  readable: OAuthAppOfferProject[];
  writable: OAuthAppOfferProject[];
}> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      workspaceId: projects.workspaceId,
      userId: projects.userId,
    })
    .from(projects)
    .leftJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        projectVisibleWhere(AccessContext.operator({ userId: ownerUserId })),
        ne(projects.status, "archived"),
        isNull(workspaces.archivedAt)
      )
    );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const homes = [
    ...new Set(rows.flatMap((r) => (r.workspaceId ? [r.workspaceId] : []))),
  ];
  const mayWrite = await spacesOwnerMayWriteIn(ownerUserId, homes);
  const offer = (r: (typeof rows)[number]): OAuthAppOfferProject => ({
    projectId: r.id,
    projectName: r.name,
    workspaceId: r.workspaceId ?? null,
  });
  return {
    readable: rows.map(offer),
    writable: rows
      .filter((r) =>
        r.workspaceId ? mayWrite.has(r.workspaceId) : r.userId === ownerUserId
      )
      .map(offer),
  };
}

/**
 * What the consent screen may offer a pod app: for each permission it asks,
 * the spaces the consenting person may give it in — every space they can READ
 * for a read, only the spaces they may WRITE in (`spacesOwnerMayWriteIn`, the
 * rule `assertOwnerMayGrant` enforces) for anything else. The person ticks a
 * subset; the offer is what that subset is checked against.
 *
 * The consent screen also asks (`options`, each additive, W3c): each item's
 * kinds group (F4), and the projects it may be given in, by the same read /
 * write rule (`oauthAppProjectOffer`). Without options the items are exactly
 * as before.
 */
export async function oauthAppOffer(
  ownerUserId: string,
  permissions: readonly string[],
  options: OAuthAppOfferOptions = {}
): Promise<OAuthAppOfferItem[]> {
  const readable = await getUserWorkspaceIds(ownerUserId);
  const rows =
    readable.length > 0
      ? await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            templateSlug: workspaces.packageSlug,
          })
          .from(workspaces)
          // An archived space is not offered: nothing works in it.
          .where(
            and(inArray(workspaces.id, readable), isNull(workspaces.archivedAt))
          )
      : [];
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const writable = permissions.some((p) => !isReadPermission(p))
    ? await spacesOwnerMayWriteIn(
        ownerUserId,
        rows.map((r) => r.id)
      )
    : new Set<string>();
  const projectOffer = options.projects
    ? await oauthAppProjectOffer(ownerUserId)
    : null;
  const kindGroups = options.kindGroups
    ? kindGroupIndex(options.kindGroups)
    : null;
  return permissions.map((permission) => ({
    permission,
    workspaces: rows
      .filter((r) => isReadPermission(permission) || writable.has(r.id))
      .map((r) => ({
        workspaceId: r.id,
        workspaceName: r.name,
        templateSlug: r.templateSlug ?? null,
      })),
    ...(kindGroups ? { kindGroup: kindGroups.get(permission) ?? null } : {}),
    ...(projectOffer
      ? {
          projects: isReadPermission(permission)
            ? projectOffer.readable
            : projectOffer.writable,
        }
      : {}),
  }));
}

/**
 * The permissions a pod app may be given POD-WIDE: those it asked for that
 * its document declared pod-wide (`requestedPodWide`) AND that are a read of
 * one named kind (`isPodWideReadPermission`, re-checked here whatever the
 * cache holds). Offered as one tick each, with no space; never also per space.
 */
export function oauthAppPodWideOffer(
  permissions: readonly string[],
  declaredPodWide: readonly string[]
): string[] {
  const declared = new Set(declaredPodWide);
  return permissions.filter(
    (p) => declared.has(p) && isPodWideReadPermission(p)
  );
}

/**
 * The kinds a pod app asks for (`entity.<kind>[.<action>]`) whose profile is
 * pod-wide: a system or shared profile with `entity_scope = 'pod'`. An entity
 * kept pod-wide (in no single space) reaches an app only through a role in a
 * space it was given, so the consent screen says so on that kind's row. A
 * kind with no such profile is not listed: the screen claims nothing for it.
 */
export async function oauthAppPodWideKinds(
  permissions: readonly string[]
): Promise<string[]> {
  const kinds: string[] = [];
  for (const permission of permissions) {
    const segs = parsePermission(permission);
    const kind = segs[0] === "entity" ? segs[1] : undefined;
    if (kind && kind !== "*" && !kinds.includes(kind)) kinds.push(kind);
  }
  if (kinds.length === 0) return [];
  const rows = await db
    .select({ slug: profiles.slug })
    .from(profiles)
    .where(
      and(
        inArray(profiles.slug, kinds),
        eq(profiles.entityScope, "pod"),
        isNull(profiles.workspaceId),
        eq(profiles.isActive, true)
      )
    );
  const podWide = new Set(rows.map((r) => r.slug));
  return kinds.filter((k) => podWide.has(k));
}

/**
 * The consent click (F9): ONE act that files the pod app's `app/connect`
 * proposal AND approves it as the consenting person, through the ONE approve
 * door (`applyProposalApproval` → the `app/connect` executor). The consent
 * screen IS the review card, so the executor's checks run verbatim: approved
 * within the frozen `asked`, approver = the app's owner, app not revoked, and
 * `assertOwnerMayGrant` read at approval time; the agent-approver floor
 * (`refuseAgentProposalApprover`) refuses an agent caller.
 *
 * `asked` is the pod's own offer (`oauthAppOffer` for the permissions the app
 * requested and declared), never the caller's: `approved` (the person's ticks,
 * untrusted wire input) may narrow it, never widen it. A widened `approved` is
 * refused here before anything is filed, and again by the executor.
 *
 * Not one database transaction: the executor and its reach derivation write
 * through the shared client. The order is what keeps a partial run harmless —
 * nothing here mints a credential, and the caller issues an authorization code
 * only after this returns. A failed approval leaves an approval-less row (no
 * reach) whose waiting proposal the next consent withdraws.
 *
 * Re-consent (same person, same app): the row is reused and the new approval
 * replaces the old one, narrowing (or widening, on this very screen) the live
 * key at once (`applyApprovedReach`).
 *
 * The SHORT consent (`ask`, the app's `synap_ask`, plan 647ebfd4 option C):
 * `asked` is only the pairs the app asked for that are on offer, and the
 * approval is filed with `mode: "add"`, so the executor MERGES them into what
 * the app already holds; nothing it held before is dropped. Only an
 * interrupted consent is withdrawn, never the app's own asks still waiting.
 */
export async function connectOAuthApp(args: {
  ownerUserId: string;
  /** The app's metadata-document URL (its OAuth `client_id`). */
  oauthClientId: string;
  /** Display name for a new row: "<client_name> (<host>)". */
  name: string;
  /** What the app asked for AND declared, re-derived server-side. */
  permissions: readonly string[];
  /**
   * Of those, the ones the app declared POD-WIDE (`synap_requests[].scope =
   * "pod"`, re-derived server-side): offered as one pair each with no space.
   */
  podWide?: readonly string[];
  /** The person's ticks — untrusted. */
  approved: readonly AppApprovedRequest[];
  /** The caller's request context — the approve door's agent floor reads it. */
  ctx: Context;
  /**
   * The consent door already checked the person's proof of presence for THIS
   * authorization (W3 slice 2, `oauth.consent`): the `app/connect` it files
   * and approves in the same call has no proposal a client could name first.
   */
  presenceChecked?: "oauth.consent";
  /**
   * The app's `synap_ask` pairs, resolved server-side within its ceiling
   * (`resolveAskPairs`): the short consent, whose approval ADDS.
   */
  ask?: readonly AppApprovedRequest[];
}): Promise<{ appId: string; publicId: string; proposalId: string }> {
  assertOwnerCredential("connect an app", {
    agentUserId: args.ctx.agentUserId,
    keyType: args.ctx.keyType,
  });
  const approved = dedupeRequests(args.approved);
  if (approved.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose at least one space to give this app access to.",
    });
  }
  const podWide = oauthAppPodWideOffer(args.permissions, args.podWide ?? []);
  const offer = await oauthAppOffer(
    args.ownerUserId,
    args.permissions.filter((p) => !podWide.includes(p))
  );
  const offered: AppApprovedRequest[] = [
    ...offer.flatMap((o) =>
      o.workspaces.map((w) => ({
        permission: o.permission,
        workspaceId: w.workspaceId,
      }))
    ),
    ...podWide.map((permission) => ({ permission, workspaceId: null })),
  ];
  const add = args.ask !== undefined;
  // The short consent: only what the app asked, of what is on offer.
  const asked = add
    ? offered.filter((o) =>
        args.ask!.some(
          (a) =>
            a.permission === o.permission && a.workspaceId === o.workspaceId
        )
      )
    : offered;
  const nameOf = new Map<string | null, string>([
    ...offer.flatMap((o) =>
      o.workspaces.map((w) => [w.workspaceId, w.workspaceName] as const)
    ),
    [null, EVERYWHERE_IN_POD],
  ]);
  assertPodWideReadsOnly(approved);
  if (!appRequestsWithin(approved, asked)) {
    const beyond = approved.filter((r) => !appRequestsWithin([r], asked));
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You can only give this app what it asked for, in spaces you may give it: ${beyond
        .map(
          (r) =>
            `${r.permission} in ${nameOf.get(r.workspaceId) ?? r.workspaceId}`
        )
        .join(", ")} is not on offer.`,
    });
  }
  await assertOwnerMayGrant(args.ownerUserId, approved);

  const repo = new AppRepository(db);
  const app = await repo.registerOAuth({
    ownerUserId: args.ownerUserId,
    oauthClientId: args.oauthClientId,
    name: args.name,
  });
  const requests = approved.map((r) => ({
    ...withAppRequestScope(r),
    workspaceName: nameOf.get(r.workspaceId) ?? null,
  }));
  // Filed inside a transaction so `createPendingProposal` skips its "is
  // asking for access" notification: the person is answering it right now,
  // on the consent screen, and it is approved in the next statement.
  const proposal = await db.transaction((tx) =>
    createPendingProposal(
      {
        userId: args.ownerUserId,
        workspaceId: null,
        targetType: "app",
        targetId: app.id,
        proposalType: "connect",
        data: {
          appId: app.id,
          publicId: app.publicId,
          name: app.name,
          oauthClientId: args.oauthClientId,
          via: "oauth-consent",
          ...(add ? { mode: "add" } : {}),
          requests,
          asked,
        },
        agentUserId: null,
        createdBy: args.ownerUserId,
        proposedByUserId: args.ownerUserId,
        notificationDescription: `${app.name} is asking for access`,
      },
      tx as never
    )
  );
  // A request left waiting by an interrupted consent is superseded by this
  // one: it ends as `superseded`, naming this request (its end line's door),
  // never with an English sentence stored as if its author wrote it.
  await repo.withdrawPendingRequests(
    app.id,
    args.ownerUserId,
    { reason: "superseded", supersededBy: proposal.id },
    add ? "oauth-consent" : undefined
  );
  await recordAppEvent(
    { app } as AppWithGrants,
    args.ownerUserId,
    APP_EVENT_ACTIONS.requested,
    { proposalId: proposal.id, requests, via: "oauth-consent" }
  );

  const [row] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposal.id))
    .limit(1);
  const { applyProposalApproval } =
    await import("../routers/proposals/apply-approval.js");
  const result = await applyProposalApproval({
    proposal: row as never,
    userId: args.ownerUserId,
    input: { proposalId: proposal.id },
    ctx: args.ctx,
    presenceChecked: args.presenceChecked,
  });
  if (!result.success) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The connection could not be approved.",
    });
  }
  // What the person consented to is THIS document: an app that is not a
  // Synap app acts as them only while its document is unchanged
  // (`consentedDocumentHolds`). The consent screen was rendered from the
  // cached document this authorization just validated.
  const { currentDocumentSha256 } =
    await import("../routers/oauth/app-client.js");
  const documentSha256 = await currentDocumentSha256(args.oauthClientId);
  if (documentSha256) await repo.setConsentedDocument(app.id, documentSha256);
  return { appId: app.id, publicId: app.publicId, proposalId: proposal.id };
}

/**
 * What this person approved for this pod app last time (its live connection's
 * `approved_requests`), or `[]`. The consent screen pre-ticks it.
 */
export async function currentOAuthApproval(
  ownerUserId: string,
  oauthClientId: string
): Promise<AppApprovedRequest[]> {
  const [row] = await db
    .select({ approvedRequests: apps.approvedRequests })
    .from(apps)
    .where(
      and(
        eq(apps.ownerUserId, ownerUserId),
        eq(apps.oauthClientId, oauthClientId),
        isNull(apps.revokedAt)
      )
    )
    .limit(1);
  return row?.approvedRequests ?? [];
}

function dedupeRequests(
  requests: readonly AppApprovedRequest[]
): AppApprovedRequest[] {
  const seen = new Set<string>();
  const out: AppApprovedRequest[] = [];
  for (const r of requests) {
    const key = `${r.permission}\u0000${r.workspaceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ permission: r.permission, workspaceId: r.workspaceId });
  }
  return out;
}

/** What /token hands back for a pod app (spec 17 §6.6). */
export interface AppOAuthAccessKey {
  accessToken: string;
  keyId: string;
  expiresAt: Date;
  /** Who the key acts as (`podAppActsAs`): the person, for every pod app. */
  actsAs: PodAppActsAs;
  /** The app's agent holding the key; null when the PERSON holds it. */
  agentUserId: string | null;
  publicId: string;
  /**
   * The approved reach the key carries, with space names for the app's UI and
   * the space's template slug (`workspaces.package_slug`) when it was made
   * from one, so an app finds "its" space by template, not by id. Omitted for
   * a space made from no template.
   */
  grant: Array<
    AppApprovedRequest & { workspaceName: string | null; templateSlug?: string }
  >;
  user: { id: string; name: string | null };
  /**
   * What the key reaches in v2 terms, named (W3d, `synap_access`): the
   * projects it reaches too, which a pair cannot say. null for a connection
   * that keeps its pairs until it re-consents (Q3).
   */
  access: NamedAppAccess | null;
}

/** Who a pod app's access token is for: the connection and its key slot. */
interface AppOAuthKeyArgs {
  appId: string;
  ownerUserId: string;
  oauthClientId: string;
  /** `oauthKeyInstanceId(client, person)` — the connection's key slot. */
  instanceId: string;
}

/**
 * The connection a pod app's access token may be handed out for, checked
 * afresh each time: this person's live pod app connection for this client,
 * with something approved, for a person still a human user. Refused
 * (FORBIDDEN / CONFLICT) otherwise.
 */
async function loadAppOAuthConnection(args: AppOAuthKeyArgs) {
  const repo = new AppRepository(db);
  const app = await repo.get(args.appId);
  if (
    !app ||
    app.mode !== "oauth" ||
    app.oauthClientId !== args.oauthClientId ||
    app.ownerUserId !== args.ownerUserId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This authorization is not for this app.",
    });
  }
  if (app.revokedAt || app.removedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app's connection was revoked.",
    });
  }
  const approved = app.approvedRequests ?? [];
  if (!approvalGivesAnything(appApprovalOf(app))) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This app has nothing approved.",
    });
  }
  const [person] = await db
    .select({ id: users.id, name: users.name, userType: users.userType })
    .from(users)
    .where(eq(users.id, app.ownerUserId))
    .limit(1);
  if (person?.userType !== "human") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only a person's connection can be used.",
    });
  }
  const found = (await repo.getByPublicId(app.publicId))!;
  return { app, approved, person, found };
}

/** A pod app key's scopes: `.write` only when something it holds is a write. */
function appOAuthKeyScope(
  grants: ReadonlyArray<{ permissions: readonly string[] }>
): string[] {
  return grants.some((g) => g.permissions.some((p) => !isReadPermission(p)))
    ? ["hub-protocol.read", "hub-protocol.write"]
    : ["hub-protocol.read"];
}

/** The /token answer for a key and the reach it carries. */
async function appOAuthAnswer(
  conn: Awaited<ReturnType<typeof loadAppOAuthConnection>>,
  key: {
    agentUserId: string | null;
    keyId: string;
    accessToken: string;
    expiresAt: Date;
  },
  grant: readonly AppApprovedRequest[],
  actsAs: PodAppActsAs,
  reach: { access: AppAccess | null; allProjects: readonly string[] } = {
    access: null,
    allProjects: [],
  }
): Promise<AppOAuthAccessKey> {
  const spaces = new Map(
    (grant.length > 0
      ? await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            templateSlug: workspaces.packageSlug,
          })
          .from(workspaces)
          .where(
            inArray(
              workspaces.id,
              grant.flatMap((r) => (r.workspaceId ? [r.workspaceId] : []))
            )
          )
      : []
    ).map((w) => [w.id, w])
  );
  return {
    accessToken: key.accessToken,
    keyId: key.keyId,
    expiresAt: key.expiresAt,
    actsAs,
    agentUserId: key.agentUserId,
    publicId: conn.app.publicId,
    // A pod-wide read answers `workspaceId: null, workspaceName: null`.
    grant: grant.map((r) => {
      const space = r.workspaceId ? spaces.get(r.workspaceId) : undefined;
      return {
        permission: r.permission,
        workspaceId: r.workspaceId,
        workspaceName: space?.name ?? null,
        ...(space?.templateSlug ? { templateSlug: space.templateSlug } : {}),
      };
    }),
    user: { id: conn.person.id, name: conn.person.name ?? null },
    access: reach.access
      ? await nameAppAccess(reach.access)
      : null,
  };
}

/** Why a Synap app's person token was refused, as the /token door says it. */
const PERSON_TOKEN_REFUSALS = {
  not_a_person: "Only a person's connection can be used.",
  reconsent:
    "Connect this app again: it changed, or it was connected before apps acted as the person who connects them.",
  app_unavailable: "This app's connection was revoked.",
  nothing_left:
    "Nothing you approved for this app is in a space you can still reach.",
} as const;

/**
 * A pod app's access token (`podAppActsAs` = "person"): minted by the ONE
 * app-person-token door — held by the person, the connection's approval ∩
 * their reach — then the slot's bookkeeping (event, webhooks, GC).
 */
async function mintPersonOAuthAccessKey(
  conn: Awaited<ReturnType<typeof loadAppOAuthConnection>>,
  args: AppOAuthKeyArgs & { plainKey?: string }
): Promise<AppOAuthAccessKey> {
  const { app, found } = conn;
  const { mintPodAppPersonToken } = await import("./app-person-token.js");
  const expiresAt = new Date(Date.now() + APP_OAUTH_ACCESS_TTL_SECONDS * 1000);
  const minted = await mintPodAppPersonToken({
    appId: app.id,
    oauthClientId: args.oauthClientId,
    personUserId: app.ownerUserId,
    expiresAt,
    ...(args.plainKey ? { plainKey: args.plainKey } : {}),
  });
  if (!minted.ok) {
    throw new TRPCError({
      code: minted.reason === "app_unavailable" ? "CONFLICT" : "FORBIDDEN",
      message: PERSON_TOKEN_REFUSALS[minted.reason],
    });
  }
  await recordAppEvent(found, app.ownerUserId, APP_EVENT_ACTIONS.keyIssued, {
    keyId: minted.keyId,
    via: "oauth",
    actsAs: "person",
    expiresAt: expiresAt.toISOString(),
  });
  await moveSlotWebhooks(app.ownerUserId, args.instanceId, minted.keyId);
  await sweepDeadOAuthKeys(app.ownerUserId, args.instanceId);
  return appOAuthAnswer(
    conn,
    {
      agentUserId: null,
      keyId: minted.keyId,
      accessToken: minted.plainKey,
      expiresAt,
    },
    minted.grant,
    "person",
    { access: minted.access, allProjects: minted.allProjects }
  );
}

/**
 * Mint a pod app's access token. An app is not an AI agent (founder, 12 Nov
 * 2026: "connecting is the approval"): the token is HELD BY THE PERSON who
 * consented (`app_person`, `mintPersonOAuthAccessKey`), carries what they
 * ticked ∩ their reach now (never the review verbs for an app that is not a
 * Synap app, `appSignInReach`), `client_id` = the connection's public id
 * ("via <app>"), and expires in 1 h. Before 12 Nov every app but a Synap app
 * got a key held by its own ask-first agent; such a slot's agent key is
 * revoked by the first person mint (`mintPodAppPersonToken`), so a live
 * connection switches at its next refresh.
 *
 * Refused (FORBIDDEN / CONFLICT) when the code's app is not this person's
 * live pod app connection for this client, has nothing approved, or the
 * person is no longer a human user.
 *
 * `plainKey`: the refresh grant passes the key its successor refresh token
 * re-derives (`successorAccessToken`, refresh.ts), so the reuse grace can hand
 * this same key back (`reuseAppOAuthAccessKey`). Random otherwise.
 */
export async function mintAppOAuthAccessKey(
  args: AppOAuthKeyArgs & { plainKey?: string }
): Promise<AppOAuthAccessKey> {
  return mintPersonOAuthAccessKey(await loadAppOAuthConnection(args), args);
}

/**
 * The refresh reuse grace (spec 17 PB3b): hand back the connection's LIVE key
 * when it is the one `accessToken` names, instead of minting. A mint would
 * revoke the copy the other caller already holds (one live key per
 * connection). Refused exactly like a mint (`loadAppOAuthConnection`), and its
 * reach is re-derived from the CURRENT approval, so a grace never reaches more
 * than a mint would; its expiry is kept, never extended. null when that key is
 * not the slot's live key, or the approval now needs other scopes: the caller
 * mints instead.
 */
export async function reuseAppOAuthAccessKey(
  args: AppOAuthKeyArgs & { accessToken: string }
): Promise<AppOAuthAccessKey | null> {
  return reusePersonOAuthAccessKey(await loadAppOAuthConnection(args), args);
}

/**
 * `reuseAppOAuthAccessKey` for a Synap app: the slot's live PERSON key when it
 * is the one `accessToken` names, its grant re-derived from the connection's
 * CURRENT approval ∩ the person's CURRENT reach (never wider than a mint).
 * null otherwise — the caller mints.
 */
async function reusePersonOAuthAccessKey(
  conn: Awaited<ReturnType<typeof loadAppOAuthConnection>>,
  args: AppOAuthKeyArgs & { accessToken: string }
): Promise<AppOAuthAccessKey | null> {
  const person = conn.app.ownerUserId;
  const [key] = await db
    .select({
      id: apiKeys.id,
      scope: apiKeys.scope,
      expiresAt: apiKeys.expiresAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(
          apiKeys.keyLookupHash,
          createHash("sha256").update(args.accessToken).digest("hex")
        ),
        eq(apiKeys.userId, person),
        eq(apiKeys.keyType, APP_PERSON_KEY_TYPE),
        eq(apiKeys.instanceId, args.instanceId),
        eq(apiKeys.isActive, true),
        drizzleSql`${apiKeys.expiresAt} > now()`
      )
    )
    .limit(1);
  if (!key?.expiresAt) return null;
  const { appSignInGrant } = await import("../routers/oauth/app-client.js");
  const reach = await appSignInGrant(conn.app, person);
  if (reach === "not_for_you" || reach.scopes.length === 0) return null;
  const scope = appOAuthKeyScope(reach.scopes);
  if (
    key.scope.length !== scope.length ||
    !scope.every((s) => key.scope.includes(s))
  ) {
    return null;
  }
  await attachGrantsOrRevoke({
    apiKeyId: key.id,
    principalUserId: person,
    onBehalfOf: person,
    grants: reach.scopes.map((g) => ({
      ...g,
      label: `Signed in to ${conn.app.name}`,
    })),
    expiresAt: key.expiresAt,
    createdBy: person,
    clientId: conn.app.publicId,
  });
  return appOAuthAnswer(
    conn,
    {
      agentUserId: null,
      keyId: key.id,
      accessToken: args.accessToken,
      expiresAt: key.expiresAt,
    },
    reach.pairs,
    "person",
    { access: reach.access, allProjects: reach.allProjects }
  );
}

/**
 * A pod app's webhook subscriptions follow its connection, not one access
 * token (PB4). A subscription records the key that created it (0335, ON
 * DELETE CASCADE) and is delivered only while that key is live and only what
 * its grant reads (jobs `webhook-worker`). A pod app's key lives 1 h, so at
 * each mint the subscriptions of the connection's earlier keys (this agent ×
 * this key slot) move onto the new one: delivery keeps the liveness and grant
 * rules, now read from the connection's CURRENT key, and the GC's delete of
 * an old key no longer takes them along. Between a token's expiry and the
 * app's next refresh nothing is delivered (no live key). Revoking the app
 * deletes them (`revokeApp`).
 */
async function moveSlotWebhooks(
  /** Who holds the slot's keys: the app's agent, or the person (a Synap app). */
  holderUserId: string,
  instanceId: string,
  keyId: string
): Promise<void> {
  await db
    .update(webhookSubscriptions)
    .set({ apiKeyId: keyId })
    .where(
      inArray(
        webhookSubscriptions.apiKeyId,
        db
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.userId, holderUserId),
              eq(apiKeys.instanceId, instanceId),
              ne(apiKeys.id, keyId)
            )
          )
      )
    );
}

/** The GC behind `APP_OAUTH_DEAD_KEYS_KEPT`: one connection's key slot only. */
async function sweepDeadOAuthKeys(
  /** Who holds the slot's keys: the app's agent, or the person (a Synap app). */
  holderUserId: string,
  instanceId: string
): Promise<void> {
  const dead = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, holderUserId),
        eq(apiKeys.instanceId, instanceId),
        eq(apiKeys.isActive, false)
      )
    )
    .orderBy(drizzleSql`${apiKeys.createdAt} desc`)
    .limit(APP_OAUTH_KEY_SWEEP_BATCH)
    .offset(APP_OAUTH_DEAD_KEYS_KEPT);
  if (dead.length === 0) return;
  await db.delete(apiKeys).where(
    inArray(
      apiKeys.id,
      dead.map((k) => k.id)
    )
  );
}

/**
 * Is this key one a pod app was minted at /token — held by the agent of an
 * `apps` row with mode 'oauth'? What `/revoke` (RFC 7009) widens its
 * revocable set with (`isOAuthMintedKey`, routes.ts).
 */
export async function isPodAppAgent(agentUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.agentUserId, agentUserId), eq(apps.mode, "oauth")))
    .limit(1);
  return !!row;
}

/**
 * Revoke an app: its keys and grants stop at once, a request still waiting
 * for review is withdrawn (it leaves the bell and every queue), and the app is
 * soft-revoked.
 */
export async function revokeApp(args: {
  publicId: string;
  /** The caller — the app's owner, unless `podAdmin`. Events name them. */
  ownerUserId: string;
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
  /** Lifts the owner floor — set by a `podAdminProcedure` only (`loadAppToEnd`). */
  podAdmin?: boolean;
}): Promise<{ publicId: string }> {
  assertOwnerCredential("revoke an app", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadAppToEnd(
    args.publicId,
    args.ownerUserId,
    args.podAdmin
  );
  // A pod app's refresh tokens die FIRST (I6): a refresh after this is
  // `invalid_grant`, and one already minting fails its rotation and revokes
  // the key it minted, so no key outlives the revoke below.
  if (found.app.mode === "oauth") {
    await revokeConnectionRefreshTokens(found.app.id);
  }
  const repo = new AppRepository(db);
  const withdrawn = await repo.withdrawPendingRequests(
    found.app.id,
    args.ownerUserId,
    { reason: "app_revoked" }
  );
  if (withdrawn.length > 0) {
    const { emitProposalReviewed } =
      await import("../routers/proposals/apply-approval.js");
    for (const id of withdrawn) {
      emitProposalReviewed(id, null, "withdrawn", args.ownerUserId);
    }
  }
  // Its webhook subscriptions go with it: delivery already stops with the
  // keys, and a key-bound row left behind would come back on the next key of
  // a re-consent (`moveSlotWebhooks`).
  const keyIds = await repo.keyIdsFor(found.app.publicId);
  if (keyIds.length > 0) {
    await db
      .delete(webhookSubscriptions)
      .where(inArray(webhookSubscriptions.apiKeyId, keyIds));
  }
  const revokedKeys = await revokeAppKeys(
    found,
    args.ownerUserId,
    `App revoked: ${found.app.name}`
  );
  // Its agent leaves every workspace: a revoked app reaches nothing. Its
  // write mode goes back to ask-first (F6), so connecting it again starts
  // where every new connection starts, never at "apply automatically".
  if (found.app.agentUserId) {
    await syncAppAgentMemberships(found.app.agentUserId, args.ownerUserId, []);
    await applyAgentPosture({
      db,
      agentUserId: found.app.agentUserId,
      posture: "ask-first",
      createdBy: args.ownerUserId,
    });
  }
  // A pod app's authorization codes still waiting to be redeemed are burned
  // (I6): a code issued before the revoke must not mint after it.
  await db
    .update(oauthAuthorizationCodes)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationCodes.appId, found.app.id),
        isNull(oauthAuthorizationCodes.consumedAt)
      )
    );
  await repo.revoke(found.app.id);
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.revoked, {
    revokedKeys,
    withdrawnRequests: withdrawn.length,
  });
  return { publicId: found.app.publicId };
}

/** At most this many redirect URIs per app (the DCR door's bound). */
export const APP_MAX_REDIRECT_URIS = 8;

/**
 * "Sign in with Synap": where a person's sign-in code for this app may be
 * delivered — an exact-match allowlist, REPLACED by each call (`[]` stops the
 * app signing anyone in). The OWNER's act only, signed in as themselves
 * (`assertOwnerCredential`: no agent key, no scoped key — so neither the app's
 * own key nor a person's sign-in token can point codes somewhere else). Each
 * URI follows the DCR door's rule: absolute https, no fragment.
 */
export async function setAppRedirectUris(args: {
  publicId: string;
  ownerUserId: string;
  redirectUris: readonly string[];
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
  /** The gate's pass for `apps.setRedirectUris` (`passPresenceForAction`). */
  presence: PresencePass | null;
}): Promise<AppWithGrants> {
  assertPresencePass(args.presence, {
    actions: ["apps.setRedirectUris"],
    userId: args.ownerUserId,
  });
  assertOwnerCredential("change where an app signs people in", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  // A pod app connection (`mode = 'oauth'`) is not a registered app: it can
  // never sign anyone in (`loadLiveApp`), so it never gets redirect URIs.
  if (found.app.mode !== "specific") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Only an app registered on this pod can sign people in; a connected app cannot.",
    });
  }
  const uris = [...new Set(args.redirectUris.map((u) => u.trim()))];
  if (uris.length > APP_MAX_REDIRECT_URIS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `At most ${APP_MAX_REDIRECT_URIS} redirect URIs per app.`,
    });
  }
  for (const uri of uris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Not an absolute URL: ${uri}`,
      });
    }
    if (url.protocol !== "https:" || url.hash || uri.includes("#")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A redirect URI must be https with no fragment: ${uri}`,
      });
    }
    if (url.username || url.password || uri.length > 2048) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `A redirect URI must carry no credentials and stay under 2048 characters: ${uri}`,
      });
    }
  }
  await new AppRepository(db).setRedirectUris(found.app.id, uris);
  return loadOwnedApp(args.publicId, args.ownerUserId);
}

/**
 * "Sign in with Synap": may a person signed in to this app approve proposals
 * its OWN agent filed (the "approve the AI's drafts inline" flow)? Default
 * true; the owner turns it off here. Owner credential only.
 */
export async function setAppSignInPolicy(args: {
  publicId: string;
  ownerUserId: string;
  personMayDecideOwnAgentProposals: boolean;
  actorAgentUserId?: string | null;
  actorKeyType?: string | null;
}): Promise<AppWithGrants> {
  assertOwnerCredential("change what an app's sign-ins may decide", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  await new AppRepository(db).setPersonMayDecideOwnAgentProposals(
    found.app.id,
    args.personMayDecideOwnAgentProposals
  );
  return loadOwnedApp(args.publicId, args.ownerUserId);
}

/** Rename an app (names are unique per owner — a taken name is a CONFLICT). */
export async function renameApp(args: {
  publicId: string;
  ownerUserId: string;
  name: string;
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
}): Promise<AppWithGrants> {
  assertOwnerCredential("rename an app", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  const to = args.name.trim();
  if (to === found.app.name) return found;
  const repo = new AppRepository(db);
  try {
    await repo.rename(found.app.id, to);
  } catch (err) {
    if (err instanceof AppNameTakenError)
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    throw err;
  }
  // The app's agent carries the app's name — it is what a receipt names.
  if (found.app.agentUserId) {
    await db
      .update(users)
      .set({ name: to })
      .where(
        and(eq(users.id, found.app.agentUserId), eq(users.userType, "agent"))
      );
  }
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.renamed, {
    from: found.app.name,
    to,
  });
  return loadOwnedApp(args.publicId, args.ownerUserId);
}

/**
 * "Remove for good": hide a REVOKED app from every listing. Soft — the row
 * and its events stay, so its history remains readable by id. A live app must
 * be revoked first (its access is what "remove" would otherwise hide).
 */
export async function removeApp(args: {
  publicId: string;
  /** The caller — the app's owner, unless `podAdmin`. Events name them. */
  ownerUserId: string;
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
  /** Lifts the owner floor — set by a `podAdminProcedure` only (`loadAppToEnd`). */
  podAdmin?: boolean;
}): Promise<{ publicId: string }> {
  assertOwnerCredential("remove an app", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadAppToEnd(
    args.publicId,
    args.ownerUserId,
    args.podAdmin
  );
  if (!found.app.revokedAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Revoke this app's access before removing it for good.",
    });
  }
  if (!found.app.removedAt) {
    await new AppRepository(db).remove(found.app.id);
    await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.removed);
  }
  return { publicId: found.app.publicId };
}

// ─── Connections manager (spec 17 PB4) ───────────────────────────────────────
//
// What a person does with an app already connected to their pod, and what the
// pod admin sees of every member's: narrow its access without a new consent,
// choose how its writes land, read it with its domain and tier. Revoke is
// `revokeApp` above (keys, refresh families, waiting codes, webhooks).

const pairKey = (r: AppApprovedRequest) =>
  `${r.permission}\u0000${r.workspaceId}`;

/**
 * Narrow an app: keep only some of what was approved — drop a permission in
 * one space, or a whole space — with no new consent. The person's own act and
 * it only REDUCES access, so it applies at once (no proposal), through the
 * one approval write (`setApprovedRequests`). `approved` is the set to KEEP:
 * exact (permission, space) pairs of the current approval, at least one (all
 * gone is Revoke). Anything not already approved is refused.
 *
 * The live access shrinks now: a pod app's live key is revoked, the
 * person's token as much as a legacy agent's (its 1 h token cannot be
 * re-issued to the app from here), and its next refresh is minted from the
 * narrowed approval (`mintAppOAuthAccessKey` reads the current one); a legacy
 * agent leaves the spaces it lost. An App Connect app's long-lived
 * key is re-derived in place (`applyApprovedReach`).
 *
 * Who may: the app's owner signed in as themselves (`assertOwnerCredential`),
 * never an agent's credential or a scoped key.
 */
export async function narrowApp(args: {
  publicId: string;
  ownerUserId: string;
  approved: readonly AppApprovedRequest[];
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
}): Promise<AppWithGrants> {
  assertOwnerCredential("change an app's access", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const current = dedupeRequests(found.app.approvedRequests ?? []);
  const keep = dedupeRequests(args.approved);
  if (keep.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "An app keeps at least one permission here. To take all its access away, revoke it.",
    });
  }
  const held = new Set(current.map(pairKey));
  const beyond = keep.filter((r) => !held.has(pairKey(r)));
  if (beyond.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Narrowing can only take access away. Not approved for this app: ${beyond
        .map((r) => `${r.permission} in ${r.workspaceId ?? EVERYWHERE_IN_POD}`)
        .join(", ")}.`,
    });
  }
  if (keep.length === current.length) return found;

  const repo = new AppRepository(db);
  await repo.setApprovedRequests(found.app.id, keep);
  if (found.app.mode === "oauth") {
    // The connection's live key, whoever holds it: the person's token (every
    // pod app since 12 Nov 2026) or, for a connection not refreshed since,
    // its agent's. Its grants go with it (`revokeAppKeys`).
    await revokeAppKeys(
      found,
      args.ownerUserId,
      `Access narrowed for ${found.app.name}: the next token carries the narrower reach`
    );
    if (found.app.agentUserId) {
      await syncAppAgentMemberships(
        found.app.agentUserId,
        found.app.ownerUserId,
        keep
      );
    }
  } else {
    await applyApprovedReach(found.app.id);
  }
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.approved, {
    via: "narrow",
    approved: keep,
    removed: current.filter(
      (r) => !keep.some((k) => pairKey(k) === pairKey(r))
    ),
  });
  return loadOwnedApp(args.publicId, args.ownerUserId);
}

/** How an app's writes land, as its page shows it. */
export interface AppWriteModeView {
  /**
   * The switch: ON when the app's agent follows the pod's default ("apply
   * automatically"), OFF while it asks first (every connection starts OFF).
   */
  applyAutomatically: boolean;
  /** The effective mode, the pod default included (`resolveAgentWriteMode`). */
  writeMode: AgentWriteMode;
  /** The one sentence for that mode. */
  line: string;
}

/** The write mode of an app's agent (no agent yet ⇒ ask first, its start). */
export async function appWriteMode(
  agentUserId: string | null
): Promise<AppWriteModeView> {
  const state = agentUserId
    ? await readAgentGovernance({ db, agentUserId })
    : null;
  return writeModeView(state, (await readReversibleDefault(db)).enabled);
}

/** `appWriteMode` from posture already read (a list reads them in one go). */
function writeModeView(
  state: Pick<AgentGovernanceState, "posture" | "writesRequireProposal"> | null,
  podDefaultEnabled: boolean
): AppWriteModeView {
  const posture = state ? state.posture : "ask-first";
  const writeMode = resolveAgentWriteMode({
    posture,
    podDefaultEnabled,
    writesRequireProposal: state?.writesRequireProposal ?? true,
  });
  return {
    applyAutomatically: posture === null,
    writeMode,
    line: AGENT_WRITE_MODE_LINE[writeMode],
  };
}

/**
 * The per-app "apply automatically" switch (F6): never set at consent, only
 * here, after connecting. ON = the app's agent follows the pod default (its
 * `ask-first` posture cleared); OFF = `ask-first` again. Through the ONE
 * posture writer (`applyAgentPosture`), the store every agent's write mode
 * lives in, so the governance ladder reads it like any agent's.
 *
 * Who may: the app's owner signed in as themselves. An agent's credential is
 * refused (`assertOwnerCredential`): no agent decides that another agent's —
 * or its own — changes stop asking.
 */
export async function setAppWriteMode(args: {
  publicId: string;
  ownerUserId: string;
  applyAutomatically: boolean;
  actorAgentUserId?: string | null;
  /** The calling key's type — `is_internal` is an agent caller. */
  actorKeyType?: string | null;
  /** The gate's pass for `apps.setWriteMode` (`passPresenceForAction`). */
  presence: PresencePass | null;
}): Promise<AppWriteModeView> {
  assertPresencePass(args.presence, {
    actions: ["apps.setWriteMode"],
    userId: args.ownerUserId,
  });
  assertOwnerCredential("change how an app's changes land", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const agentUserId = await ensureAppAgent(found, "ui");
  await applyAgentPosture({
    db,
    agentUserId,
    posture: args.applyAutomatically ? null : "ask-first",
    createdBy: args.ownerUserId,
  });
  await auditLog({
    subjectType: "agent_user",
    action: "update",
    phase: "completed",
    subjectId: agentUserId,
    userId: args.ownerUserId,
    workspaceId: null,
    appId: found.app.publicId,
    data: {
      name: found.app.name,
      applyAutomatically: args.applyAutomatically,
    },
  });
  return appWriteMode(agentUserId);
}

/** One approved (permission, space) pair, with the space's name. */
export type NamedApprovedRequest = AppApprovedRequest & {
  workspaceName: string | null;
};

/** What a pod app connection adds to its app row (`pod_app` on the wire). */
export interface PodAppView {
  /** The app's metadata-document URL — its OAuth `client_id`. */
  client_id: string;
  /** Its host: the app's identity, the headline. */
  domain: string;
  /** A Synap app (exact first-party origin) vs an unverified one. */
  verified: boolean;
  /** What the person approved, per space — what Narrow edits. */
  approved: NamedApprovedRequest[];
  /**
   * What it may do and where, v2, named (W3d): the stored access, or the
   * exact lift of its pairs; null when it must re-consent (`reconsent`).
   */
  access: NamedAppAccess | null;
  /**
   * Its old pairs cannot become v2 as they are (Q3): Connected shows "Needs
   * your review". Its old access keeps working until W5. `proposed` is the
   * pairs' v2 form, NOT clamped here (the editor, `apps.accessOffer`, clamps
   * it to what the person may give now).
   */
  reconsent: ReconsentView | null;
  /** When this person last connected it (the newest consent). */
  connected_at: Date | null;
  /** The newest use of any of its access tokens. */
  last_used_at: Date | null;
  write_mode: AppWriteModeView;
}

/**
 * The `pod_app` half of each pod app row (mode 'oauth'), keyed by public id.
 * A fixed number of queries whatever the number of rows (review S7): space
 * names, the newest consent per app, the agents' postures and the pod
 * default, one read each; key use from the keys the caller already read.
 */
export async function podAppViews(
  rows: readonly AppWithGrants[],
  keysByPublicId: ReadonlyMap<
    string,
    ReadonlyArray<{ lastUsedAt: Date | null; createdAt: Date }>
  >
): Promise<Map<string, PodAppView>> {
  const pod = rows.filter((r) => r.app.mode === "oauth" && r.app.oauthClientId);
  if (pod.length === 0) return new Map();
  const spaceIds = [
    ...new Set(
      pod.flatMap((r) =>
        (r.app.approvedRequests ?? []).flatMap((a) =>
          a.workspaceId ? [a.workspaceId] : []
        )
      )
    ),
  ];
  const names = new Map(
    (spaceIds.length > 0
      ? await db
          .select({ id: workspaces.id, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, spaceIds))
      : []
    ).map((w) => [w.id, w.name])
  );
  // The newest approved consent per app, not every one of them.
  const consents = await db
    .select({
      targetId: proposals.targetId,
      connectedAt: drizzleSql<Date | string>`max(${proposals.createdAt})`,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "app"),
        eq(proposals.proposalType, "connect"),
        eq(proposals.status, ProposalStatus.APPROVED),
        inArray(
          proposals.targetId,
          pod.map((r) => r.app.id)
        )
      )
    )
    .groupBy(proposals.targetId);
  // An aggregate skips the column's mapping: the driver may hand a string.
  const connectedAt = new Map(
    consents.map((c) => [c.targetId, new Date(c.connectedAt)])
  );
  const postures = await readAgentWritePostures({
    db,
    agentUserIds: pod.flatMap((r) =>
      r.app.agentUserId ? [r.app.agentUserId] : []
    ),
  });
  const podDefaultEnabled = (await readReversibleDefault(db)).enabled;
  // Each row's v2 access and re-consent, named in ONE read for every row
  // (W3d; S7: a fixed number of queries whatever the number of rows).
  const v2 = new Map(
    pod.map((r) => {
      const approval = appApprovalOf(r.app);
      return [
        r.app.publicId,
        { access: approval.access, reconsent: reconsentOf(approval) },
      ] as const;
    })
  );
  const v2Ids = [...v2.values()].flatMap((x) => [
    ...(x.access ? [accessPlaceIds(x.access)] : []),
    ...(x.reconsent ? [reconsentPlaceIds(x.reconsent)] : []),
  ]);
  const v2Names = await placeNames(
    v2Ids.flatMap((x) => x.spaces),
    v2Ids.flatMap((x) => x.projects)
  );
  const out = new Map<string, PodAppView>();
  for (const row of pod) {
    const clientId = row.app.oauthClientId!;
    const rowV2 = v2.get(row.app.publicId)!;
    const keys = keysByPublicId.get(row.app.publicId) ?? [];
    const newestOf = (dates: Array<Date | null | undefined>) =>
      dates.reduce<Date | null>(
        (acc, d) => (d && (!acc || d > acc) ? d : acc),
        null
      );
    let domain = clientId;
    try {
      domain = new URL(clientId).host;
    } catch {
      // A stored client_id is always a URL; show it raw if not.
    }
    out.set(row.app.publicId, {
      client_id: clientId,
      domain,
      verified: isSynapApp(clientId),
      approved: (row.app.approvedRequests ?? []).map((a) => ({
        permission: a.permission,
        workspaceId: a.workspaceId,
        // A pod-wide read has no space: the page words it "everywhere".
        workspaceName: a.workspaceId
          ? (names.get(a.workspaceId) ?? null)
          : null,
      })),
      access: rowV2.access ? nameAppAccessWith(rowV2.access, v2Names) : null,
      reconsent: rowV2.reconsent
        ? reconsentViewWith(rowV2.reconsent, v2Names)
        : null,
      connected_at: connectedAt.get(row.app.id) ?? null,
      last_used_at: newestOf([
        row.lastUsedAt,
        ...keys.map((k) => k.lastUsedAt),
      ]),
      write_mode: writeModeView(
        row.app.agentUserId
          ? (postures.get(row.app.agentUserId) ?? null)
          : null,
        podDefaultEnabled
      ),
    });
  }
  return out;
}

/** One member's connection of a pod app, as the pod admin reads it. */
export interface AdminPodAppMember {
  public_id: string;
  owner: { id: string; name: string | null; email: string | null } | null;
  approved: NamedApprovedRequest[];
  connected_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** One pod app across the pod's members (`apps.adminPodApps`). */
export interface AdminPodAppGroup {
  client_id: string;
  domain: string;
  verified: boolean;
  /** The name the app gives itself (text only), from a member's row. */
  name: string;
  /** Members whose connection is live. */
  live: number;
  members: AdminPodAppMember[];
}

/**
 * Every member's pod app connections, grouped by app (`oauth_client_id`) —
 * the pod admin's view ("Content Studio — 3 members"). Unfloored: the caller
 * gates (pod admin, never an agent). Removed rows are not listed; revoked
 * ones are, so the admin sees what was cut off.
 */
export async function adminPodApps(): Promise<AdminPodAppGroup[]> {
  const repo = new AppRepository(db);
  const rows = (await repo.listAll({ includeRevoked: true })).filter(
    (r) => r.app.mode === "oauth" && r.app.oauthClientId
  );
  if (rows.length === 0) return [];
  const keys = await repo.keysByApp(rows.map((r) => r.app.publicId));
  const views = await podAppViews(rows, keys);
  const ownerIds = [...new Set(rows.map((r) => r.app.ownerUserId))];
  const owners = new Map(
    (
      await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, ownerIds))
    ).map((o) => [o.id, o])
  );
  const groups = new Map<string, AdminPodAppGroup>();
  for (const row of rows) {
    const view = views.get(row.app.publicId)!;
    const group = groups.get(view.client_id) ?? {
      client_id: view.client_id,
      domain: view.domain,
      verified: view.verified,
      // "<client_name> (<host>)" as consent named the row.
      name: row.app.name,
      live: 0,
      members: [],
    };
    if (!row.app.revokedAt) group.live++;
    group.members.push({
      public_id: row.app.publicId,
      owner: owners.get(row.app.ownerUserId) ?? null,
      approved: view.approved,
      connected_at: view.connected_at,
      last_used_at: view.last_used_at,
      revoked_at: row.app.revokedAt,
    });
    groups.set(view.client_id, group);
  }
  return [...groups.values()].sort(
    (a, b) => b.live - a.live || a.domain.localeCompare(b.domain)
  );
}

/**
 * The pod admin ends ONE app for every member ("revoke all"): each live
 * connection of that `oauth_client_id` through `revokeApp` with the owner
 * floor lifted, so each stops exactly as its owner's revoke would. Returns
 * how many were revoked.
 */
export async function adminRevokePodAppClient(args: {
  oauthClientId: string;
  adminUserId: string;
  actorAgentUserId?: string | null;
  actorKeyType?: string | null;
}): Promise<{ revoked: number }> {
  assertOwnerCredential("revoke an app", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const live = await db
    .select({ publicId: apps.publicId })
    .from(apps)
    .where(
      and(
        eq(apps.mode, "oauth"),
        eq(apps.oauthClientId, args.oauthClientId),
        isNull(apps.revokedAt),
        isNull(apps.removedAt)
      )
    );
  for (const row of live) {
    await revokeApp({
      publicId: row.publicId,
      ownerUserId: args.adminUserId,
      actorAgentUserId: args.actorAgentUserId,
      actorKeyType: args.actorKeyType,
      podAdmin: true,
    });
  }
  return { revoked: live.length };
}

// ─── The consent SAVES AppAccess v2 (app permissions W3d) ────────────────────
//
// Decisions 51ad8d1e (F1-F4) and fc37f740 (design A, Q1-Q4). The person's
// choice is a v2 access, checked against what the app ASKED ∩ what the person
// may GIVE (`appAccessBeyond`, `@synap-core/types/grants`), stored FIRST
// (`AppRepository.setApprovedAccess`, the pairs derived from it) and minted
// exactly (`grantScopesForAccess`). Contract: pod document be6caecc ("W3d
// consent contract").

/** What an app asked, in v2 terms: one item per permission (W3d). */
export interface AccessAskedItem {
  permission: string;
  tier: "read" | "write";
  /** The developer's words (`synap_requests[].reason`), shown as text. */
  reason: string | null;
  /** The F4 entry it was declared in, to draw ONE row per group. */
  kindGroup: OAuthAppKindGroup | null;
  /** May it hold in All spaces (declared pod-wide AND a pod-wide read)? */
  allSpaces: boolean;
  /** Can the person give it anywhere? false: the "can't give" fold. */
  offerable: boolean;
}

/** What an app asked, as the server reads it from its cached document. */
export interface AccessAsked {
  /** Each permission it asked AND declared (review verbs already filtered). */
  permissions: readonly string[];
  /** Of those, the ones it declared pod-wide (`synap_requests[].scope = "pod"`). */
  podWide: readonly string[];
  reasons?: Readonly<Record<string, string>>;
  kindGroups?: readonly unknown[];
  /** `synap_templates`: the pre-tick of the write places. */
  templates?: readonly string[];
}

/** The places the person may give, per tier, named (W3d). */
export interface AccessPlacesOffer {
  read: {
    /** Every asked read may ride All spaces. */
    allSpaces: boolean;
    spaces: NamedSpace[];
    projects: NamedProject[];
  };
  write: {
    spaces: NamedSpace[];
    projects: NamedProject[];
    /** Write spaces made from a declared template: the pre-tick ([] = none). */
    suggestedSpaceIds: string[];
  };
}

/** The asked access and what the person may give, read now (W3d). */
export interface AccessOffer {
  asked: { permissions: AccessAskedItem[]; templates: string[] };
  places: AccessPlacesOffer;
  /** The same, as the ceiling every v2 approval is checked against. */
  ceiling: AppAccessCeiling;
}

/**
 * What a person may give an app, read NOW (W3d): the asked permissions, and
 * per tier the places they may give: reads in the spaces they read (not
 * archived) and the projects they see; writes in the spaces they write in
 * and the projects they may write in (`oauthAppProjectOffer`); All spaces
 * only for reads declared pod-wide that are pod-wide reads (D1).
 */
export async function appAccessOffer(
  ownerUserId: string,
  asked: AccessAsked
): Promise<AccessOffer> {
  const readable = await getUserWorkspaceIds(ownerUserId);
  const rows =
    readable.length > 0
      ? await db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            templateSlug: workspaces.packageSlug,
          })
          .from(workspaces)
          .where(
            and(inArray(workspaces.id, readable), isNull(workspaces.archivedAt))
          )
      : [];
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const [writable, projects] = await Promise.all([
    spacesOwnerMayWriteIn(
      ownerUserId,
      rows.map((r) => r.id)
    ),
    oauthAppProjectOffer(ownerUserId),
  ]);
  const space = (r: (typeof rows)[number]): NamedSpace => ({
    id: r.id,
    name: r.name,
    templateSlug: r.templateSlug ?? null,
  });
  const project = (p: OAuthAppOfferProject): NamedProject => ({
    id: p.projectId,
    name: p.projectName,
    workspaceId: p.workspaceId,
  });
  const readSpaces = rows.map(space);
  const writeSpaces = rows.filter((r) => writable.has(r.id)).map(space);
  const readProjects = projects.readable.map(project);
  const writeProjects = projects.writable.map(project);
  const permissions = [...new Set(asked.permissions)];
  const podWide = new Set(asked.podWide);
  const allSpacesReads = permissions.filter(
    (p) => isReadPermission(p) && podWide.has(p) && isPodWideReadPermission(p)
  );
  const groups = kindGroupIndex(asked.kindGroups ?? []);
  const templates = [...(asked.templates ?? [])];
  const items: AccessAskedItem[] = permissions.map((permission) => {
    const read = isReadPermission(permission);
    const allSpaces = allSpacesReads.includes(permission);
    return {
      permission,
      tier: read ? "read" : "write",
      reason:
        asked.reasons && Object.hasOwn(asked.reasons, permission)
          ? asked.reasons[permission] || null
          : null,
      kindGroup: groups.get(permission) ?? null,
      allSpaces,
      offerable: read
        ? allSpaces || readSpaces.length > 0 || readProjects.length > 0
        : writeSpaces.length > 0 || writeProjects.length > 0,
    };
  });
  const reads = items.filter((i) => i.tier === "read");
  return {
    asked: { permissions: items, templates },
    places: {
      read: {
        allSpaces: reads.length > 0 && reads.every((i) => i.allSpaces),
        spaces: readSpaces,
        projects: readProjects,
      },
      write: {
        spaces: writeSpaces,
        projects: writeProjects,
        suggestedSpaceIds: writeSpaces
          .filter((s) => s.templateSlug && templates.includes(s.templateSlug))
          .map((s) => s.id),
      },
    },
    ceiling: {
      permissions,
      allSpacesReads,
      read: {
        spaces: readSpaces.map((s) => s.id),
        projects: readProjects.map((p) => p.id),
      },
      write: {
        spaces: writeSpaces.map((s) => s.id),
        projects: writeProjects.map((p) => p.id),
      },
    },
  };
}

/** Space and project names for display (never a raw id alone). */
async function placeNames(
  spaceIds: readonly string[],
  projectIds: readonly string[]
): Promise<{
  space: (id: string) => NamedSpace;
  project: (id: string) => NamedProject;
}> {
  const [spaceRows, projectRows] = await Promise.all([
    spaceIds.length > 0
      ? db
          .select({
            id: workspaces.id,
            name: workspaces.name,
            templateSlug: workspaces.packageSlug,
          })
          .from(workspaces)
          .where(inArray(workspaces.id, [...new Set(spaceIds)]))
      : [],
    projectIds.length > 0
      ? db
          .select({
            id: projects.id,
            name: projects.name,
            workspaceId: projects.workspaceId,
          })
          .from(projects)
          .where(inArray(projects.id, [...new Set(projectIds)]))
      : [],
  ]);
  const spaces = new Map(spaceRows.map((r) => [r.id, r]));
  const projectsById = new Map(projectRows.map((r) => [r.id, r]));
  return {
    space: (id) => {
      const r = spaces.get(id);
      return {
        id,
        name: r?.name ?? "a space that no longer exists",
        templateSlug: r?.templateSlug ?? null,
      };
    },
    project: (id) => {
      const r = projectsById.get(id);
      return {
        id,
        name: r?.name ?? "a project that no longer exists",
        workspaceId: r?.workspaceId ?? null,
      };
    },
  };
}

/** The space and project ids an access names (W3d). */
function accessPlaceIds(access: AppAccess): {
  spaces: string[];
  projects: string[];
} {
  const ids = (x: AccessAllOrIdsLike) => (x === "all" ? [] : [...x]);
  return {
    spaces: [...ids(access.read.spaces), ...access.write.spaces],
    projects: [...ids(access.read.projects), ...access.write.projects],
  };
}

type PlaceNames = Awaited<ReturnType<typeof placeNames>>;

/** `nameAppAccess` with the names already read (one read for many rows). */
function nameAppAccessWith(
  input: AppAccess,
  names: PlaceNames
): NamedAppAccess {
  const access = normalizeAppAccess(input);
  return {
    version: 2,
    permissions: [...access.permissions],
    read: {
      spaces:
        access.read.spaces === "all"
          ? "all"
          : access.read.spaces.map(names.space),
      projects:
        access.read.spaces === "all" || access.read.projects === "all"
          ? "all"
          : access.read.projects.map(names.project),
    },
    write: {
      spaces: access.write.spaces.map(names.space),
      projects: access.write.projects.map(names.project),
    },
  };
}

/**
 * A v2 access with its places NAMED (W3d): what every screen shows. Under All
 * spaces the read projects show as "all" (Q1: every project is included).
 */
export async function nameAppAccess(input: AppAccess): Promise<NamedAppAccess> {
  const access = normalizeAppAccess(input);
  const ids = accessPlaceIds(access);
  return nameAppAccessWith(access, await placeNames(ids.spaces, ids.projects));
}

type AccessAllOrIdsLike = "all" | readonly string[];

/**
 * The words for one refusal of `appAccessBeyond`, with names, but only the
 * names of places the person can see (`ceiling.read`): a space or project
 * they cannot see is never named, whatever id was sent.
 */
async function describeBeyond(
  beyond: readonly AccessBeyond[],
  ceiling: AppAccessCeiling
): Promise<string> {
  const seenSpaces = new Set(ceiling.read.spaces);
  const seenProjects = new Set(ceiling.read.projects);
  const names = await placeNames(
    beyond.flatMap((b) =>
      b.where?.kind === "space" && seenSpaces.has(b.where.id)
        ? [b.where.id]
        : []
    ),
    beyond.flatMap((b) =>
      b.where?.kind === "project" && seenProjects.has(b.where.id)
        ? [b.where.id]
        : []
    )
  );
  const parts = beyond.slice(0, 8).map((b) => {
    switch (b.reason) {
      case "not-asked":
        return `${b.permission} (the app did not ask for it)`;
      case "not-all-spaces":
        return `${b.permission} in all spaces (the app asked for it in chosen spaces only)`;
      case "not-offered": {
        const where =
          b.where?.kind === "space"
            ? seenSpaces.has(b.where.id)
              ? `space ${names.space(b.where.id).name}`
              : "a space you cannot see"
            : b.where?.kind === "project"
              ? seenProjects.has(b.where.id)
                ? `project ${names.project(b.where.id).name}`
                : "a project you cannot see"
              : "that place";
        return b.tier === "write"
          ? `changes in ${where} (you cannot edit there)`
          : `reading in ${where} (you cannot see it)`;
      }
      default:
        return "something it did not ask for";
    }
  });
  return parts.join("; ");
}

/**
 * Refuse an access beyond its ceiling (FORBIDDEN, each part named) or that
 * gives nothing at all (BAD_REQUEST). The ONE check of every v2 door: the
 * consent, the re-consent, the app page and the short ask, and the
 * `app/connect` executor again at approval time.
 */
export async function assertAccessWithinCeiling(
  access: AppAccess,
  ceiling: AppAccessCeiling
): Promise<void> {
  const beyond = appAccessBeyond(access, ceiling);
  if (beyond.length > 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `You can only give this app what it asked for, where you may give it. Not on offer: ${await describeBeyond(beyond, ceiling)}.`,
    });
  }
  if (!appAccessGivesAnything(access)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Choose at least one place: a space or a project for what it reads or changes.",
    });
  }
}

/** What a re-consent shows, before naming: null when it holds v2 or nothing. */
function reconsentOf(
  approval: AppApproval,
  ceiling?: AppAccessCeiling | null
): {
  reason: ReconsentView["reason"];
  pairs: ReturnType<typeof pairsOfRequests>["pairs"];
  proposed: AppAccess;
} | null {
  if (!approval.approved || approval.access || approval.pairs.length === 0)
    return null;
  const lifted = liftApprovedRequests(approval.pairs, { examples: false });
  if ("access" in lifted) return null;
  const { pairs } = pairsOfRequests(approval.pairs);
  const candidate = candidateAccess(pairs);
  return {
    reason: lifted.reconsent.reason,
    pairs,
    proposed: ceiling ? clampAppAccess(candidate, ceiling) : candidate,
  };
}

/** The ids a re-consent names (its pairs and its proposal). */
function reconsentPlaceIds(r: NonNullable<ReturnType<typeof reconsentOf>>) {
  const proposed = accessPlaceIds(r.proposed);
  return {
    spaces: [
      ...r.pairs.flatMap((p) => (p.where.kind === "space" ? [p.where.id] : [])),
      ...proposed.spaces,
    ],
    projects: [
      ...r.pairs.flatMap((p) =>
        p.where.kind === "project" ? [p.where.id] : []
      ),
      ...proposed.projects,
    ],
  };
}

function reconsentViewWith(
  r: NonNullable<ReturnType<typeof reconsentOf>>,
  names: PlaceNames
): ReconsentView {
  const was: ReconsentWas[] = r.pairs.map((p) => {
    switch (p.where.kind) {
      case "space":
        return {
          permission: p.permission,
          place: {
            kind: "space",
            id: p.where.id,
            name: names.space(p.where.id).name,
          },
        };
      case "project":
        return {
          permission: p.permission,
          place: {
            kind: "project",
            id: p.where.id,
            name: names.project(p.where.id).name,
          },
        };
      default:
        return {
          permission: p.permission,
          place: { kind: "pod", id: null, name: EVERYWHERE_IN_POD },
        };
    }
  });
  return {
    reason: r.reason,
    was,
    proposed: nameAppAccessWith(r.proposed, names),
  };
}

/**
 * Why a connection asks again, named (Q3): its old pairs cannot become v2 as
 * they are. `was` lists them, each place named; `proposed` is the v2 form the
 * pairs suggest (`candidateAccess`), clamped to `ceiling` when given (the
 * screen's pre-fill). null when the connection holds a v2 access, or nothing.
 */
export async function reconsentViewOf(
  approval: AppApproval,
  ceiling?: AppAccessCeiling | null
): Promise<ReconsentView | null> {
  const r = reconsentOf(approval, ceiling);
  if (!r) return null;
  const ids = reconsentPlaceIds(r);
  return reconsentViewWith(r, await placeNames(ids.spaces, ids.projects));
}

/**
 * What a pod app connection asked, read from the document the pod holds
 * (the one the person consented to): every permission it declared, the
 * review verbs left out for an app that is not a Synap app (as the consent
 * screen's `appPermissions`). null when the pod holds no document for it.
 */
export async function askedOfConnection(app: {
  oauthClientId: string | null;
}): Promise<AccessAsked | null> {
  if (!app.oauthClientId) return null;
  const { findClient } = await import("../routers/oauth/store.js");
  const { grantsDecision } = await import("../routers/oauth/app-client.js");
  const client = await findClient(app.oauthClientId);
  if (!client || client.clientKind !== "cimd") return null;
  const synapApp = isSynapApp(client.clientId);
  return {
    permissions: client.requestedPermissions.filter(
      (p) => synapApp || !grantsDecision(p)
    ),
    podWide: client.requestedPodWide ?? [],
    reasons: client.requestedReasons ?? {},
    kindGroups: client.requestedKindGroups ?? [],
    templates: client.requestedTemplates ?? [],
  };
}

/** The asked access as frozen in an `app/connect` proposal (W3d). */
export interface FrozenAsked {
  permissions: string[];
  podWide: string[];
}

/** Read a frozen `askedAccess` back, or null when it is not one. */
export function readFrozenAsked(raw: unknown): FrozenAsked | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : null;
  const permissions = list(r.permissions);
  const podWide = list(r.podWide);
  return permissions && podWide ? { permissions, podWide } : null;
}

/**
 * The full consent and the re-consent, v2 (W3d): ONE act that files the pod
 * app's `app/connect` proposal carrying the person's v2 access AND approves
 * it as them, through the one approve door (`applyProposalApproval` → the
 * `app/connect` executor, which checks it again against the ceiling read at
 * approval time). The asked half is the pod's own (`asked`, re-derived from
 * the document), never the caller's; `access` (untrusted wire input) is
 * refused when anything is beyond `asked ∩ what the person may give`.
 *
 * The short ask (`add`): the proposal carries the permissions to ADD and,
 * Q4, the write place the person picked for a first write; the executor adds
 * them to the access as it stands then (`AppRepository.updateApprovedAccess`).
 */
export async function connectOAuthAppAccess(args: {
  ownerUserId: string;
  oauthClientId: string;
  name: string;
  asked: AccessAsked;
  /** The full consent: the person's choice. */
  access?: AppAccess;
  /** The short ask: the permissions to add, and Q4's write place. */
  add?: { permissions: readonly string[]; writePlace?: AccessWritePlace | null };
  ctx: Context;
  presenceChecked?: "oauth.consent";
}): Promise<{ appId: string; publicId: string; proposalId: string }> {
  assertOwnerCredential("connect an app", {
    agentUserId: args.ctx.agentUserId,
    keyType: args.ctx.keyType,
  });
  const offer = await appAccessOffer(args.ownerUserId, args.asked);
  const repo = new AppRepository(db);
  const existing = await db
    .select({ approvedRequests: apps.approvedRequests, approvedAccess: apps.approvedAccess, revokedAt: apps.revokedAt })
    .from(apps)
    .where(
      and(
        eq(apps.ownerUserId, args.ownerUserId),
        eq(apps.oauthClientId, args.oauthClientId),
        isNull(apps.revokedAt)
      )
    )
    .limit(1);
  let access: AppAccess;
  if (args.add) {
    const current = existing[0] ? appApprovalOf(existing[0]).access : null;
    if (!current) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Connect this app again first: its access must be confirmed before it can ask for more.",
      });
    }
    access = addedAccessOrThrow(current, args.add);
  } else {
    const parsed = parseAppAccess(args.access ?? null);
    if (!parsed) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "Choose what this app may do, and where (changes go in chosen places only).",
      });
    }
    access = parsed;
  }
  await assertAccessWithinCeiling(access, offer.ceiling);

  const app = await repo.registerOAuth({
    ownerUserId: args.ownerUserId,
    oauthClientId: args.oauthClientId,
    name: args.name,
  });
  const frozen: FrozenAsked = {
    permissions: [...offer.ceiling.permissions],
    podWide: [...args.asked.podWide],
  };
  // The old pairs ride along for every reader of a request (cards, timeline),
  // named; the v2 access is what the executor stores.
  const names = await placeNames(
    pairsOfAccess(access).pairs.flatMap((p) => (p.workspaceId ? [p.workspaceId] : [])),
    []
  );
  const requests = pairsOfAccess(access).pairs.map((r) => ({
    ...withAppRequestScope(r),
    workspaceName: r.workspaceId ? names.space(r.workspaceId).name : null,
  }));
  const proposal = await db.transaction((tx) =>
    createPendingProposal(
      {
        userId: args.ownerUserId,
        workspaceId: null,
        targetType: "app",
        targetId: app.id,
        proposalType: "connect",
        data: {
          appId: app.id,
          publicId: app.publicId,
          name: app.name,
          oauthClientId: args.oauthClientId,
          via: "oauth-consent",
          ...(args.add
            ? {
                mode: "add",
                addPermissions: [...args.add.permissions],
                ...(args.add.writePlace
                  ? {
                      writePlace: {
                        spaces: [...args.add.writePlace.spaces],
                        projects: [...args.add.writePlace.projects],
                      },
                    }
                  : {}),
              }
            : {}),
          access,
          askedAccess: frozen,
          requests,
        },
        agentUserId: null,
        createdBy: args.ownerUserId,
        proposedByUserId: args.ownerUserId,
        notificationDescription: `${app.name} is asking for access`,
      },
      tx as never
    )
  );
  await repo.withdrawPendingRequests(
    app.id,
    args.ownerUserId,
    { reason: "superseded", supersededBy: proposal.id },
    args.add ? "oauth-consent" : undefined
  );
  await recordAppEvent(
    { app } as AppWithGrants,
    args.ownerUserId,
    APP_EVENT_ACTIONS.requested,
    { proposalId: proposal.id, access, via: "oauth-consent" }
  );
  const [row] = await db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposal.id))
    .limit(1);
  const { applyProposalApproval } =
    await import("../routers/proposals/apply-approval.js");
  const result = await applyProposalApproval({
    proposal: row as never,
    userId: args.ownerUserId,
    input: { proposalId: proposal.id },
    ctx: args.ctx,
    presenceChecked: args.presenceChecked,
  });
  if (!result.success) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The connection could not be approved.",
    });
  }
  const { currentDocumentSha256 } =
    await import("../routers/oauth/app-client.js");
  const documentSha256 = await currentDocumentSha256(args.oauthClientId);
  if (documentSha256) await repo.setConsentedDocument(app.id, documentSha256);
  return { appId: app.id, publicId: app.publicId, proposalId: proposal.id };
}

/** `addPermissionsToAccess`, its refusals as the person reads them. */
export function addedAccessOrThrow(
  current: AppAccess,
  add: { permissions: readonly string[]; writePlace?: AccessWritePlace | null }
): AppAccess {
  const out = addPermissionsToAccess(current, add.permissions, add.writePlace);
  if ("access" in out) return out.access;
  if ("needsWritePlace" in out)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This app has nowhere to make changes yet: choose a space or a project for its first change.",
    });
  if ("writePlaceNotNeeded" in out)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This app already makes changes somewhere: its places do not change here.",
    });
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      "This app reads nowhere yet: connect it again to choose where it reads.",
  });
}

/** The app page's editor (`apps.accessOffer`, W3d): offer, current, re-consent. */
export async function appAccessEditor(args: {
  publicId: string;
  ownerUserId: string;
}): Promise<{
  asked: AccessOffer["asked"];
  places: AccessPlacesOffer;
  current: NamedAppAccess | null;
  reconsent: ReconsentView | null;
}> {
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const asked = await askedOfConnection(found.app);
  if (found.app.mode !== "oauth" || !asked) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Only a pod app's access is edited here; connect it again to change it.",
    });
  }
  const offer = await appAccessOffer(args.ownerUserId, asked);
  const approval = appApprovalOf(found.app);
  return {
    asked: offer.asked,
    places: offer.places,
    current: approval.access ? await nameAppAccess(approval.access) : null,
    reconsent: await reconsentViewOf(approval, offer.ceiling),
  };
}

/**
 * The app page edits a pod app's access (W3d, `apps.updateAccess`): the same
 * check as the consent (`assertAccessWithinCeiling`, the ceiling read now
 * from the document the pod holds and the person's places). Q2: it may WIDEN
 * within what the app asked, never beyond; anything else needs the app to
 * ask again. The person's own act, with proof of presence (it can widen a
 * credential): applied at once, v2 stored first. The live token stops now
 * (`revokeAppKeys`) and the next one carries the new access; the app's agent
 * follows the new spaces.
 */
export async function updateAppAccess(args: {
  publicId: string;
  ownerUserId: string;
  access: AppAccess;
  actorAgentUserId?: string | null;
  actorKeyType?: string | null;
  presence: PresencePass | null;
}): Promise<AppWithGrants> {
  assertPresencePass(args.presence, {
    actions: ["apps.updateAccess"],
    userId: args.ownerUserId,
  });
  assertOwnerCredential("change an app's access", {
    agentUserId: args.actorAgentUserId,
    keyType: args.actorKeyType,
  });
  const found = await loadOwnedApp(args.publicId, args.ownerUserId);
  assertNotRevoked(found);
  const asked = await askedOfConnection(found.app);
  if (found.app.mode !== "oauth" || !asked) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Only a pod app's access is edited here; connect it again to change it.",
    });
  }
  const offer = await appAccessOffer(args.ownerUserId, asked);
  const access = parseAppAccess(args.access);
  if (!access) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Choose what this app may do, and where (changes go in chosen places only).",
    });
  }
  await assertAccessWithinCeiling(access, offer.ceiling);
  const before = appApprovalOf(found.app);
  const repo = new AppRepository(db);
  const updated = await repo.setApprovedAccess(found.app.id, access);
  if (!updated) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not record the app's access.",
    });
  }
  await revokeAppKeys(
    found,
    args.ownerUserId,
    `Access changed for ${found.app.name}: the next token carries the new access`
  );
  if (found.app.agentUserId) {
    await syncAppAgentMemberships(
      found.app.agentUserId,
      found.app.ownerUserId,
      grantsForApp(updated, {
        allProjects: await allProjectsFor(found.app.ownerUserId, updated),
      })
    );
  }
  await recordAppEvent(found, args.ownerUserId, APP_EVENT_ACTIONS.approved, {
    via: "update",
    access,
    before: before.access,
  });
  return loadOwnedApp(args.publicId, args.ownerUserId);
}

/**
 * This person's live connection of this pod app, its approval read once
 * (`appApprovalOf`), or null when there is none (W3d).
 */
export async function currentOAuthAppApproval(
  ownerUserId: string,
  oauthClientId: string
): Promise<AppApproval | null> {
  const [row] = await db
    .select({
      approvedRequests: apps.approvedRequests,
      approvedAccess: apps.approvedAccess,
    })
    .from(apps)
    .where(
      and(
        eq(apps.ownerUserId, ownerUserId),
        eq(apps.oauthClientId, oauthClientId),
        isNull(apps.revokedAt)
      )
    )
    .limit(1);
  return row ? appApprovalOf(row) : null;
}
