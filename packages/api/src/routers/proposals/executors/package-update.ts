/**
 * The approval halves of an agent's package UPDATE that no other door owns:
 *  - `capability/capability.update`, filed by `POST /package-updates/{slug}/apply`
 *    for an agent key (`services/package-updates/apply-whole.ts`). (A space's
 *    update is filed through `proposeTemplateApply` and approved by
 *    `workspace/update`.)
 *  - `agentTemplate/update`, an agent's write of an installed agent template's
 *    fields, filed by its door's gate (`services/agent-templates/update.ts`).
 */

import { TRPCError } from "@trpc/server";
import { db } from "@synap/database";
import { registerProposalExecutor } from "../execution-registry.js";
import {
  assertApplied,
  reportApproved,
  storedProposalFields,
} from "./shared.js";
import type { Context } from "../../../types/context.js";
import {
  isPackageUpdateProposalApproved,
  markPackageUpdateProposalApproved,
} from "../../../services/package-updates/capability-update-proposal.js";

export function registerPackageUpdateExecutors(): void {
  // ── capability/capability.update — an agent's capability UPDATE ──────────
  // Filed by `POST /package-updates/{slug}/apply` for an agent key
  // (`services/package-updates/apply-whole.ts`): a capability reconcile is a
  // person's act. Approval runs the SAME apply a person runs on pod admin
  // (`applyWholeUpdateAsPerson`, the `capabilities.applyUpdates` engine) as the
  // APPROVER, for the version the agent saw: a catalog that moved since is
  // refused (asked again), an update already applied converges.
  registerProposalExecutor({
    key: "capability/capability.update",
    // The reconcile may write a capability's grants: never from a stale
    // device session (the tRPC `applyUpdate` door is fresh-auth too).
    widensCredential: true,
    async execute({ proposal, userId, input, deps }) {
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const slug = typeof data.slug === "string" ? data.slug : undefined;
      const toVersion =
        typeof data.toVersion === "string" ? data.toVersion : undefined;
      if (!slug || !toVersion) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "capability.update requires slug and toVersion",
        });
      }
      if (await isPackageUpdateProposalApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      const [{ listInstalledPackages }, whole] = await Promise.all([
        import("../../../services/package-updates/standing.js"),
        import("../../../services/package-updates/apply-whole.js"),
      ]);
      const pkg = (await listInstalledPackages()).find(
        (p) => p.slug === slug && p.kind === "capability"
      );
      if (!pkg) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `The capability "${slug}" is no longer installed on this pod.`,
        });
      }
      // Converged meanwhile (a person applied it): nothing left to run.
      let warning: string | undefined;
      if (pkg.hasUpdate !== false) {
        whole.assertUpdateStillWaits(pkg, toVersion);
        const applied = await whole.applyWholeUpdateAsPerson(userId, pkg, {
          expectedVersion: toVersion,
        });
        if (applied.status === "applied") warning = applied.warning;
      }

      await markPackageUpdateProposalApproved(input.proposalId, userId);
      reportApproved(deps, proposal, input.proposalId);
      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, ...(warning ? { refusals: [warning] } : {}) };
    },
  });

  // ── agentTemplate/update — an agent's write of an agent template ─────────
  // Approval replays the same door as the APPROVER (a person): the
  // `wake.program` refusal and the spec check run again on the row as it is
  // now, and only the proposed fields are written.
  registerProposalExecutor({
    key: "agentTemplate/update",
    async execute({ proposal, userId, input, deps }) {
      const fields = storedProposalFields(proposal);
      const id =
        (typeof fields.id === "string" ? fields.id : undefined) ??
        proposal.targetId;
      if (!id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "agentTemplate.update requires the template id",
        });
      }
      if (await isPackageUpdateProposalApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      const { updateAgentTemplate } =
        await import("../../../services/agent-templates/update.js");
      const { metadata, ...columns } = fields;
      // The replay must APPLY, never re-propose.
      assertApplied(
        await updateAgentTemplate(
          {
            db,
            authenticated: true,
            userId,
            workspaceId: null,
          } as unknown as Context,
          {
            id,
            fields: columns,
            ...(metadata && typeof metadata === "object"
              ? { metadata: metadata as Record<string, unknown> }
              : {}),
          }
        )
      );

      await markPackageUpdateProposalApproved(input.proposalId, userId);
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
