import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  getWorkspaceMembership,
  transitionProposal,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { RendererRef, RendererSurface } from "@synap/database";
import { profilesRouter } from "../../profiles.js";
import { setProfileRenderer } from "../../../services/profiles/set-profile-renderer.js";
import type {
  RendererScope,
  RendererSlot,
} from "../../../services/profiles/renderer-slots.js";
import type { Context } from "../../../context.js";
import { readDuplicateCheck } from "@synap-core/types/proposals";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import { createLogger } from "@synap-core/core";
import {
  createAndLinkPropertyDef,
  type CreateAndLinkPropertyDefInput,
  type CreateAndLinkPropertyDefResult,
} from "../../../services/profiles/create-and-link-property-def.js";
import { ProposedKindFieldSchema } from "../../../services/profiles/proposed-kind-field.js";

const logger = createLogger({ module: "proposal-approve-executors-profile" });

/** Idempotency: approve is not status-guarded before dispatch. */
async function alreadyApproved(proposalId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

async function markApproved(proposalId: string, userId: string) {
  await transitionProposal(db, {
    to: ProposalStatus.APPROVED,
    set: {
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    },
    where: eq(proposals.id, proposalId),
  });
}

/** One carried field of an approved kind: created, or refused with why. */
export interface KindFieldOutcome {
  slug: string | null;
  outcome: "created" | "refused";
  reason?: string;
  /** The slug matched a pod-wide field: reused, or the kind got its own. */
  globalField?: CreateAndLinkPropertyDefResult["globalField"];
}

/**
 * Create an approved kind AND its fields, as the approver: the
 * `profile/create` executor's apply, shared with a plan's `define_kind` op.
 * Through the SAME `profilesRouter.create` the direct path uses (no agent ⇒
 * the re-entrant gate grants), the proposal owning the row. `existing` = the
 * slug-idempotent door returned a kind that was already there; its fields are
 * refused, never attached to someone's kind.
 */
export async function materializeKindCreate(args: {
  userId: string;
  workspaceId: string;
  proposalId: string;
  agentAuthored: boolean;
  duplicateReviewed: boolean;
  profile: {
    slug: string;
    displayName: string;
    parentProfileId?: string;
    uiHints?: Record<string, unknown>;
    defaultValues?: Record<string, unknown>;
    scope?: "system" | "shared" | "workspace" | "user";
    entityScope?: "pod" | "workspace";
    profileKind?: "kind" | "role";
    applicableKinds?: string[];
    roleCategory?: string;
  };
  kindFields: unknown[];
}): Promise<{
  profileId: string | undefined;
  slug: string | undefined;
  existing: boolean;
  /** The existing kind's owner, when `existing` (a retry finds its own). */
  existingOwnerId: string | null;
  fieldOutcomes: KindFieldOutcome[];
}> {
  const { userId, workspaceId } = args;
  const membership = await getWorkspaceMembership(db, workspaceId, userId);
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No workspace access",
    });
  }
  const profileCaller = profilesRouter.createCaller({
    db,
    authenticated: true as const,
    userId,
    workspaceId,
    workspaceRole: membership.role,
    // Provenance (0263): server-only ctx, never tRPC input. The kind is the
    // PROPOSAL's — agent-authored when an agent filed it — and the proposal
    // owns the row (retire-on-revert lineage).
    profileProvenance: {
      origin: args.agentAuthored ? "agent" : "authored",
      ownerKind: "proposal",
      ownerId: args.proposalId,
    },
    duplicateReviewed: args.duplicateReviewed,
  } as unknown as Context);
  const result = await profileCaller.create(args.profile);
  // The approver IS the authority — the re-entrant gate should auto-grant.
  // A nested proposal means the approver lacks profile.create rights; surface
  // it rather than reporting a kind nobody built.
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "proposed"
  ) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Profile approval unexpectedly re-proposed",
    });
  }

  const replayed = result as {
    profile?: { id?: string; slug?: string; ownerId?: string | null } | null;
    existing?: boolean;
  } | null;
  const existing = replayed?.existing === true;
  const createdProfileId = existing ? undefined : replayed?.profile?.id;
  // Each field is CHECKED AGAIN here, not trusted from when it was filed: a
  // proposal can sit for days, and a stored payload is data. A field that no
  // longer passes is REPORTED, never silently dropped.
  const fieldOutcomes: KindFieldOutcome[] = [];
  const slugOf = (raw: unknown): string | null =>
    raw &&
    typeof raw === "object" &&
    typeof (raw as { slug?: unknown }).slug === "string"
      ? (raw as { slug: string }).slug
      : null;
  if (existing) {
    for (const raw of args.kindFields) {
      fieldOutcomes.push({
        slug: slugOf(raw),
        outcome: "refused",
        reason:
          "the kind already exists, so the approval created nothing to attach it to; add it with define_kind",
      });
    }
  }
  if (createdProfileId) {
    for (const raw of args.kindFields) {
      const parsed = ProposedKindFieldSchema.safeParse(raw);
      if (!parsed.success) {
        fieldOutcomes.push({
          slug: slugOf(raw),
          outcome: "refused",
          reason: parsed.error.issues
            .map((i) => `${i.path.join(".") || "field"}: ${i.message}`)
            .join("; "),
        });
        continue;
      }
      const field = parsed.data;
      try {
        const written = await createAndLinkPropertyDef({
          userId,
          workspaceId,
          profileId: createdProfileId,
          slug: field.slug,
          valueType:
            field.valueType as CreateAndLinkPropertyDefInput["valueType"],
          constraints: field.constraints,
          uiHints: field.uiHints,
          overlay: field.overlay === true,
          required: field.required,
          defaultValue: field.defaultValue,
          displayOrder: field.displayOrder,
        });
        fieldOutcomes.push({
          slug: field.slug,
          outcome: "created",
          ...(written?.globalField ? { globalField: written.globalField } : {}),
        });
      } catch (err) {
        // One field never undoes the kind or its siblings.
        fieldOutcomes.push({
          slug: field.slug,
          outcome: "refused",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (fieldOutcomes.some((o) => o.outcome === "refused")) {
    logger.warn(
      { proposalId: args.proposalId, fieldOutcomes },
      "kind create approval: carried field(s) refused (kind kept)"
    );
  }
  return {
    profileId: replayed?.profile?.id,
    slug: replayed?.profile?.slug,
    existing,
    existingOwnerId: existing ? (replayed?.profile?.ownerId ?? null) : null,
    fieldOutcomes,
  };
}

/** Register the profile/* approve executors. */
export function registerProfileExecutors(): void {
  // ── profile / create ─────────────────────────────────────────────────────────
  // A gated createProfile (agent-authored, or a member whose role lacks
  // `create`) lands here on approval. Without this executor the `*/*` catch-all
  // threw NOT_IMPLEMENTED (the flat profile payload is not request-shaped) and
  // the proposal could never materialize. Materializes via the SAME
  // profilesRouter.create the direct path uses — re-run as the APPROVER (no
  // agentUserId ⇒ the re-entrant gate auto-grants for the operator authority),
  // so audit / events / the workspace bento + sidebar side-effects match the
  // direct create exactly. Mirrors view/create's caller construction +
  // idempotency guard. profiles.create is idempotent on slug, so a re-approve
  // returns the existing profile rather than a second row.
  //
  // CONSERVATIVE NOTE: the propose gate (profiles.create) stores only
  // { id, slug, displayName, parentProfileId, uiHints, defaultValues, scope,
  // entityScope, profileKind, applicableKinds, roleCategory } — so
  // `allowedWorkspaceIds` (the
  // extra shared-scope grants) is NOT carried through and defaults to none here.
  // Widening it would require widening that gate `data` (flagged for review).
  registerProposalExecutor({
    key: "profile/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const slug = innerData.slug as string | undefined;
      const displayName = innerData.displayName as string | undefined;
      if (!slug || !displayName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Profile proposal is missing slug/displayName",
        });
      }
      const workspaceId = proposal.workspaceId ?? null;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Profile creation proposal is missing a valid workspaceId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch, so skip if
      // this proposal was already materialized (createCaller mints a fresh id
      // each run — profiles.create is slug-idempotent, but the status guard
      // avoids re-running the workspace side-effects on a re-approve).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const { fieldOutcomes } = await materializeKindCreate({
        userId,
        workspaceId,
        proposalId: input.proposalId,
        agentAuthored: !!proposal.agentUserId,
        // The reviewer was SHOWN the existing kinds (the duplicate door's
        // answer rides this proposal, B2): approving is their "keep both", so
        // the replay's twin check stands down. A legacy row filed with the
        // agent's old `forceCreate` judgement (before B2) keeps it.
        duplicateReviewed:
          readDuplicateCheck(proposal.data)?.status === "possible" ||
          innerData.forceCreate === true,
        profile: {
          slug,
          displayName,
          parentProfileId: innerData.parentProfileId as string | undefined,
          uiHints: innerData.uiHints as Record<string, unknown> | undefined,
          defaultValues: innerData.defaultValues as
            Record<string, unknown> | undefined,
          scope: innerData.scope as
            "system" | "shared" | "workspace" | "user" | undefined,
          entityScope: innerData.entityScope as "pod" | "workspace" | undefined,
          profileKind: innerData.profileKind as "kind" | "role" | undefined,
          applicableKinds: innerData.applicableKinds as string[] | undefined,
          roleCategory: innerData.roleCategory as string | undefined,
        },
        kindFields: Array.isArray(innerData.kindFields)
          ? innerData.kindFields
          : [],
      });

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          ...(fieldOutcomes.length > 0
            ? {
                data: {
                  ...((proposal.data as Record<string, unknown> | null) ?? {}),
                  fieldOutcomes,
                },
              }
            : {}),
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      // The honest partial shape: the kind landed, these fields did not.
      const refusals = fieldOutcomes.flatMap((o) =>
        o.outcome === "refused"
          ? [
              `Field "${o.slug ?? "?"}" was not created: ${o.reason ?? "refused"}`,
            ]
          : []
      );
      return {
        success: true,
        ...(refusals.length > 0 ? { refusals } : {}),
      };
    },
  });

  // ── profile / renderer.set ──────────────────────────────────────────────────
  // Materializes an approved "bind a cell as a profile renderer" proposal via
  // the SAME shared write path the governed Hub route uses on operator
  // auto-apply. Without this the proposal would fall to the `*/*` catch-all,
  // which emits a `.validated` event but never writes the renderer.
  registerProposalExecutor({
    key: "profile/renderer.set",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const profileSlug = innerData.profileSlug as string | undefined;
      // Read as the exported `RendererSlot`, not a re-typed literal union — a
      // hand-copied union here would silently mis-declare any slot added later
      // (`card`) while the runtime value flowed through unchanged.
      const slot = innerData.slot as RendererSlot | undefined;
      const ref = innerData.ref as RendererRef | null | undefined;
      // Read as the exported `RendererScope`, same reasoning as `slot` above —
      // a re-typed literal union here would silently drop `user`.
      const scope =
        (innerData.scope as RendererScope | undefined) ?? "workspace";
      // A per-object binding (the GOVERNED EXCEPTION) arrives here the same way
      // a kind-level one does: as an approved proposal. `null` = whole kind.
      const subjectId =
        (innerData.subjectId as string | null | undefined) ?? null;
      // WHICH HOST renders it. Proposals stored before 0299 carry no surface:
      // absent ⇒ the in-app default. Dropping this would silently write an
      // approved `mcp-app` proposal to the IN-APP surface.
      const surface =
        (innerData.surface as RendererSurface | undefined) ?? "app";
      if (!profileSlug || !slot || ref === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Renderer proposal is missing profileSlug/slot/ref",
        });
      }

      // Idempotency: skip if already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      await setProfileRenderer({
        userId,
        workspaceId: proposal.workspaceId,
        profileSlug,
        slot,
        ref,
        scope,
        subjectId,
        surface,
        // Lineage: the binding row records the proposal that minted it, the
        // same `source_proposal_id` trail `governance_rules` keeps for a rule
        // born of an approved widening.
        sourceProposalId: input.proposalId,
      });

      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });

  // ── profile / grant_access ──────────────────────────────────────────────────
  // Filed by `profilesRouter.grantAccess` (R8a) — ADMIN-floored
  // (`profile.grant_access`), so an agent's grant always lands here. REPLAY
  // through the same procedure as the APPROVER, acting in the proposal's
  // workspace: `resolveProfile` + the shared-scope check + the home-workspace
  // `assertProfileSchemaWrite` floor all re-run NOW (a proposal can sit for
  // days). The re-entrant gate grants the human approver; `assertApplied`
  // refuses a re-proposal instead of flipping APPROVED with nothing granted.
  //
  // PAYLOAD: `data: { profileId, targetWorkspaceId, slug, displayName }`
  // (nested as `data.data`).
  registerProposalExecutor({
    key: "profile/grant_access",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const profileId = inner.profileId;
      const targetWorkspaceId = inner.targetWorkspaceId;
      const workspaceId = proposal.workspaceId ?? null;
      if (
        typeof profileId !== "string" ||
        typeof targetWorkspaceId !== "string" ||
        !workspaceId
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Profile access proposal is missing profileId, targetWorkspaceId or its workspace",
        });
      }

      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const profileCaller = profilesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      const result = await profileCaller.grantAccess({
        profileId,
        targetWorkspaceId,
      });
      // The approver IS the authority — a nested proposal means the approver's
      // role cannot execute the grant. Surface it rather than flipping APPROVED
      // with nothing granted (same guard as `assertApplied`, inlined like
      // profile/create above).
      if (result.status === "proposed") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Approval could not be applied: your workspace role cannot execute this write, so re-running it only filed another proposal. Ask a workspace admin or owner to approve.",
        });
      }

      await markApproved(input.proposalId, userId);

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: profileId };
    },
  });

  // ── profile / change_scope ──────────────────────────────────────────────────
  // Filed by `changeKindScope` (D13, `services/profiles/change-kind-scope.ts`)
  // — ADMIN-floored and `forcePropose`d, so an agent's scope change always
  // lands here. REPLAY through `profilesRouter.update` as the APPROVER, acting
  // in the proposal's workspace: the owner / pod-admin gate, the grant
  // revocation on leaving "shared", the grants on entering it and the
  // resolution-cache invalidation all re-run NOW (a proposal can sit for days).
  // `profiles.update` files no proposal, so a caller without authority throws
  // FORBIDDEN instead of flipping APPROVED with nothing changed.
  //
  // PAYLOAD: `data: { profileId, slug, displayName, scope?, fromScope?,
  // allowedWorkspaceIds?, entityScope?, fromEntityScope? }` (nested as
  // `data.data`).
  registerProposalExecutor({
    key: "profile/change_scope",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const profileId = inner.profileId;
      const workspaceId = proposal.workspaceId ?? null;
      const scope =
        inner.scope === "shared" || inner.scope === "workspace"
          ? inner.scope
          : undefined;
      const entityScope =
        inner.entityScope === "pod" || inner.entityScope === "workspace"
          ? inner.entityScope
          : undefined;
      const allowedWorkspaceIds = Array.isArray(inner.allowedWorkspaceIds)
        ? inner.allowedWorkspaceIds.filter(
            (id): id is string => typeof id === "string"
          )
        : undefined;
      if (typeof profileId !== "string" || !workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Kind scope proposal is missing profileId or its workspace",
        });
      }
      if (
        scope === undefined &&
        entityScope === undefined &&
        !allowedWorkspaceIds?.length
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Kind scope proposal carries no change",
        });
      }

      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      const membership = await getWorkspaceMembership(db, workspaceId, userId);
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const profileCaller = profilesRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId,
        workspaceRole: membership.role,
      } as unknown as Context);
      // Grants ride only with `shared` — the same rule the door enforced.
      await profileCaller.update({
        id: profileId,
        ...(scope !== undefined || allowedWorkspaceIds?.length
          ? { scope: scope ?? "shared" }
          : {}),
        ...(allowedWorkspaceIds?.length ? { allowedWorkspaceIds } : {}),
        ...(entityScope !== undefined ? { entityScope } : {}),
      });

      await markApproved(input.proposalId, userId);

      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: profileId };
    },
  });
}
