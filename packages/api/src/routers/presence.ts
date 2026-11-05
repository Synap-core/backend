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
  PRESENCE_REQUEST_KINDS,
  oauthConsentId,
  presenceRequestSubject,
  presenceActionDigest,
  presenceActionSubject,
  presenceProofSchema,
  SENSITIVE_ACTIONS,
  type SensitiveActionPath,
  type PresenceRequestKind,
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

import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { assertPresenceForRequest } from "../services/presence/gate.js";
import {
  assertMayEnrollDeviceKey,
  notifyFactorChanged,
} from "../services/presence/factors.js";
import { PASSKEY_CHANGE_GRANT_SECONDS } from "../services/presence/passkey-change.js";
import { missingSince, readPresenceMode } from "../services/presence/mode.js";
import { changePresenceMode } from "../services/presence/mode-change.js";
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
   * A challenge for ONE approval. Name the proposal; or the pending agent key
   * a connection page shows (its `agent/connect` proposal is the subject); or
   * a request a door decides without a proposal (`request: {kind, id}`,
   * `PRESENCE_REQUEST_KINDS`); or the OAuth authorization a consent screen
   * shows (`oauthConsent`: the parameters it was opened with).
   */
  challenge: protectedProcedure
    .input(
      z.union([
        z.object({ proposalId: z.string().uuid() }),
        z.object({ pendingKeyId: z.string().uuid() }),
        z.object({
          request: z.object({
            kind: z.enum(
              Object.keys(PRESENCE_REQUEST_KINDS) as [
                PresenceRequestKind,
                ...PresenceRequestKind[],
              ]
            ),
            id: z.string().min(1).max(200),
          }),
        }),
        z.object({
          // A sensitive ACTION (slice 3): the exact input the call will send.
          action: z.object({
            path: z.enum(
              Object.keys(SENSITIVE_ACTIONS) as [
                SensitiveActionPath,
                ...SensitiveActionPath[],
              ]
            ),
            input: z.unknown(),
          }),
        }),
        z.object({
          oauthConsent: z.object({
            clientId: z.string().min(1).max(512),
            redirectUri: z.string().min(1).max(2048),
            codeChallenge: z.string().max(256).nullish(),
            state: z.string().max(2048).nullish(),
          }),
        }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      let subject: string;
      if ("proposalId" in input) {
        await assertProposalVisibleTo(input.proposalId, ctx.userId, { db });
        subject = input.proposalId;
      } else if ("pendingKeyId" in input) {
        const proposal = await openAgentConnectProposal(input.pendingKeyId);
        subject = proposal?.id ?? input.pendingKeyId;
      } else if ("action" in input) {
        subject = presenceActionSubject(
          input.action.path,
          await presenceActionDigest(input.action.path, input.action.input)
        );
      } else if ("request" in input) {
        // The deciding door checks who may decide the request; a challenge
        // only names it, and is this person's own.
        subject = presenceRequestSubject(input.request.kind, input.request.id);
      } else {
        subject = presenceRequestSubject(
          "oauth_consent",
          await oauthConsentId(input.oauthConsent)
        );
      }
      // A failed read of the person's passkeys is NOT "no passkey": it fails
      // the call (before any challenge exists), so the client shows a failed
      // read with Try again instead of hiding the passkey option.
      let passkeys: Awaited<ReturnType<typeof readPasskeys>>;
      try {
        passkeys = await readPasskeys(ctx.userId);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Couldn't read your passkeys from the pod's sign-in service. Try again in a moment.",
          cause: err,
        });
      }
      const issued = await issuePresenceChallenge({
        userId: ctx.userId,
        subject,
      });
      const podOrigin = presencePodOrigin();
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
        /** What the message names on line 4: a proposal id, or `<kind>:<id>`. */
        proposalId: subject,
        subject,
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

  /**
   * The pod's proof-of-presence mode, for pod admin → Security: what is in
   * force, where it comes from, and what `enforce` would have refused in the
   * last 30 days (the `presence.missing` events).
   */
  mode: podAdminProcedure.query(async () => {
    const state = await readPresenceMode();
    return { ...state, missingLast30d: await missingSince(30) };
  }),

  /**
   * Switch the mode. ON (`enforce`) is free: it only takes power away. OFF
   * (`report`) needs a proof of presence for `presence_mode:report`, is
   * recorded (`presence.mode_changed`) and announced to every pod admin. An
   * operator env floor (`SYNAP_PRESENCE_PROOF=enforce`) cannot be switched
   * off here.
   */
  setMode: podAdminProcedure
    .input(
      z.object({
        mode: z.enum(["enforce", "report"]),
        presence: presenceProofSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return changePresenceMode({
        userId: ctx.userId,
        mode: input.mode,
        proof: input.presence ?? null,
      });
    }),

  /**
   * Before a passkey change in Kratos' settings flow (adding or removing one)
   * when the person already has a factor (founder decision 2): an existing
   * factor proves `passkey_change:<their user id>`. The consumed challenge is
   * the grant the settings guard redeems: one change per proof, within
   * PASSKEY_CHANGE_GRANT_SECONDS. The person's first passkey needs no grant.
   */
  authorizePasskeyChange: protectedProcedure
    .input(z.object({ presence: presenceProofSchema }))
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      const verdict = await assertPresenceForRequest({
        userId: ctx.userId,
        kind: "passkey_change",
        id: ctx.userId,
        proof: input.presence,
        door: "presence.authorizePasskeyChange",
      });
      return {
        authorized: verdict !== null,
        expiresInSeconds: PASSKEY_CHANGE_GRANT_SECONDS,
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
          /**
           * A proof from an EXISTING factor, for `device_enroll:<fingerprint
           * of publicKey>`, when the person already has one (founder decision
           * 2): a stolen session alone never adds a key it controls.
           */
          presence: presenceProofSchema.optional(),
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
        // An existing factor approves the new one; the person's first factor
        // rests on the fresh sign-in `enrollChallenge` checked.
        await assertMayEnrollDeviceKey({
          userId: ctx.userId,
          publicKey: input.publicKey,
          proof: input.presence ?? null,
        });
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
        await notifyFactorChanged({
          userId: ctx.userId,
          change: "added",
          factor: "device_key",
          label: input.label,
          id: row!.id,
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
          .returning({
            id: presenceDeviceKeys.id,
            label: presenceDeviceKeys.label,
          });
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
        await notifyFactorChanged({
          userId: ctx.userId,
          change: "removed",
          factor: "device_key",
          label: ended.label,
          id: ended.id,
        });
        return { revoked: true };
      }),
  }),
});
