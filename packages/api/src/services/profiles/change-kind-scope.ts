/**
 * Change a kind's SCOPE — the agent door to `scope` / `allowedWorkspaceIds` /
 * `entityScope` (D13, ticket 65e145cc).
 *
 * The human door has always existed: tRPC `profiles.update`, gated on the
 * profile's owner (or pod admin for a pod-owned kind). Agents had none —
 * `synap_define_kind` is slug-idempotent and never rewrites a stored kind — so
 * a workspace-scoped kind that another space needed could not even be asked
 * for.
 *
 * NOTHING is re-implemented here. The door resolves the kind in the acting
 * workspace (the same `resolveProfile` the procedure uses), files the change
 * through `checkPermissionOrPropose` (`profile/change_scope`, ADMIN-floored and
 * `forcePropose`d — an agent ALWAYS proposes), and a granted human call goes
 * straight to `profilesRouter.update`. Approval replays that same procedure as
 * the approver (`routers/proposals/executors/profile.ts`), so the owner /
 * pod-admin gate, the grant revocation on leaving "shared", the grants on
 * entering it and the cache invalidation all run in ONE place.
 *
 * What a change does NOT do: existing records keep their `workspaceId`
 * (`entityScope: "pod"` affects new records only), and twin kinds stay twins.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, profiles, ProfileResolutionService } from "@synap/database";
import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import { profilesRouter } from "../../routers/profiles.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import type { WorkspaceOpsActor } from "../workspace-ops-doors.js";

export interface ChangeKindScopeInput {
  profileId: string;
  /** `shared` makes the kind resolvable in granted spaces; `workspace` pins it home. */
  scope?: "shared" | "workspace";
  /** With `scope: "shared"`: the extra spaces granted access (home is always kept). */
  allowedWorkspaceIds?: string[];
  /** Whether NEW records of this kind are pod-wide or stay in one space. */
  entityScope?: "pod" | "workspace";
  /** The acting lens; omitted ⇒ the kind's home workspace. */
  workspaceId?: string;
  reasoning?: string;
}

export type ChangeKindScopeResult =
  | {
      status: "proposed";
      proposalId: string;
      proposalType?: string;
      message: string;
    }
  | { status: "unchanged"; message: string }
  | {
      status: "updated";
      profile: { id: string; slug: string; scope: string; entityScope: string };
    };

export async function changeKindScope(
  actor: WorkspaceOpsActor,
  input: ChangeKindScopeInput
): Promise<ChangeKindScopeResult> {
  if (
    input.scope === undefined &&
    input.entityScope === undefined &&
    input.allowedWorkspaceIds === undefined
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Provide scope, allowedWorkspaceIds and/or entityScope",
    });
  }
  // `profiles.update` grants `allowedWorkspaceIds` only while setting
  // `shared` — anything else would be a silent no-op on approval.
  if (input.allowedWorkspaceIds?.length && input.scope !== "shared") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        'allowedWorkspaceIds needs scope: "shared". To share an already-shared kind with one more space, use grant_profile_access.',
    });
  }

  let actingWorkspaceId = input.workspaceId ?? null;
  if (!actingWorkspaceId) {
    const [row] = await db
      .select({ workspaceId: profiles.workspaceId })
      .from(profiles)
      .where(eq(profiles.id, input.profileId))
      .limit(1);
    actingWorkspaceId = row?.workspaceId ?? null;
  }
  if (!actingWorkspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This kind has no home space: pass workspaceId (the space you act in).",
    });
  }

  const existing = await new ProfileResolutionService(db).resolveProfile(
    input.profileId,
    actor.userId,
    actingWorkspaceId
  );
  if (!existing) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Profile not found: ${input.profileId}`,
    });
  }

  const scopeChanges =
    input.scope !== undefined && input.scope !== existing.scope;
  const entityScopeChanges =
    input.entityScope !== undefined &&
    input.entityScope !== existing.entityScope;
  const grants = (input.allowedWorkspaceIds ?? []).filter(
    (id) => id !== existing.workspaceId
  );
  if (!scopeChanges && !entityScopeChanges && grants.length === 0) {
    return {
      status: "unchanged",
      message: `Kind "${existing.slug}" already has that scope.`,
    };
  }

  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId: actingWorkspaceId,
    subjectType: "profile",
    action: "change_scope",
    // Which spaces see a kind is the person's call — never auto-applied for an
    // agent, whatever a rule says (honoured on the AI paths only).
    forcePropose: true,
    reasoning: input.reasoning,
    data: {
      profileId: existing.id,
      slug: existing.slug,
      displayName: existing.displayName,
      ...(scopeChanges
        ? { scope: input.scope, fromScope: existing.scope }
        : {}),
      ...(grants.length > 0 ? { allowedWorkspaceIds: grants } : {}),
      ...(entityScopeChanges
        ? {
            entityScope: input.entityScope,
            fromEntityScope: existing.entityScope,
          }
        : {}),
    },
  });
  if ("denied" in perm && perm.denied) {
    throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
  }
  if ("granted" in perm && !perm.granted) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      proposalType: perm.proposalType,
      message: proposedMessageFor(
        perm.proposalType,
        "Changing which spaces see this kind requires approval."
      ),
    };
  }

  const ctx = await createHubProtocolCallerContext(
    actor.userId,
    actor.scopes,
    actingWorkspaceId,
    undefined,
    actor.sessionId ?? null,
    actor.agentUserId ?? null,
    actor.keyType ?? null,
    actor.keyWorkspaceId ?? null
  );
  const { profile } = await profilesRouter.createCaller(ctx).update({
    id: existing.id,
    ...(scopeChanges || grants.length > 0 ? { scope: input.scope } : {}),
    ...(grants.length > 0 ? { allowedWorkspaceIds: grants } : {}),
    ...(entityScopeChanges ? { entityScope: input.entityScope } : {}),
  });
  return {
    status: "updated",
    profile: {
      id: profile.id,
      slug: profile.slug,
      scope: profile.scope,
      entityScope: profile.entityScope,
    },
  };
}
