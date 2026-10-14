/**
 * Workspace Creation Service
 *
 * The one-space-per-domain verdict and the Hub create allow-list. Creating,
 * re-syncing or adopting a space is the one template apply
 * (`template-apply/`): W4 retired the idempotent-create wrapper and
 * `reconcileWorkspaceIfStale` once their last callers moved onto it.
 */
import {
  db,
  drizzleSql,
  workspaceMembers,
  workspaces,
  and,
  eq,
  isNull,
  or,
  findWorkspaceIdentityConflict,
} from "@synap/database";
import { oneSpacePerDomainGuidance } from "./one-space-per-domain.js";
import {
  findLegacyWorkspaceMatch,
  findWritableKeyHolder,
} from "./template-apply/resolve-target.js";

/*
 * NAMED INSTANCES are retired (0308, founder 2026-10-06): a template is
 * installed ONCE per pod — `workspaces_active_package_slug_unique` makes a
 * second active copy impossible — so there is no `<slug>:<name>` key any more.
 * The doors that accepted an instance name answer 400.
 */

/**
 * ONE SPACE PER DOMAIN — the create-time verdict (rule text:
 * `one-space-per-domain.ts`). Every create door that can mint a space calls
 * this BEFORE governance, so a second space of a domain is refused instead of
 * becoming a proposal the user must decline — for EVERY caller, human or
 * agent (founder 2026-10-06: no duplicate spaces, no user link).
 *
 * What is left for this check after 0308: name and template identity are
 * enforced pod-wide by the database and the idempotent create (an exact
 * holder is REUSED, or refused as a typed 409 when the caller cannot write
 * it). This catches the remaining twin — a live space of the same DOMAIN that
 * does not hold the template slug: one whose `workspaceSubtype` or
 * provisioning key names the template (e.g. a copy 0308 detached).
 *   - reuse (key hit, pod-wide identity holder, legacy match) → `create`
 *     (the idempotent create reuses; nothing new is minted);
 *   - a domain twin the caller can see → `refuse` with the typed
 *     `{status:"exists"}` reply;
 *   - otherwise → `create`.
 */
export type OneSpacePerDomainVerdict =
  | { action: "create" }
  | {
      action: "refuse";
      reply: {
        status: "exists";
        workspaceId: string;
        workspaceName: string;
        matchedBy: "template";
        guidance: string;
      };
    };

export async function checkOneSpacePerDomain(input: {
  userId: string;
  packageSlug?: string;
  /** The idempotency key the create would use (the slug, for a template). */
  idempotencyKey?: string;
  workspaceName?: string;
}): Promise<OneSpacePerDomainVerdict> {
  const { userId, packageSlug, idempotencyKey } = input;

  // Would this request REUSE? Then it mints nothing — never refuse a reinstall.
  if (idempotencyKey && (await findWritableKeyHolder(userId, idempotencyKey)))
    return { action: "create" };
  // A pod-wide identity holder: the idempotent create reuses it (or refuses
  // with the typed 409) — never a second space either way.
  if (
    await findWorkspaceIdentityConflict(db, {
      packageSlug: packageSlug ?? null,
      name: packageSlug ? null : (input.workspaceName ?? null),
    })
  ) {
    return { action: "create" };
  }
  if (!packageSlug) return { action: "create" };
  if (await findLegacyWorkspaceMatch(packageSlug, userId)) {
    return { action: "create" };
  }

  const instancePrefix = `${packageSlug}:`;
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      ownerId: workspaces.ownerId,
      createdAt: workspaces.createdAt,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id)
    )
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        isNull(workspaces.archivedAt),
        or(
          eq(workspaces.provisioningProposalId, packageSlug),
          drizzleSql`left(${workspaces.provisioningProposalId}, ${instancePrefix.length}) = ${instancePrefix}`,
          drizzleSql`${workspaces.settings}->>'workspaceSubtype' = ${packageSlug}`
        )
      )
    );
  const existing = pickExisting(rows, userId);
  if (!existing) return { action: "create" };
  return {
    action: "refuse",
    reply: {
      status: "exists",
      workspaceId: existing.id,
      workspaceName: existing.name,
      matchedBy: "template",
      guidance: oneSpacePerDomainGuidance({
        workspaceId: existing.id,
        name: existing.name,
      }),
    },
  };
}

/** Deterministic: owned first, then the OLDEST (the original domain space). */
function pickExisting(
  rows: Array<{ id: string; name: string; ownerId: string; createdAt: Date }>,
  userId: string
): { id: string; name: string } | undefined {
  const sorted = [...rows].sort((a, b) => {
    const ao = a.ownerId === userId ? 1 : 0;
    const bo = b.ownerId === userId ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0];
}

/**
 * Allow-list of agentTypes that may call the Hub Protocol REST workspace
 * creation endpoint. Other agentTypes get 403. Easy to extend by adding
 * a new entry below.
 */
export const WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST: ReadonlyArray<string> = [
  "eve",
  "coder",
];

export function isAgentTypeAllowedToCreateWorkspaces(
  agentType: string | null | undefined
): boolean {
  if (!agentType) return false;
  return WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST.includes(agentType);
}
