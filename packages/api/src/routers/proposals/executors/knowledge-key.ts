import { TRPCError } from "@trpc/server";
import { knowledgeKeysRepository } from "@synap/database";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import {
  isKnowledgeKeyProposalApproved,
  markKnowledgeKeyProposalApproved,
} from "../../../services/knowledge/knowledge-key-proposal.js";

/** Register the knowledgeKey/* approve executors. */
export function registerKnowledgeKeyExecutors(): void {
  // ── knowledgeKey / create ────────────────────────────────────────────────
  // The approval half of `POST /knowledge` (S6, 2026-10-20). NO PROCEDURE TO
  // REPLAY: the direct path is `knowledgeKeysRepository.create` in the REST
  // handler (`hub-protocol/rest/knowledge.ts`), so this mirrors it with the
  // payload the gate stored — the same fields, the same defaults.
  registerProposalExecutor({
    key: "knowledgeKey/create",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;
      const key = inner.key as string | undefined;
      if (!key) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Knowledge proposal is missing its key",
        });
      }

      // Idempotency: a re-approve must not try to create the key twice.
      if (await isKnowledgeKeyProposalApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      await knowledgeKeysRepository.create({
        key,
        value: (inner.value as string | undefined) ?? "",
        status: (inner.status as string | undefined) ?? "active",
        workspaceId: (inner.workspaceId as string | undefined) || undefined,
        // The direct path records the caller's author; the agent wrote it, the
        // human only approved it.
        author:
          (inner.author as string | undefined) ||
          proposal.agentUserId ||
          userId,
      });

      await markKnowledgeKeyProposalApproved(input.proposalId, userId);

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
