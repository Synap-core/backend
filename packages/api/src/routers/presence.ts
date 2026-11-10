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
 *  - `totp.*`: the person's 2FA app (the recovery ladder): its code proves
 *    presence in pod admin's dialog. Added with a fresh sign-in and, when the
 *    person holds a factor, a proof from it; removed freely, except below two
 *    ways in under `enforce`.
 *  - `recovery.*`: "I lost my passkey": ask, cancel (any session of theirs,
 *    24 h), finish (a fresh sign-in at the pod), which clears every factor.
 *  - `deviceLink.*`: "Add this device" (founder decision of 9 Nov 2026,
 *    session 84c74a23): a NEW device asks (`request`, it shows a number), a
 *    device the person already uses sees it (`pending`), picks that number
 *    and proves presence with an existing factor (`approve`), or declines it
 *    (`decline`, any session); the new device follows its request
 *    (`status`), then adds its own passkey (Kratos' settings guard) or device
 *    key (`devices.enroll`) with no further proof, once.
 *
 * Grants are bound to the SESSION that asked (`callerSessionKey`): a
 * `passkey_change` proof and an approved device link are redeemed only by it,
 * never by another session of the same person.
 *
 * Every act is a PERSON's, signed in: a key never asks for a challenge or
 * enrols a device (`assertSignedInPerson`). The 2FA app and the recovery are
 * pod admin's (a browser session), never a Synap app's device session.
 *
 * Contract: pod document "W3 pod-first: proof of presence on the pod".
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  PRESENCE_REQUEST_KINDS,
  oauthConsentId,
  passkeyHolder,
  presenceRequestSubject,
  presenceActionDigest,
  presenceActionSubject,
  presenceProofSchema,
  SENSITIVE_ACTIONS,
  type SensitiveActionPath,
  type PresenceRequestKind,
  PRESENCE_ENROLL_FRESH_SECONDS,
  PRESENCE_DEVICE_LINK_GONE,
  PRESENCE_DEVICE_LINK_MISMATCH,
  PRESENCE_DEVICE_LINK_NO_SESSION,
  PRESENCE_DEVICE_LINK_RATE,
  PRESENCE_DEVICE_LINK_SELF,
  DEVICE_LINK_KINDS,
  enrollmentSubject,
  presenceSensitivitySchema,
  presenceWaysIn,
} from "@synap-core/types/presence";
import {
  and,
  db,
  desc,
  eq,
  isNull,
  presenceDeviceKeys,
  presenceTotpFactors,
  users,
} from "@synap/database";

import { router, protectedProcedure, podAdminProcedure } from "../trpc.js";
import { assertPresenceForRequest } from "../services/presence/gate.js";
import {
  assertKeepsTwoWaysIn,
  enrollDeviceKey,
  notifyFactorChanged,
  presenceFactorCounts,
} from "../services/presence/factors.js";
import {
  activeTotpFactor,
  beginTotpEnrolment,
  confirmTotpEnrolment,
} from "../services/presence/totp.js";
import {
  cancelPresenceRecovery,
  completePresenceRecovery,
  readPresenceRecovery,
  requestPresenceRecovery,
} from "../services/presence/recovery.js";
import {
  assertMayRemovePasskey,
  PASSKEY_CHANGE_GRANT_SECONDS,
  stampPasskeyChangeGrant,
  passkeyChangeReady,
} from "../services/presence/passkey-change.js";
import {
  approveDeviceLink,
  callerSessionKey,
  declineDeviceLink,
  deviceLinkStatus,
  pendingDeviceLinks,
  requestDeviceLink,
} from "../services/presence/device-link.js";
import {
  missingSince,
  readPresenceMode,
  readPresenceSensitivity,
} from "../services/presence/mode.js";
import { changePresenceMode } from "../services/presence/mode-change.js";
import { changePresenceSensitivity } from "../services/presence/sensitivity-change.js";
import { auditLog } from "../utils/audit-log.js";
import { assertSignedInPerson } from "../utils/signed-in-person.js";
import {
  isDeviceSession,
  kratosCredentialTime,
} from "../utils/device-session.js";
import { assertProposalVisibleTo } from "../utils/proposal-visibility.js";
import { openAgentConnectProposal } from "../services/agent-connect.js";
import { toPodAdminOrigin } from "../utils/pod-admin-origin.js";
import {
  issuePresenceChallenge,
  readPasskeys,
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

/**
 * A credential presented AT the pod (password, code, passkey) within
 * `PRESENCE_ENROLL_FRESH_SECONDS`: what adding a first factor, or finishing a
 * recovery, rests on. A Synap Cloud sign-in alone is not one.
 */
function assertFreshSignIn(ctx: { session?: unknown }, message: string): void {
  const at = credentialTimeOf(ctx);
  if (!at || Date.now() - at.getTime() > PRESENCE_ENROLL_FRESH_SECONDS * 1000) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message,
      cause: { reasonCode: "STEP_UP_REQUIRED" },
    });
  }
}

