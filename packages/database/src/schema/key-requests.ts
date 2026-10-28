/**
 * Key requests — how the CLI gets a key (keys plan §3.6, Decision 4, founder
 * 2026-10-27: "the CLI requests a key and opens the pod-admin page where the
 * person validates it, and never mints directly"; migration 0363).
 *
 * A computer (`synap keys create --template <id>`) files a request with its own
 * key: `POST /api/hub/keys/requests`. Its person reviews it on pod-admin
 * (`/keys/requests/<id>`), may narrow it (never widen it past the template),
 * and approves it. The CLI then collects the key ONCE
 * (`POST /api/hub/keys/requests/token`), at which moment it is minted through
 * the same mint as `apiKeys.create`, as the person.
 *
 * SECURITY: no plaintext secret is stored. The request code (the CLI's poll
 * secret) is a sha256 hash, and no key exists before collection: the request
 * holds only the draft (`requested_*`, `approved_draft`) and, once collected,
 * the minted key's id. The tripwire `key-requests.no-plaintext.tripwire.test.ts`
 * refuses a new column that could hold a code, token, secret or key in clear.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const KEY_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "consumed",
] as const;
export type KeyRequestStatus = (typeof KEY_REQUEST_STATUSES)[number];

/**
 * What the person approved: the key to mint at collection. The KeyMintInput
 * shape of `@synap-core/types/grants` (name, uses, grant, lifetime), never a
 * scope list (the mint derives it) and never key material.
 */
export interface ApprovedKeyDraft {
  name: string;
  uses: string[];
  note?: string;
  grant: {
    permissions: string[];
    workspaceIds?: string[];
    projectIds?: string[];
    entityIds?: string[];
  };
  /** A number of days, or null = never. */
  expiresInDays: number | null;
}

export const keyRequests = pgTable(
  "key_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256(request_code) — the CLI's poll secret. */
    requestCodeHash: text("request_code_hash").notNull(),
    status: text("status")
      .$type<KeyRequestStatus>()
      .notNull()
      .default("pending"),
    /** The principal that asked (the computer's agent user, else the person). */
    requesterUserId: text("requester_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The api_keys row the request was made with (the key is hashed there). */
    requesterKeyId: uuid("requester_key_id"),
    /** The person who may approve it, and whose key it will be. */
    personUserId: text("person_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The template asked for: a built-in id or one of the person's roles. */
    templateId: text("template_id").notNull(),
    // The CEILING: the template as asked (plus the space the CLI named). The
    // person may narrow it, never widen it.
    requestedName: text("requested_name").notNull(),
    requestedUses: text("requested_uses").array().notNull().default([]),
    requestedPermissions: text("requested_permissions")
      .array()
      .notNull()
      .default([]),
    requestedWorkspaceIds: uuid("requested_workspace_ids").array(),
    requestedProjectIds: uuid("requested_project_ids").array(),
    requestedEntityIds: uuid("requested_entity_ids").array(),
    requestedExpiresInDays: integer("requested_expires_in_days"),
    requestedNeverExpires: boolean("requested_never_expires")
      .notNull()
      .default(false),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
    approvedDraft: jsonb("approved_draft").$type<ApprovedKeyDraft>(),
    mintedKeyId: uuid("minted_key_id"),
    pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(5),
    lastPolledAt: timestamp("last_polled_at", {
      mode: "date",
      withTimezone: true,
    }),
    consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    requesterIdx: index("key_requests_requester_idx").on(t.requesterUserId),
    personIdx: index("key_requests_person_idx").on(t.personUserId),
  })
);

export type KeyRequest = typeof keyRequests.$inferSelect;
