/**
 * Config Settings — a general, layered per-granularity config store.
 *
 * MIRRORS `governance_rules` (Governance Convergence Plan, Phase A): a small
 * additive table of scoped rows that a specificity-ranking resolver reads. Where
 * governance_rules stores an auto-approve VERDICT for a (principal, scope,
 * target) tuple, config_settings stores an arbitrary keyed `value` for a
 * (capability, scope) tuple — general enough to hold bridge specificities later,
 * used first for GUIDELINES.
 *
 * A GUIDELINE (key = 'guideline') is natural-language intent the AI fetches while
 * interpreting a message ("messages saying 'ready for review' → set this client's
 * playbook to 'ready for review'"; "for this channel, use Proton not Google
 * Drive"). It attaches at ANY granularity (default | bridge | channelType |
 * channel | shape) and is injected into `message.interpret`'s prompt by
 * `resolveGuidelines`. The `posture` field is STORED but not yet an executor —
 * interpret's writes stay proposal-gated; posture becomes load-bearing in the
 * later crystallization/patterns wave.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { MessageShapePredicate } from "./automations.js";

/**
 * The granularity a config row attaches at. Ordered general → specific by the
 * resolver (default < channelType < bridge < channel < shape):
 *   default     — applies to every message (no `scopeRef`).
 *   channelType — the global channel context (e.g. "discord"); `scopeRef` = type.
 *   bridge      — a specific bridge/transport; `scopeRef` = toolId/bridgeId.
 *   channel     — a specific channel; `scopeRef` = channelId.
 *   shape       — narrows by message CONTENT via `shape` (MessageShapePredicate).
 */
export const configScopeKindEnum = pgEnum("config_scope_kind", [
  "default",
  "bridge",
  "channelType",
  "channel",
  "shape",
]);
export const CONFIG_SCOPE_KINDS = configScopeKindEnum.enumValues;
export type ConfigScopeKind = (typeof CONFIG_SCOPE_KINDS)[number];

/**
 * The `value` payload of a GUIDELINE row (key = 'guideline'). `posture` is
 * stored intent only — NOT yet an executor (see file header).
 */
export interface GuidelineValue {
  text: string;
  posture?: "auto" | "propose";
}

export const configSettings = pgTable(
  "config_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // The bridge/capability this row applies to. NULL = applies to every
    // capability (mirrors governance_rules' NULL-workspace = pod-wide).
    capabilityId: uuid("capability_id"),

    scopeKind: configScopeKindEnum("scope_kind").notNull(),
    // toolId | channelType | channelId | shapeId — NULL for scope_kind='default'
    // and 'shape' (shape rows carry their predicate in `shape`, not `scope_ref`).
    scopeRef: text("scope_ref"),

    // The setting key. 'guideline' for this wave; the table is general.
    key: text("key").notNull(),
    // Guideline: { text, posture? }. Typed on read via `$type`.
    value: jsonb("value")
      .$type<GuidelineValue | Record<string, unknown>>()
      .notNull(),

    // Optional MessageShapePredicate for a shape-scoped row (scope_kind='shape').
    shape: jsonb("shape").$type<MessageShapePredicate>(),

    // NULL = pod-wide (owner-floored by created_by on read, like automations /
    // governance pod-wide rows). A UUID scopes the row to one workspace lens.
    workspaceId: uuid("workspace_id"),

    // Provenance: 'user' | 'proposal:<id>' | 'capability-default'.
    source: text("source").notNull().default("user"),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    // Resolver's primary lookup: active rows for a (key, workspace, scope) tuple,
    // ranked by specificity in application code.
    keyScopeIdx: index("config_settings_key_scope_idx")
      .on(table.key, table.workspaceId, table.scopeKind, table.scopeRef)
      .where(sql`${table.revokedAt} IS NULL`),
    capabilityActiveIdx: index("config_settings_capability_idx")
      .on(table.capabilityId)
      .where(sql`${table.revokedAt} IS NULL`),
  })
);

export type ConfigSetting = typeof configSettings.$inferSelect;
export type NewConfigSetting = typeof configSettings.$inferInsert;
