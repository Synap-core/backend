import { TRPCError } from "@trpc/server";
import { db, proposals, eq, and, isNull } from "@synap/database";
import { secrets, ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import {
  applyVaultSecretGrant,
  type VaultSecretGrantScope,
} from "../../../services/vault-secret-grant.js";

const SCOPES: readonly VaultSecretGrantScope[] = [
  "once",
  "session",
  "permanent",
];

/**
 * Approve-executor for `vault/grant` — the approval half of POST
 * /vault/secrets/:id/grant when an AGENT asked (`vault.grant` is on the ADMIN
 * floor, so an agent always proposes; the human owner grants directly).
 *
 * REPLAY through the same write the direct door uses (`applyVaultSecretGrant`),
 * so an approved grant is identical to one the owner made by hand.
 *
 * IDENTITY: acts as the APPROVER, and only the secret's OWNER may approve — a
 * workspace admin approving would otherwise hand out redeem access to someone
 * else's credential. A non-owner approver gets a loud FORBIDDEN, never a silent
 * no-op. The grant's `createdBy` is the approver.
 */
export function registerVaultExecutors(): void {
  registerProposalExecutor({
    key: "vault/grant",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const secretId =
        (inner.secretId as string | undefined) ?? proposal.targetId;
      const scope = inner.scope as VaultSecretGrantScope | undefined;
      if (!secretId || !scope || !SCOPES.includes(scope)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Vault grant proposal is missing the secret or the scope — file the request again.",
        });
      }

      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const secret = await db.query.secrets.findFirst({
        where: and(eq(secrets.id, secretId), isNull(secrets.deletedAt)),
        columns: { userId: true },
      });
      if (!secret) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
      }
      if (secret.userId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the secret's owner can approve access to it",
        });
      }

      await applyVaultSecretGrant({
        secretId,
        grantedTo: (inner.grantedTo as string | null | undefined) ?? null,
        workspaceId: (inner.workspaceId as string | null | undefined) ?? null,
        scope,
        ttlMinutes: (inner.ttlMinutes as number | null | undefined) ?? null,
        createdBy: userId,
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
