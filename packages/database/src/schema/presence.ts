/**
 * Proof of presence (W3, migration 0398). A sensitive approval needs a fresh
 * signature over a pod challenge that names ONE proposal
 * (`@synap-core/types/presence`, `@synap/api` `services/presence/`).
 *
 *  - `presence_challenges`: one per (person, subject), answered once
 *    (`consumed_at`), within 2 min. The subject is a proposal id, or
 *    `enroll:<id>` for a device-key enrolment.
 *  - `presence_device_keys`: the P-256 keys a person's devices hold behind a
 *    biometric or the device passcode (Relay: Secure Enclave / Keystore). Only
 *    the PUBLIC key is stored. Listed and revocable by the person.
 */
import {
  bigint,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const presenceChallenges = pgTable(
  "presence_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The person (no foreign key: see migration 0398). */
    userId: text("user_id").notNull(),
    /** A proposal id, or `enroll:<challenge id>`. */
    subject: text("subject").notNull(),
    /** 32 random bytes, base64url: part of the signed message. */
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /**
     * A `passkey_change:<user>` proof redeemed by Kratos' settings guard
     * (0401): one proof, one passkey change.
     */
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    /**
     * The session a `passkey_change` grant may be redeemed by (0412, founder
     * decision of 9 Nov 2026): `kratos:<id>` or `device:<id>`, stamped by
     * `presence.authorizePasskeyChange`. A grant with none is not redeemable.
     */
    grantSession: text("grant_session"),
    /** How it was answered: `passkey` | `device_key`. */
    method: text("method"),
    deviceKeyId: uuid("device_key_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userSubjectIdx: index("presence_challenges_user_subject_idx").on(
      t.userId,
      t.subject
    ),
  })
);

export const presenceDeviceKeys = pgTable(
  "presence_device_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The person (no foreign key: see migration 0398). */
    userId: text("user_id").notNull(),
    /** What the person calls the device ("Antoine's iPhone"). */
    label: text("label").notNull(),
    /** The P-256 public key, SPKI DER, base64url. Never a private key. */
    publicKey: text("public_key").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("presence_device_keys_user_idx").on(t.userId),
  })
);

/**
 * A person's 2FA app (0405, the recovery ladder). `secret` is an encrypted
 * field (`presence_totp_factors.secret` in `ENCRYPTED_COLUMNS`): the base32
 * TOTP secret. Unconfirmed until a first code proved the app holds it;
 * `last_used_step` is the last 30 s step a code was accepted for.
 */
export const presenceTotpFactors = pgTable(
  "presence_totp_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    secret: text("secret").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lastUsedStep: bigint("last_used_step", { mode: "number" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("presence_totp_factors_user_idx").on(t.userId),
  })
);

/** One wrong typed code (2FA app, recovery code), for the per-person limit (0405). */
export const presenceProofFailures = pgTable(
  "presence_proof_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    method: text("method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("presence_proof_failures_user_idx").on(
      t.userId,
      t.createdAt
    ),
  })
);

/**
 * "I lost my passkey" (0405): pending until `matures_at` (24 h), cancellable
 * from any of the person's sessions, then finished by the person. One pending
 * request per person.
 */
export const presenceRecoveryRequests = pgTable(
  "presence_recovery_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** `pending` | `cancelled` | `completed` (CHECK in 0405). */
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    maturesAt: timestamp("matures_at", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    onePending: uniqueIndex("presence_recovery_requests_one_pending")
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
  })
);

/**
 * The passkeys a finished recovery cleared (0405): Kratos v1.3.1 cannot
 * remove a passkey through its admin API, so the pod stops accepting them as a
 * proof. `credential_id` is the base64url credential id.
 */
export const presenceDisownedPasskeys = pgTable(
  "presence_disowned_passkeys",
  {
    userId: text("user_id").notNull(),
    credentialId: text("credential_id").notNull(),
    recoveryRequestId: uuid("recovery_request_id").notNull(),
    disownedAt: timestamp("disowned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.credentialId] }),
  })
);

/**
 * "Add this device" (0412, founder decision of 9 Nov 2026): a NEW device asks,
 * a device the person already uses approves it (number matching and a proof
 * from an existing factor), then the new device adds its own passkey or device
 * key with no further proof, once. `requester_session` binds the request to
 * the session that asked; `expired` is derived when read, never stored. One
 * pending request per person.
 */
export const presenceDeviceLinks = pgTable(
  "presence_device_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** `passkey` | `device_key` (CHECK in 0412). */
    kind: text("kind").notNull(),
    /** What the new device calls itself ("iPhone · Safari"). */
    label: text("label").notNull(),
    /** `kratos:<session id>` or `device:<person_devices id>`. */
    requesterSession: text("requester_session").notNull(),
    /** `device_key` only: `presenceKeyFingerprint` of the key it will enrol. */
    keyFingerprint: text("key_fingerprint"),
    /** The two digits the new device shows. Never sent to another device. */
    matchNumber: text("match_number").notNull(),
    /** Three two-digit numbers, the match among them, shuffled. */
    choices: text("choices").array().notNull(),
    /** `pending` | `approved` | `declined` | `redeemed` | `replaced` (CHECK in 0412). */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** How the approving device proved presence (a proof kind), or null in `report`. */
    approvedMethod: text("approved_method"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("presence_device_links_user_idx").on(t.userId, t.createdAt),
    onePending: uniqueIndex("presence_device_links_one_pending")
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
  })
);

export type PresenceChallenge = typeof presenceChallenges.$inferSelect;
export type PresenceDeviceKey = typeof presenceDeviceKeys.$inferSelect;
