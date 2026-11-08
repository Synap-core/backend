/**
 * `installation/request` — an agent asked for a capability on one of the
 * person's computers (`POST /installations/request`; reconciliation f75fbb48
 * §3.4, decision 168f34db §2). Approving records the asked state AS the
 * approver, who must own the computer (the computer is the row's target, set
 * at filing), and the reconciler queues the one job it calls for. The
 * computer's runner then leases and runs it. Re-approving does nothing.
 *
 * Approval needs a fresh sign-in (installing on a person's machine is a
 * commitment: the default the reconciliation §3.4 names, overridable):
 * `widensCredential` makes the dispatch refuse a Synap app's device session
 * (`assertFreshAuthentication`), so it is approved on the console. It mints
 * no key today; a `service` installation will (plan 64072312 U6).
 */

import { TRPCError } from "@trpc/server";
import { db, proposals, eq, transitionProposal } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  applyInstallationRequest,
  INSTALLATION_REQUEST_ACTIONS,
  installRefusal,
  isInstallationRequestApproved,
  loadInstallableCapability,
  loadPersonsComputer,
} from "../../../services/installations/installations.js";
import {
  registerProposalExecutor,
  attachFailureMeta,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";

function cannotApply(message: string) {
  return attachFailureMeta(
    new TRPCError({ code: "PRECONDITION_FAILED", message }),
    { errorClass: "conflict" }
  );
}

export function registerInstallationExecutors(): void {
  registerProposalExecutor({
    key: "installation/request",
    widensCredential: true,
    async execute({ proposal, payload, userId, input, deps }) {
      if (await isInstallationRequestApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const data = (payload ?? {}) as Record<string, unknown>;
      const computerId = String(proposal.targetId ?? data.computerId ?? "");
      const action = data.action;
      const capabilityKey =
        typeof data.capabilityKey === "string" ? data.capabilityKey : "";
      const computer = computerId
        ? await loadPersonsComputer(userId, computerId)
        : null;
      if (
        !computer ||
        !(INSTALLATION_REQUEST_ACTIONS as readonly unknown[]).includes(
          action
        ) ||
        action === "verify"
      ) {
        throw cannotApply(
          "Couldn't apply — this computer is not yours, or it is no longer connected. Nothing was asked of it."
        );
      }
      const capability = await loadInstallableCapability(capabilityKey);
      if (!capability)
        throw cannotApply(
          `Couldn't apply — ${capabilityKey} is no longer a capability this pod can install. Nothing was asked of the computer.`
        );
      if (action !== "remove") {
        const refusal = installRefusal(capability, computer);
        if (refusal) throw cannotApply(`Couldn't apply — ${refusal}`);
      }
      const out = await applyInstallationRequest({
        computer,
        capability,
        action: action as "install" | "update" | "remove",
        version: typeof data.version === "string" ? data.version : null,
        approverId: userId,
        proposalId: input.proposalId,
      });
      await transitionProposal(db, {
        to: ProposalStatus.APPROVED,
        set: {
          data: {
            ...data,
            applied: {
              installationId: out.installation.id,
              jobId: out.jobId,
            },
          } as unknown as typeof payload,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
        where: eq(proposals.id, input.proposalId),
      });
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
