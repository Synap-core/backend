/**
 * Device authorization requests — the device door (MACHINE-IDENTITY-PLAN W2,
 * migration 0321). The terminal starts one (`POST /api/hub/setup/device`), a
 * signed-in person approves it on pod-admin `/device`, and the terminal
 * collects the computer's and its agents' keys ONCE
 * (`POST /api/hub/setup/device/token`).
 *
 * SECURITY: no plaintext secret is stored — both codes are sha256 hashes and
 * no key exists before collection (`mcp_connect_codes` rule). The tripwire
 * `device-auth-requests.no-plaintext.tripwire.test.ts` refuses a new column
 * that could hold a code, token, secret or key in clear.
 */
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const DEVICE_AUTH_STATUSES = [
  "pending",
  "approved",
  "denied",
  "consumed",
] as const;
export type DeviceAuthStatus = (typeof DEVICE_AUTH_STATUSES)[number];

export const deviceAuthRequests = pgTable("device_auth_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** sha256(device_code) — the terminal's poll secret. */
  deviceCodeHash: text("device_code_hash").notNull(),
  /** sha256(normalized user_code) — what the person checks. */
  userCodeHash: text("user_code_hash").notNull(),
  status: text("status").$type<DeviceAuthStatus>().notNull().default("pending"),
  clientName: text("client_name").notNull(),
  hostname: text("hostname").notNull(),
  platform: text("platform"),
  requestedAgents: text("requested_agents").array().notNull().default([]),
  requesterIp: text("requester_ip"),
  userAgent: text("user_agent"),
  approvedByUserId: text("approved_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
  approvedAgents: text("approved_agents").array(),
  machineUserId: text("machine_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  machineName: text("machine_name"),
  mintedKeyId: uuid("minted_key_id"),
  failedCodeAttempts: integer("failed_code_attempts").notNull().default(0),
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
});

export type DeviceAuthRequest = typeof deviceAuthRequests.$inferSelect;
