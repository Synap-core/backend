/**
 * Proof of presence (W3) — the doors a client uses to PROVE the person is
 * there for one sensitive approval, and to manage the device keys that can.
 *
 *  - `challenge`: a challenge naming ONE proposal (or a pending agent key's
 *    connection), with what each kind of proof signs. The approval then
 *    carries `presence` (`proposals.approve`, `batchApprove`, Hub REST, the
 *    pending-key pages, `secretsVault.grantAIAccess`).
 *  - `devices.*`: the P-256 keys a person's devices hold behind Face ID or the
 *    device passcode (Relay). Enrolling one needs a credential presented AT the
 *    pod within `PRESENCE_ENROLL_FRESH_SECONDS` (an old or stolen session
 *    cannot enrol a key) and a signature by the new key; each enrolment is
 *    audited, and the person lists and revokes them.
 *
 * Every act is a PERSON's, signed in: a key never asks for a challenge or
 * enrols a device (`assertSignedInPerson`).
 *
 * Contract: pod document "W3 pod-first: proof of presence on the pod".
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  PRESENCE_ENROLL_FRESH_SECONDS,
  PRESENCE_EXPIRED,
  PRESENCE_INVALID,
  PRESENCE_USED,
  enrollmentSubject,
  presenceMessage,
} from "@synap-core/types/presence";
import {
  and,
  db,
  desc,
  eq,
  gt,
  isNull,
  presenceChallenges,
  presenceDeviceKeys,
} from "@synap/database";

import { router, protectedProcedure } from "../trpc.js";
import { auditLog } from "../utils/audit-log.js";
import { assertSignedInPerson } from "../utils/signed-in-person.js";
import { kratosCredentialTime } from "../utils/device-session.js";
import { assertProposalVisibleTo } from "../utils/proposal-visibility.js";
import { openAgentConnectProposal } from "../services/agent-connect.js";
import { toPodAdminOrigin } from "../utils/pod-admin-origin.js";
import {
  issuePresenceChallenge,
  readPasskeys,
  verifyDeviceSignature,
  passkeyRpId,
  passkeyRpIds,
  presencePodOrigin,
  PresenceError,
} from "../services/presence/proof.js";

const SIGNED_IN = "Confirm it is you while signed in to your pod.";
const LABEL_MAX = 64;

/** When this request's person last presented a credential AT the pod. */
function credentialTimeOf(ctx: { session?: unknown }): Date | null {
  const session = ctx.session as
    | {
        device?: { authTime?: Date | null } | null;
        authentication_methods?: Array<{
          method?: string | null;
          completed_at?: string | null;
        }> | null;
      }
    | null
    | undefined;
  if (session?.device) return session.device.authTime ?? null;
  return kratosCredentialTime(session ?? null);
}

function asTrpc(err: unknown): never {
  if (err instanceof PresenceError) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: err.message,
      cause: { reasonCode: err.code },
    });
  }
  throw err;
}

