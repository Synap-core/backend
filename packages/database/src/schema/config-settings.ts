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
 * Drive"). It attaches at ANY granularity (default | workKind | bridge |
 * channelType | channel | shape) and is injected into `message.interpret`'s prompt by
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
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { MessageShapePredicate } from "./automations.js";

/**
 * The granularity a config row attaches at. The DECLARATION ORDER BELOW IS NOT
 * THE SPECIFICITY ORDER — it never was (`bridge` is declared before
 * `channelType` but ranks after it), and a new member is appended here because
 * postgres `ALTER TYPE … ADD VALUE` appends. The ONE ordering authority is
 * `SCOPE_ORDER` in `utils/config-settings.ts`, and a member missing from it
 * fails the build.
 *
 * Ordered general → specific by the resolver
 * (default < workKind < channelType < bridge < channel < shape):
 *   default     — applies to every message (no `scopeRef`).
 *   workKind    — a KIND OF WORK rather than a transport; `scopeRef` = the work
 *                 kind's token. See `SCOPE_ORDER`'s note for the vocabulary and
 *                 for why the rung sits where it does.
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
  "workKind",
  // 0258 — the DATA-TYPE rungs (see `SCOPE_ORDER` for their placement).
  //   sourceKind — the kind of INPUT being structured; `scopeRef` is a
  //                `GUIDELINE_SOURCE_KINDS` token or `import:<import source>`.
  //   entityKind — the kind of OUTPUT; `scopeRef` is a profile slug.
  "sourceKind",
  "entityKind",
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
    // toolId | channelType | channelId | work-kind token — NULL for
    // scope_kind='default' and 'shape' (shape rows carry their predicate in
    // `shape`, not `scope_ref`).
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

    // 0258 — VERSIONS. An edit never updates a row in place: it inserts a new
    // row with `version = old.version + 1` and `supersedesId = old.id`, and
    // revokes the old one (`supersedeGuideline`). History = the supersedes
    // chain. A partial UNIQUE index lets a row be superseded at most once.
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),
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
    supersedesUq: uniqueIndex("config_settings_supersedes_uq")
      .on(table.supersedesId)
      .where(sql`${table.supersedesId} IS NOT NULL`),
  })
);

export type ConfigSetting = typeof configSettings.$inferSelect;
export type NewConfigSetting = typeof configSettings.$inferInsert;
