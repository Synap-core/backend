/**
 * Installation Bindings Schema (0409)
 *
 * ONE need of an installation, served by ONE provider capability, resolved by
 * intent (addendum 000e75ff §4-§6): HyperFrames' `studio_url` need
 * (`expose_http`) bound to Tailnet Expose, with the URL it made, the auth mode
 * the provider actually enforces, and the provider's opaque handle.
 *
 * `intent` is plain text, never an enum or a foreign key: the intent
 * vocabulary is OPEN (`capability_intents`, `skills.intent`), and the Stage 1
 * slugs wait on the founder's naming decision (F1).
 *
 * `handle` is the provider's reference (tunnel id, DNS record id, route file;
 * an array for a composite). The pod stores it and never interprets it.
 *
 * Rebinding creates the new binding while the old one is still live, then
 * revokes the old one, so a need may hold two non-revoked bindings for a
 * moment: there is no unique index on (installation, need).
 *
 * Read floor = the owner within the workspace lens, as `installations`.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { installations } from "./installations.js";
import { capabilities } from "./capabilities.js";
import { apiKeys } from "./api-keys.js";

/** The contract's output states (addendum §4 "Outputs"). */
export const INSTALLATION_BINDING_STATES = [
  "pending",
  "live",
  "degraded",
  "revoked",
  "failed",
] as const;
export type InstallationBindingState =
  (typeof INSTALLATION_BINDING_STATES)[number];

export const installationBindings = pgTable(
  "installation_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    /** The owner (read floor), as on the installation. */
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    /** Which need of the installation (`studio_url`). */
    needKey: text("need_key").notNull(),
    /** The intent slug the need asks for (open vocabulary, no enum). */
    intent: text("intent").notNull(),
    /** The provider capability; null once that capability row is deleted. */
    providerCapabilityId: uuid("provider_capability_id").references(
      () => capabilities.id,
      { onDelete: "set null" }
    ),
    /** The binding's own agent user and key (addendum §7), minted at U6. */
    agentUserId: text("agent_user_id"),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    /** The provider's opaque reference(s); never interpreted by the pod. */
    handle: jsonb("handle").$type<unknown>(),
    url: text("url"),
    state: text("state", { enum: INSTALLATION_BINDING_STATES })
      .notNull()
      .default("pending"),
    /** The auth mode asked for, and the one the provider enforces. */
    authRequested: text("auth_requested"),
    authApplied: text("auth_applied"),
    /** True only when anyone on the internet can reach it. */
    public: boolean("public").notNull().default(false),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    checkedAt: timestamp("checked_at", { mode: "date", withTimezone: true }),
    /** The last health result, in plain words. */
    detail: text("detail"),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    installationNeedIdx: index("idx_installation_bindings_need").on(
      table.installationId,
      table.needKey
    ),
    providerIdx: index("idx_installation_bindings_provider").on(
      table.providerCapabilityId
    ),
  })
);

export type InstallationBindingRow = typeof installationBindings.$inferSelect;
export type NewInstallationBindingRow =
  typeof installationBindings.$inferInsert;