const IN_POD_ADMIN = "Do this in pod admin, signed in in your browser.";

/** The 2FA app and the recovery are pod admin's: never a Synap app's device session. */
function assertBrowserSession(
  ctx: Parameters<typeof isDeviceSession>[0]
): void {
  if (isDeviceSession(ctx)) {
    throw new TRPCError({ code: "FORBIDDEN", message: IN_POD_ADMIN });
  }
}

/** A failed passkey read fails the call: it is never "no passkey". */
async function countsOf(userId: string) {
  try {
    return await presenceFactorCounts(userId);
  } catch (err) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Couldn't read your passkeys from the pod's sign-in service. Try again in a moment.",
      cause: err,
    });
  }
}

/**
 * The session this caller's grants are bound to, or NO_SESSION: a request or
 * a grant with no session to bind could be redeemed by any session of the
 * person, which is what binding prevents (founder decision of 9 Nov 2026).
 */
function sessionKeyOrRefuse(
  ctx: Parameters<typeof callerSessionKey>[0]
): string {
  const key = callerSessionKey(ctx);
  if (!key) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This sign-in has no session to tie the approval to. Sign in again on this device, then try again.",
      cause: { reasonCode: PRESENCE_DEVICE_LINK_NO_SESSION },
    });
  }
  return key;
}

/** How each device-link refusal reaches the client; its reasonCode says which. */
const DEVICE_LINK_TRPC_CODES: Record<
  string,
  "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" | "TOO_MANY_REQUESTS"
> = {
  [PRESENCE_DEVICE_LINK_MISMATCH]: "BAD_REQUEST",
  [PRESENCE_DEVICE_LINK_GONE]: "NOT_FOUND",
  [PRESENCE_DEVICE_LINK_SELF]: "FORBIDDEN",
  [PRESENCE_DEVICE_LINK_NO_SESSION]: "FORBIDDEN",
  [PRESENCE_DEVICE_LINK_RATE]: "TOO_MANY_REQUESTS",
};

