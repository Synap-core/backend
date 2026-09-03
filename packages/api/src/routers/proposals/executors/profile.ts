import { TRPCError } from "@trpc/server";
import { db, proposals, eq, getWorkspaceMembership } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { RendererRef } from "@synap/database";
import { profilesRouter } from "../../profiles.js";
import { setProfileRenderer } from "../../../services/profiles/set-profile-renderer.js";
import type {
  RendererScope,
  RendererSlot,
} from "../../../services/profiles/renderer-slots.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

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
  // entityScope, profileKind, applicableKinds } — so `allowedWorkspaceIds` (the
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
      const result = await profileCaller.create({
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
      });
      // The approver IS the authority — the re-entrant gate should auto-grant.
      // A nested proposal means the approver lacks profile.create rights; surface
      // it rather than silently flipping the proposal APPROVED with nothing built
      // (mirrors the skill/create executor's guard below).
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

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

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
        // Lineage: the binding row records the proposal that minted it, the
        // same `source_proposal_id` trail `governance_rules` keeps for a rule
        // born of an approved widening.
        sourceProposalId: input.proposalId,
      });

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

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
}
