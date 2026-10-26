/**
 * Workspaces Schema - Multi-user workspace support
 *
 * A workspace can be:
 * - Personal (single user)
 * - Team (multiple users with roles)
 * - Enterprise (advanced features)
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { users } from "./users.js";

// ── Settings shapes ─────────────────────────────────────────────────────────
//
// `workspaces.settings` and every shape it carries are declared once in
// `@synap-core/types/workspaces/settings` (the wire shape every client reads);
// imported here to type the column and re-exported for pod code.

import type {
  ProactiveAiPreferences,
  WorkspaceSettings,
} from "@synap-core/types/workspaces/settings";

export type {
  WorkspaceSidebarSurfacePlacement,
  WorkspaceSidebarSurfaceDisplayMode,
  WorkspaceSidebarAppRendererType,
  WorkspaceSidebarSurface,
  WorkspaceSidebarItem,
  WorkspaceSidebarSection,
  WorkspaceJsonValue,
  WorkspacePrimarySurface,
  WorkspacePrimarySurfaceViewReference,
  WorkspacePrimarySurfaceDefinition,
  WorkspaceLayoutConfig,
  WorkspaceLayoutDefinition,
  McpServerConfig,
  ProactiveNudgeDensity,
  EveAiProviderId,
  EveProviderRoutingPolicy,
  ProactiveAiPreferences,
  ProactiveAiTriggers,
  SignalSurface,
  SurfaceTarget,
  SignalDeliveryRule,
  DeliveryPreferences,
  AgentRoutingMatch,
  AgentRoutingRule,
  AgentRoutingPolicy,
  WorkspaceVisibility,
  WorkspaceSourceRole,
  WorkspaceDefaultSource,
  CrmWorkspacePolicy,
  WorkspaceComposedFromEntry,
  PublicProjectionSettings,
  WorkspaceSpaceBriefCollectTarget,
  WorkspaceSpaceBriefExpertise,
  WorkspaceSpaceBriefAnchor,
  WorkspaceSpaceBriefFetchHint,
  WorkspaceSpaceBriefRuleRef,
  WorkspaceSpaceSkillMode,
  WorkspaceSpaceBriefSkillRef,
  WorkspaceSpaceBrief,
  WorkspaceSpaceTemplateRule,
  SpaceBriefSeed,
  WorkspaceIntentSettings,
  WorkspaceSettings,
} from "@synap-core/types/workspaces/settings";

/** Default proactive AI preferences for new workspaces */
export function getDefaultProactiveAiPreferences(): ProactiveAiPreferences {
  return {
    enabled: true,
    morningBriefing: {
      enabled: true,
      cronHour: 8,
      cronMinute: 0,
      timezone: "UTC",
    },
    weeklyDigest: {
      enabled: true,
      dayOfWeek: 1,
      cronHour: 9,
      timezone: "UTC",
    },
    healthCheck: {
      enabled: true,
      frequencyDays: 7,
    },
    nudgeDensity: "balanced",
    triggers: {
      captureCluster: false,
      taskCompleted: false,
      questionCreated: false,
      decisionCreated: false,
    },
  };
}

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Ownership
    ownerId: text("owner_id").notNull(),

    // Metadata
    name: text("name").notNull(),
    description: text("description"),
    domain: text("domain"),
    // type column removed (migration 0153) — workspace_type is canonical

    // Settings (JSONB for flexibility)
    settings: jsonb("settings")
      .$type<WorkspaceSettings>()
      .default({})
      .notNull(),
    // {
    //   defaultEntityTypes: ['note', 'task'],
    //   theme: 'light',
    //   aiEnabled: true,
    //   allowExternalSharing: false
    // }

    // Hot settings keys promoted to real indexed columns (migration 0039) for fast
    // lookups (pod-admin resolver) + provisioning idempotency. settings JSONB is
    // still dual-written for back-compat; query predicates use these columns.
    systemSlug: text("system_slug"),
    packageSlug: text("package_slug"),
    provisioningProposalId: text("provisioning_proposal_id"),
    provisioningStatus: text("provisioning_status"),
    // Promoted from settings JSONB (migration 0042) for indexed lookup of agent workspaces.
    workspaceType: text("workspace_type").notNull().default("personal"),

    // Billing (optional - for managed hosting)
    subscriptionTier: text("subscription_tier"), // 'solo', 'pro', 'team', 'enterprise'
    subscriptionStatus: text("subscription_status"), // 'active', 'canceled', 'past_due', 'trialing'
    stripeCustomerId: text("stripe_customer_id"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    // Soft-archive: when set, the workspace is hidden from default list queries.
    // Restore by setting back to NULL. Added in migration 0020.
    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    // Workspace identity (0308, founder 2026-10-06): POD-WIDE, no user link —
    // no two ACTIVE spaces share a name (case/space-insensitive), and no two
    // ACTIVE spaces come from the same template. Archived rows are free.
    // Write doors map SQLSTATE 23505 to `WorkspaceIdentityConflictError`.
    // Required at boot by `findMissingIndexes` (schema-coherence.ts).
    activeNameUnique: uniqueIndex("workspaces_active_name_unique")
      .on(sql`lower(btrim(${table.name}))`)
      .where(sql`${table.archivedAt} IS NULL`),
    activePackageSlugUnique: uniqueIndex(
      "workspaces_active_package_slug_unique"
    )
      .on(table.packageSlug)
      .where(
        sql`${table.packageSlug} IS NOT NULL AND ${table.archivedAt} IS NULL`
      ),
  })
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // References
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").notNull(),

    // Role-based access
    role: text("role").notNull(), // 'owner' | 'admin' | 'editor' | 'viewer'

    // Metadata
    joinedAt: timestamp("joined_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    invitedBy: text("invited_by"), // userId of inviter
  },
  (table) => ({
    // One membership row per (workspace, user). Without this, code using
    // onConflictDoNothing() (e.g. enroll-agent) does NOT actually dedup and can
    // insert duplicate member rows. See migration 0164.
    workspaceUserUnique: uniqueIndex(
      "workspace_members_workspace_user_unique"
    ).on(table.workspaceId, table.userId),
  })
);

