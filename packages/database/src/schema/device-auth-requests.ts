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
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import type { AgentWriteMode } from "@synap-core/types/agents";
import type { ComputerBelongsTo } from "@synap-core/types/computers";
import type {
  DeviceHeldKey,
  DeviceRequestedRow,
  DeviceStoredAgentAction,
} from "@synap-core/types/device";
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
  /** The approver's "whose computer is it" (0388), applied when the key is collected. */
  computerBelongsTo: text("computer_belongs_to").$type<ComputerBelongsTo>(),
  /**
   * How the approved agents' writes land (0394), the approver's choice from
   * `AGENT_WRITE_MODE_CHOICES`, applied when the key is collected. NULL = no
   * choice sent (an older surface): a new agent starts ask-first, as before.
   */
  agentWriteMode: text("agent_write_mode").$type<AgentWriteMode>(),
  /**
   * What a newer CLI sends (0395, "Computer once, agents inside"), all NULL
   * from an older one: the OS user asking (`seat`), its stable id (`seat_id`,
   * the instance of this seat's computer key), the key ids it holds locally
   * (`held`: evidence, never a secret), the agents it asks for with their job
   * (`requested_rows`), and the person's decision per row (`agent_actions`).
   */
  seat: text("seat"),
  seatId: text("seat_id"),
  held: jsonb("held").$type<DeviceHeldKey[]>(),
  requestedRows: jsonb("requested_rows").$type<DeviceRequestedRow[]>(),
  agentActions: jsonb("agent_actions").$type<DeviceStoredAgentAction[]>(),
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