function asTrpc(err: unknown): never {
  if (err instanceof PresenceError) {
    throw new TRPCError({
      code: DEVICE_LINK_TRPC_CODES[err.code] ?? "FORBIDDEN",
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
      // The codes a person may TYPE here instead: only in a browser session
      // (pod admin's dialog), never a Synap app's device session.
      const counts = isDeviceSession(ctx) ? null : await countsOf(ctx.userId);
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
                /**
                 * Each passkey, with where it lives (`passkeyHolder`, from its
                 * AAGUID): pod admin sends a device's passkey straight to the
                 * browser's own prompt when a password-manager extension has
                 * taken over WebAuthn in the page.
                 */
                allowCredentials: passkeys.map((p) => ({
                  id: p.id,
                  type: "public-key" as const,
                  ...passkeyHolder(p.aaguid, p.displayName),
                })),
                userVerification: "required" as const,
              }
            : null,
        deviceKeys: devices,
        typed: {
          totp: counts?.totp ?? false,
          recoveryCode: (counts?.recoveryCodes ?? 0) > 0,
        },
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
   * The caller's own proof factors, counted: their passkeys (from the pod's
   * sign-in service), their device keys (Relay's Face ID, the desktop's
   * Touch ID), the authenticator app and their unused recovery codes. What pod admin shows before
   * the person relies on "Approvals need you in person". A failed passkey read
   * fails the call, never "no passkey".
   */
  factors: protectedProcedure.query(async ({ ctx }) => {
    assertSignedInPerson(ctx, SIGNED_IN);
    const [counts, mode] = await Promise.all([
      countsOf(ctx.userId),
      readPresenceMode(),
    ]);
    return {
      /**
       * Whether approvals need the person in person on this pod: what makes
       * "fewer than two ways in" a warning for every member, not only for a
       * pod admin (who also reads `presence.mode`). A failed read fails the
       * call, like the counts.
       */
      enforce: mode.mode === "enforce",
      passkeys: counts.passkeys,
      deviceKeys: counts.deviceKeys,
      /** A 2FA app in use. */
      totp: counts.totp,
      /** Unused recovery codes. */
      recoveryCodes: counts.recoveryCodes,
      /** What "two ways in" counts (`presenceWaysIn`). */
      waysIn: presenceWaysIn(counts),
    };
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
   * What asks for a passkey on this pod (W5): the rows of the sensitive lists
   * a pod admin switched off, none by default. Every signed-in person may read
   * it, so a client asks for a proof only where the pod will. `mode` is the
   * mode in force (read with the choice, one cached read): a member's
   * Security page says up front that their last passkey stays while it is
   * `enforce` (`presence.mode` itself is a pod admin read).
   */
  sensitivity: protectedProcedure.query(async () => {
    const [choice, { mode }] = await Promise.all([
      readPresenceSensitivity(),
      readPresenceMode(),
    ]);
    return { ...choice, mode };
  }),

  /**
   * Change what asks for a passkey. Switching a row OFF needs a proof of
   * presence for `presence_sensitivity:<id of the new choice>`, in every
   * mode; switching rows back ON is free. Recorded
   * (`presence.sensitivity_changed`) and announced to every pod admin.
   */
  setSensitivity: podAdminProcedure
    .input(
      presenceSensitivitySchema.extend({
        presence: presenceProofSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return changePresenceSensitivity({
        userId: ctx.userId,
        choice: {
          approvalsOff: input.approvalsOff,
          actionsOff: input.actionsOff,
        },
        proof: input.presence ?? null,
      });
    }),

  /**
   * May THIS session add a passkey now with nothing more to confirm (an
   * unused grant it proved, or an approved "Add this device" request it
   * asked for)? A read: nothing is redeemed. Pod admin's passkeys card goes
   * straight to "Create a passkey" when it is true (the desktop's setup
   * window opens AFTER the approval). A caller with no session to bind
   * reads false.
   */
  passkeyChangeReady: protectedProcedure.query(async ({ ctx }) => {
    assertSignedInPerson(ctx, SIGNED_IN);
    const { ready, until } = await passkeyChangeReady(
      ctx.userId,
      callerSessionKey(ctx)
    );
    return { ready, until: until ? until.toISOString() : null };
  }),

  /**
   * Before a passkey change in Kratos' settings flow (adding or removing one)
   * when the person already has a factor (founder decision 2): an existing
   * factor proves `passkey_change:<their user id>`. The consumed challenge is
   * the grant the settings guard redeems: one change per proof, within
   * PASSKEY_CHANGE_GRANT_SECONDS, and only by the session that proved it
   * (`grant_session`, founder decision of 9 Nov 2026): a caller with no
   * session to bind is refused before the proof is used. The person's first
   * passkey needs no grant.
   */
  authorizePasskeyChange: protectedProcedure
    .input(
      z.object({
        presence: presenceProofSchema,
        /**
         * What the change will be. Removing the person's LAST passkey is
         * refused while the proof of presence is on (W5), and under
         * `enforce` a removal must leave two ways in (the recovery ladder):
         * both are checked before the proof is used. The rules guard the
         * person from locking themselves out; a proof from them is needed
         * either way.
         */
        change: z.enum(["add", "remove"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      const sessionKey = sessionKeyOrRefuse(ctx);
      if (input.change === "remove") {
        await assertMayRemovePasskey(ctx.userId);
        await assertKeepsTwoWaysIn({
          userId: ctx.userId,
          after: (c) => ({ ...c, passkeys: Math.max(0, c.passkeys - 1) }),
        });
      }
      const verdict = await assertPresenceForRequest({
        userId: ctx.userId,
        kind: "passkey_change",
        id: ctx.userId,
        proof: input.presence,
        door: "presence.authorizePasskeyChange",
      });
      // The consumed challenge IS the grant: bind it to this session, so only
      // this browser's settings flow redeems it.
      const bound =
        verdict !== null &&
        (await stampPasskeyChangeGrant({
          userId: ctx.userId,
          challengeId: verdict.challengeId,
          sessionKey,
        }));
      return {
        authorized: bound,
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
          /**
           * "Add this device" (founder decision of 9 Nov 2026): the device
           * link a device the person already uses approved for this session
           * and this key, instead of `presence`.
           */
          deviceLinkId: z.string().uuid().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        // Proof of possession, then ONE first factor per person decided in
        // the transaction that stores the key (`enrollDeviceKey`).
        let row: { id: string; viaDeviceLink: boolean };
        try {
          row = await enrollDeviceKey({
            userId: ctx.userId,
            challengeId: input.challengeId,
            label: input.label,
            publicKey: input.publicKey,
            signature: input.signature,
            proof: input.presence ?? null,
            sessionKey: callerSessionKey(ctx),
            deviceLinkId: input.deviceLinkId ?? null,
          });
        } catch (err) {
          asTrpc(err);
        }
        void auditLog({
          subjectType: "presence_device_key",
          action: "enroll",
          phase: "completed",
          subjectId: row.id,
          userId: ctx.userId,
          workspaceId: null,
          data: { label: input.label, viaDeviceLink: row.viaDeviceLink },
        });
        await notifyFactorChanged({
          userId: ctx.userId,
          change: "added",
          factor: "device_key",
          label: input.label,
          id: row.id,
        });
        return { id: row.id };
      }),

    /** Revoke one of the person's device keys. Only takes power away. */
    revoke: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        await assertKeepsTwoWaysIn({
          userId: ctx.userId,
          after: (c) => ({ ...c, deviceKeys: Math.max(0, c.deviceKeys - 1) }),
        });
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

  totp: router({
    /** The person's 2FA app in use, or null. */
    get: protectedProcedure.query(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return activeTotpFactor(ctx.userId);
    }),

    /**
     * Step 1 of adding a 2FA app: a new secret, shown ONCE (as a QR code and
     * as text). Needs a fresh sign-in at the pod.
     */
    begin: protectedProcedure
      .input(z.object({ label: z.string().trim().min(1).max(LABEL_MAX) }))
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        assertBrowserSession(ctx);
        assertFreshSignIn(
          ctx,
          "Sign in again, then add your authenticator app within 10 minutes."
        );
        const person = await db.query.users.findFirst({
          where: eq(users.id, ctx.userId),
          columns: { email: true },
        });
        return beginTotpEnrolment({
          userId: ctx.userId,
          label: input.label,
          account: person?.email || ctx.userId,
          issuer: `Synap (${new URL(presencePodOrigin()).hostname})`,
        });
      }),

    /**
     * Step 2: the app's first code. A person who already holds a factor
     * approves it with that factor (`totp_enroll:<id>`).
     */
    confirm: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          code: z.string().regex(/^\d{6}$/),
          presence: presenceProofSchema.optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        assertBrowserSession(ctx);
        assertFreshSignIn(
          ctx,
          "Sign in again, then add your authenticator app within 10 minutes."
        );
        let added: { id: string; label: string };
        try {
          added = await confirmTotpEnrolment({
            userId: ctx.userId,
            id: input.id,
            code: input.code,
            proof: input.presence ?? null,
          });
        } catch (err) {
          asTrpc(err);
        }
        void auditLog({
          subjectType: "presence_totp_factor",
          action: "enroll",
          phase: "completed",
          subjectId: added.id,
          userId: ctx.userId,
          workspaceId: null,
          data: { label: added.label },
        });
        await notifyFactorChanged({
          userId: ctx.userId,
          change: "added",
          factor: "totp",
          label: added.label,
          id: added.id,
        });
        return { id: added.id };
      }),

    /** Remove the person's 2FA app. Under `enforce`, never below two ways in. */
    remove: protectedProcedure.mutation(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      await assertKeepsTwoWaysIn({
        userId: ctx.userId,
        after: (c) => ({ ...c, totp: false }),
      });
      const ended = await db
        .update(presenceTotpFactors)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(presenceTotpFactors.userId, ctx.userId),
            isNull(presenceTotpFactors.revokedAt)
          )
        )
        .returning({
          id: presenceTotpFactors.id,
          label: presenceTotpFactors.label,
          confirmedAt: presenceTotpFactors.confirmedAt,
        });
      const app = ended.find((r) => r.confirmedAt !== null);
      if (!app) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "You don't use an authenticator app here.",
        });
      }
      void auditLog({
        subjectType: "presence_totp_factor",
        action: "revoke",
        phase: "completed",
        subjectId: app.id,
        userId: ctx.userId,
        workspaceId: null,
        data: {},
      });
      await notifyFactorChanged({
        userId: ctx.userId,
        change: "removed",
        factor: "totp",
        label: app.label,
        id: app.id,
      });
      return { removed: true };
    }),
  }),

  deviceLink: router({
    /**
     * On the NEW device: ask to be approved. `needed: false` when the person
     * holds no proof factor yet (their first one needs no approval). Else the
     * number to show, and every device of the person is told. Asking again
     * replaces the pending request; at most 5 requests per 15 minutes.
     */
    request: protectedProcedure
      .input(
        z.object({
          kind: z.enum(DEVICE_LINK_KINDS),
          label: z.string().trim().min(1).max(LABEL_MAX),
          /** `device_key` only: `presenceKeyFingerprint` of the key it will enrol. */
          keyFingerprint: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        const sessionKey = sessionKeyOrRefuse(ctx);
        try {
          const asked = await requestDeviceLink({
            userId: ctx.userId,
            sessionKey,
            kind: input.kind,
            label: input.label,
            keyFingerprint: input.keyFingerprint ?? null,
          });
          return asked.needed
            ? { ...asked, expiresAt: asked.expiresAt.toISOString() }
            : asked;
        } catch (err) {
          asTrpc(err);
        }
      }),

    /** On the NEW device: where its own request stands (only the session that asked). */
    status: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        const sessionKey = sessionKeyOrRefuse(ctx);
        try {
          const read = await deviceLinkStatus({
            userId: ctx.userId,
            sessionKey,
            id: input.id,
          });
          return { ...read, expiresAt: read.expiresAt.toISOString() };
        } catch (err) {
          asTrpc(err);
        }
      }),

    /**
     * On a device the person already uses: the requests it may approve (asked
     * by another session), each with three numbers to pick from, never which.
     */
    pending: protectedProcedure.query(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      const sessionKey = sessionKeyOrRefuse(ctx);
      const rows = await pendingDeviceLinks({ userId: ctx.userId, sessionKey });
      return rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      }));
    }),

    /**
     * On a device the person already uses: the number the new device shows,
     * and a proof from an existing factor for `device_link:<id>`. A wrong
     * number declines the request; the proof is checked only after it.
     */
    approve: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          number: z.string().regex(/^\d{2}$/),
          presence: presenceProofSchema.optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        const sessionKey = sessionKeyOrRefuse(ctx);
        try {
          return await approveDeviceLink({
            userId: ctx.userId,
            sessionKey,
            id: input.id,
            number: input.number,
            proof: input.presence ?? null,
          });
        } catch (err) {
          asTrpc(err);
        }
      }),

    /** Decline, from any session of the person: the new device cancels, or "not me". */
    decline: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        assertSignedInPerson(ctx, SIGNED_IN);
        try {
          return await declineDeviceLink({ userId: ctx.userId, id: input.id });
        } catch (err) {
          asTrpc(err);
        }
      }),
  }),

  recovery: router({
    /** The person's latest request ("I lost my passkey"), or null. */
    status: protectedProcedure.query(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return readPresenceRecovery(ctx.userId);
    }),

    /** Ask: every device is told; it can be finished in 24 h, cancelled until then. */
    request: protectedProcedure.mutation(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return requestPresenceRecovery({ userId: ctx.userId });
    }),

    /** Cancel, from any signed-in session of the person (Relay, the desktop app included). */
    cancel: protectedProcedure.mutation(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      return cancelPresenceRecovery({ userId: ctx.userId });
    }),

    /**
     * Finish a request that waited 24 h: needs a fresh sign-in at the pod,
     * in pod admin. Clears every proof factor of the person.
     */
    complete: protectedProcedure.mutation(async ({ ctx }) => {
      assertSignedInPerson(ctx, SIGNED_IN);
      assertBrowserSession(ctx);
      assertFreshSignIn(
        ctx,
        "Sign in again with your password or an email code, then finish within 10 minutes."
      );
      const current = (ctx as { session?: { id?: unknown } | null }).session
        ?.id;
      return completePresenceRecovery({
        userId: ctx.userId,
        keepSessionId: typeof current === "string" ? current : null,
      });
    }),
  }),
});