export const podMembers = pgTable(
  "pod_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // The user who belongs to this pod. The pod is a SINGLETON deployment
    // (there is no `pods` table / `pod_id`), so membership is keyed on user_id.
    userId: text("user_id").notNull(),

    // Pod-level role: 'owner' | 'admin' | 'member'
    podRole: text("pod_role").notNull(),

    // userId of the inviter (nullable — backfilled / owner rows have none)
    invitedBy: text("invited_by"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),

    // Set by `workspaces.removeFromPod` when the person is left with no space;
    // cleared by a new pod invite. The row is access ONLY while this is NULL
    // (0357, founder Q-B1): read it through `livePodMemberWhere`.
    removedAt: timestamp("removed_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    // One pod-membership row per user. Lets onConflictDoNothing() actually dedup.
    podMembersUserUnique: uniqueIndex("pod_members_user_unique").on(
      table.userId
    ),
  })
);

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),

  // Type: 'workspace' (scoped to one workspace) | 'pod' (all workspaces)
  type: text("type").notNull().$type<"workspace" | "pod">(),

  // Only set for workspace invites
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),

  // Invite details
  email: text("email").notNull(),
  role: text("role").notNull(), // 'admin' | 'editor' | 'viewer'
  // Plaintext link token: EXPAND phase only (0353), written for the previous
  // release's rollback; never read except as the fallback for a digest-less row.
  token: text("token").notNull().unique(),
  // SHA-256 (hex) of the token: the ONE lookup key (`findInviteByToken`).
  tokenDigest: text("token_digest").unique(),

  // Metadata
  invitedBy: text("invited_by").notNull(), // userId
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * The durable trace of an ACCEPTED invite. The `invites` row is deleted on
 * acceptance (every accept path), so nothing else records which person a
 * given invite let in, or when. One row per invite, written by
 * `recordInviteAcceptance` (`@synap/database`) at each accept path, just
 * before the invite row goes.
 *
 * Read by the application-connection "invite is the consent" rule: a person
 * who joined this Pod by invite may link their Synap account without a second
 * owner approval, while the invite's OWN validity window (`invite_expires_at`,
 * copied from `invites.expires_at`) has not closed.
 */
export const inviteAcceptances = pgTable(
  "invite_acceptances",
  {
    inviteId: uuid("invite_id").primaryKey(),
    userId: text("user_id").notNull(),
    inviteType: text("invite_type").notNull().$type<"workspace" | "pod">(),
    /** The address the invite was sent to, lower-cased. */
    invitedEmail: text("invited_email").notNull(),
    invitedBy: text("invited_by").notNull(),
    inviteExpiresAt: timestamp("invite_expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    acceptedAt: timestamp("accepted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdx: index("invite_acceptances_user_idx").on(table.userId),
  })
);

// Relations
export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  invites: many(invites),
}));

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  })
);

export const invitesRelations = relations(invites, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [invites.workspaceId],
    references: [workspaces.id],
  }),
}));

// Type exports
// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// Workspaces
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertWorkspaceSchema = createInsertSchema(workspaces);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectWorkspaceSchema = createSelectSchema(workspaces);

// Members
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertWorkspaceMemberSchema = createInsertSchema(workspaceMembers);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectWorkspaceMemberSchema = createSelectSchema(workspaceMembers);

// Invites (unified — workspace + pod)
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
// Backward-compat aliases (workspaceInvites table was renamed to invites in 0058)
export type WorkspaceInvite = Invite;
export type NewWorkspaceInvite = NewInvite;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertInviteSchema = createInsertSchema(invites);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectInviteSchema = createSelectSchema(invites);
