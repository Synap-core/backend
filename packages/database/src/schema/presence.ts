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
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const presenceChallenges = pgTable(
  "presence_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A proposal id, or `enroll:<challenge id>`. */
    subject: text("subject").notNull(),
    /** 32 random bytes, base64url: part of the signed message. */
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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

export type PresenceChallenge = typeof presenceChallenges.$inferSelect;
export type PresenceDeviceKey = typeof presenceDeviceKeys.$inferSelect;