export const presenceRouter = router({
  /**
   * A challenge for ONE approval. Name the proposal, or the pending agent key
   * a connection page shows (its `agent/connect` proposal is the subject).
   */
  challenge: protectedProcedure
    .input(
      z.union([
        z.object({ proposalId: z.string().uuid() }),
        z.object({ pendingKeyId: z.string().uuid() }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      let subject: string;
      if ("proposalId" in input) {
        await assertProposalVisibleTo(input.proposalId, ctx.userId, { db });
        subject = input.proposalId;
      } else {
        const proposal = await openAgentConnectProposal(input.pendingKeyId);
        subject = proposal?.id ?? input.pendingKeyId;
      }
      const issued = await issuePresenceChallenge({
        userId: ctx.userId,
        subject,
      });
      const podOrigin = presencePodOrigin();
      const passkeys = await readPasskeys(ctx.userId).catch(() => []);
      const devices = await db
        .select({ id: presenceDeviceKeys.id, label: presenceDeviceKeys.label })
        .from(presenceDeviceKeys)
        .where(
          and(
            eq(presenceDeviceKeys.userId, ctx.userId),
            isNull(presenceDeviceKeys.revokedAt)
          )
        );
      return {
        challengeId: issued.challengeId,
        proposalId: subject,
        nonce: issued.nonce,
        message: issued.message,
        expiresAt: issued.expiresAt.toISOString(),
        passkey:
          passkeys.length > 0
            ? {
                challenge: issued.webauthnChallenge,
                /** The rp id to pass to `navigator.credentials.get`. */
                rpId: passkeyRpId(podOrigin, toPodAdminOrigin(podOrigin)),
                /** Every rp id the pod accepts (the host and each parent). */
                rpIds: passkeyRpIds(podOrigin),
                allowCredentials: passkeys.map((p) => ({
                  id: p.id,
                  type: "public-key" as const,
                })),
                userVerification: "required" as const,
              }
            : null,
        deviceKeys: devices,
      };
    }),

  devices: router({
    /** The person's device keys (never the key material), newest first. */
    list: protectedProcedure.query(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return db
        .select({
          id: presenceDeviceKeys.id,
          label: presenceDeviceKeys.label,
          createdAt: presenceDeviceKeys.createdAt,
          lastUsedAt: presenceDeviceKeys.lastUsedAt,
        })
        .from(presenceDeviceKeys)
        .where(
          and(
            eq(presenceDeviceKeys.userId, ctx.userId),
            isNull(presenceDeviceKeys.revokedAt)
          )
        )
        .orderBy(desc(presenceDeviceKeys.createdAt));
    }),

    /**
     * Step 1 of enrolling a device key: needs a credential presented at the
     * pod (password, code, passkey) within the last 10 min.
     */
    enrollChallenge: protectedProcedure.mutation(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      const at = credentialTimeOf(ctx);
      if (
        !at ||
        Date.now() - at.getTime() > PRESENCE_ENROLL_FRESH_SECONDS * 1000
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Sign in again on this device, then turn on Face ID approval within 10 minutes.",
          cause: { reasonCode: "STEP_UP_REQUIRED" },
        });
      }
      const issued = await issuePresenceChallenge({
        userId: ctx.userId,
        subject: enrollmentSubject,
      });
      return {
        challengeId: issued.challengeId,
        message: issued.message,
        expiresAt: issued.expiresAt.toISOString(),
      };
    }),

    /** Step 2: the new key's public half, and its signature over the message. */
    enroll: protectedProcedure
      .input(
        z.object({
          challengeId: z.string().uuid(),
          label: z.string().trim().min(1).max(LABEL_MAX),
          publicKey: z.string().regex(/^[A-Za-z0-9_-]{40,400}$/),
          signature: z.string().regex(/^[A-Za-z0-9_-]{16,400}$/),
        })
      )
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        // Proof of possession: the challenge is consumed only by a signature
        // the new key made over it, once, in time.
        const challenge = await db.query.presenceChallenges.findFirst({
          where: and(
            eq(presenceChallenges.id, input.challengeId),
            eq(presenceChallenges.userId, ctx.userId)
          ),
        });
        if (
          !challenge ||
          challenge.subject !== enrollmentSubject(challenge.id)
        ) {
          asTrpc(new PresenceError(PRESENCE_INVALID, "Unknown challenge."));
        }
        if (challenge.consumedAt) {
          asTrpc(new PresenceError(PRESENCE_USED, "This challenge was used."));
        }
        if (challenge.expiresAt <= new Date()) {
          asTrpc(
            new PresenceError(PRESENCE_EXPIRED, "This challenge expired.")
          );
        }
        const message = presenceMessage({
          podOrigin: presencePodOrigin(),
          challengeId: challenge.id,
          subject: challenge.subject,
          nonce: challenge.nonce,
        });
        if (!verifyDeviceSignature(input.publicKey, message, input.signature)) {
          asTrpc(
            new PresenceError(
              PRESENCE_INVALID,
              "This key did not sign the enrolment challenge."
            )
          );
        }
        const [spent] = await db
          .update(presenceChallenges)
          .set({ consumedAt: new Date(), method: "device_key" })
          .where(
            and(
              eq(presenceChallenges.id, challenge.id),
              isNull(presenceChallenges.consumedAt),
              gt(presenceChallenges.expiresAt, new Date())
            )
          )
          .returning({ id: presenceChallenges.id });
        if (!spent) {
          asTrpc(new PresenceError(PRESENCE_USED, "This challenge was used."));
        }
        const [row] = await db
          .insert(presenceDeviceKeys)
          .values({
            userId: ctx.userId,
            label: input.label,
            publicKey: input.publicKey,
          })
          .returning({ id: presenceDeviceKeys.id });
        void auditLog({
          subjectType: "presence_device_key",
          action: "enroll",
          phase: "completed",
          subjectId: row!.id,
          userId: ctx.userId,
          workspaceId: null,
          data: { label: input.label },
        });
        return { id: row!.id };
      }),

    /** Revoke one of the person's device keys. Only takes power away. */
    revoke: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        const [ended] = await db
          .update(presenceDeviceKeys)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(presenceDeviceKeys.id, input.id),
              eq(presenceDeviceKeys.userId, ctx.userId),
              isNull(presenceDeviceKeys.revokedAt)
            )
          )
          .returning({ id: presenceDeviceKeys.id });
        if (!ended) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "No device key with this id.",
          });
        }
        void auditLog({
          subjectType: "presence_device_key",
          action: "revoke",
          phase: "completed",
          subjectId: input.id,
          userId: ctx.userId,
          workspaceId: null,
          data: {},
        });
        return { revoked: true };
      }),
  }),
});
