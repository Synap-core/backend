import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  isNull,
  drizzleSql,
  assertGrantScoped,
} from "@synap/database";
import { secrets, ProposalStatus } from "@synap/database/schema";
import {
  makeVaultReference,
  matchVaultRequestSecrets,
} from "@synap-core/types/vault";
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
/**
 * Which of the approver's secrets a `vault.request` grants: the one the agent
 * named (`data.secretId`), else the ONE saved secret the shared rule matches
 * (`matchVaultRequestSecrets`, the desktop card's rule). None, or several, is
 * a refusal that says what to do — never a guess.
 */
async function resolveRequestedSecret(
  approverId: string,
  inner: Record<string, unknown>
): Promise<{ id: string }> {
  const owned = await db.query.secrets.findMany({
    where: and(
      eq(secrets.userId, approverId),
      isNull(secrets.deletedAt),
      eq(secrets.encryptionMode, "server")
    ),
    columns: {
      id: true,
      type: true,
      name: true,
      category: true,
      url: true,
      description: true,
    },
  });
  const named = typeof inner.secretId === "string" ? inner.secretId : null;
  if (named) {
    const secret = owned.find((s) => s.id === named);
    if (!secret) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message:
          "The secret this request names is not one of yours in the vault. Grant it from the vault card on desktop or phone.",
      });
    }
    return secret;
  }
  const service = typeof inner.service === "string" ? inner.service : "";
  const matches = matchVaultRequestSecrets(owned, {
    service,
    secretType:
      typeof inner.secretType === "string" ? inner.secretType : null,
  });
  if (matches.length === 1) return matches[0]!;
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      matches.length === 0
        ? `No secret in your vault matches ${service || "this request"}. Add it to the vault, then approve again.`
        : `${matches.length} secrets in your vault match ${service || "this request"}. Grant it from the vault card on desktop or phone to pick one.`,
  });
}

export function registerVaultExecutors(): void {
  /**
   * Approve-executor for `vault/vault.request` — an agent asked to READ a
   * secret (POST /vault/request). Every generic approve door (pod console,
   * phone, inbox) lands here; before it existed they answered "not yet
   * implemented" and marked the request failed (founder, 2026-10-27).
   *
   * Grants the requested secret (see `resolveRequestedSecret`) to the agent
   * that asked, in the request's space, for the time it asked (`ttl` minutes,
   * scope 'session'), through the ONE grant writer, then records the
   * `vault://` reference, scope and expiry on the proposal: what the agent's
   * poll (GET /vault/request/:id) reads. The approver must own the secret —
   * only their own secrets are candidates.
   */
  registerProposalExecutor({
    key: "vault/vault.request",
    widensCredential: true,
    async execute({ proposal, userId, input, deps }) {
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // The request's fields sit at the top of `data` (POST /vault/request);
      // read a wrapped `data.data` too, as the `vault/grant` executor does.
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const secret = await resolveRequestedSecret(userId, inner);
      const grantedTo = proposal.agentUserId ?? proposal.createdBy ?? null;
      const workspaceId = proposal.workspaceId ?? null;
      assertGrantScoped({ grantedTo, workspaceId });

      const ttl = typeof inner.ttl === "number" && inner.ttl > 0 ? inner.ttl : 60;
      const grant = await applyVaultSecretGrant({
        secretId: secret.id,
        grantedTo,
        workspaceId,
        scope: "session",
        ttlMinutes: ttl,
        createdBy: userId,
      });

      const vaultRef = makeVaultReference(secret.id);
      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          data: drizzleSql`coalesce(data, '{}'::jsonb) || jsonb_build_object('vaultRef', ${vaultRef}::text, 'secretId', ${secret.id}::text, 'approvedAt', ${new Date().toISOString()}::text, 'grantId', ${grant.grantId}::text, 'scope', ${grant.scope}::text, 'expiresAt', ${grant.expiresAt}::text)`,
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

  registerProposalExecutor({
    key: "vault/grant",
    // Approving widens a credential: never from a device session.
    widensCredential: true,
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
