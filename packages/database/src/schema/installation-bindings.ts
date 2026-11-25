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
 * A SPACE'S NEED BINDING (0426, founder decision D3): a row with NO
 * installation. `workspace_id` = the space, `need_key` = the need slug
 * (`needs`), `provider_capability_id` = the provider that fills it, `state`
 * live or revoked, `intent` null (a need groups several intents). One live
 * binding per (space, need) (`uq_installation_bindings_space_need`); a rebind
 * revokes the old row and writes a new one. Filled once per space, shared by
 * its members: its read floor is the space, not the person who set it
 * (`access/registry.ts`). The `installation_bindings_scope_check` CHECK keeps
 * the two shapes apart.
 *
 * Read floor = the owner within the workspace lens, as `installations`, for an
 * installation's binding; the space's members for a space's binding.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

/** Who chose a space need binding's provider (0426). */
export const INSTALLATION_BINDING_ORIGINS = ["person", "automatic"] as const;
export type InstallationBindingOrigin =
  (typeof INSTALLATION_BINDING_ORIGINS)[number];

export const installationBindings = pgTable(
  "installation_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The installation; null for a space's need binding (0426). */
    installationId: uuid("installation_id").references(() => installations.id, {
      onDelete: "cascade",
    }),
    /** The owner (read floor), as on the installation. */
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    /** Which need of the installation (`studio_url`), or the need slug of a space's binding. */
    needKey: text("need_key").notNull(),
    /** The intent slug the need asks for (open vocabulary, no enum); null for a space's binding. */
    intent: text("intent"),
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
    /**
     * Who chose the provider of a space's need binding (0426): `person` (a
     * person or an approved proposal) or `automatic` (the pod bound the
     * space's one installed filling provider). Installation bindings: `person`.
     */
    origin: text("origin", { enum: INSTALLATION_BINDING_ORIGINS })
      .notNull()
      .default("person"),
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
    spaceNeedUnique: uniqueIndex("uq_installation_bindings_space_need")
      .on(table.workspaceId, table.needKey)
      .where(
        sql`${table.installationId} IS NULL AND ${table.state} <> 'revoked'`
      ),
  })
);

export type InstallationBindingRow = typeof installationBindings.$inferSelect;
export type NewInstallationBindingRow =
  typeof installationBindings.$inferInsert;
