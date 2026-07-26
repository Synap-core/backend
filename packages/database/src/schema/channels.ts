/**
 * Channels Schema — V2
 *
 * A channel is a conversation surface with a context scope.
 * 7 canonical types (V2 spec) replace legacy chat channel variants:
 * personal, thread, sub_thread, feed, external, agent_collab, group
 * (`group` — multi-human + multi-AI — was added after the original V2 6).
 * `channelPurpose` is removed — absorbed into channelType.
 * `scope` and `feedScope` are new.
 *
 * See synap-team-docs/content/team/platform/channel-system.mdx for the spec.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { isNotNull, sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

/**
 * Channel Types (V2) — 7 canonical types per the channel-system spec
 * (the original 6 plus GROUP, added for multi-human + multi-AI rooms).
 *
 * PERSONAL     — The user's permanent AI assistant channel — pod-wide. One per
 *                user across the entire data pod. AI always active.
 *                (Was: `thread` + `threadKind=personal` during the drift phase.)
 * THREAD       — A conversation linked to a specific context object
 *                (workspace, entity, document, view, project, task).
 *                AI participation controlled by agentType.
 * SUB_THREAD   — A specialised sub-agent task spawned within a parent channel.
 *                Always has parentChannelId. AI always active.
 *                (Was: `thread` + `threadKind=branch` during the drift phase.)
 * FEED         — Proactive AI broadcast channel. AI posts, users read.
 *                feedScope determines user-level vs workspace-level.
 * EXTERNAL     — Ingested conversation from an external platform (WhatsApp, Slack, Gmail, etc.)
 *                Reply routing is capability/toggle-based and only active when connector is live.
 * AGENT_COLLAB — Internal multi-agent collaboration channel (persistent, workspace-scoped).
 *                Visibility is restricted to workspace admin/owner for now.
 */
export const ChannelType = {
  THREAD: "thread",
  PERSONAL: "personal", // NEW (V2 restore) — was thread + threadKind=personal
  SUB_THREAD: "sub_thread", // NEW (V2 restore) — was thread + threadKind=branch
  FEED: "feed",
  EXTERNAL: "external",
  AGENT_COLLAB: "agent_collab",
  GROUP: "group", // multi-human + multi-AI channel (humans writable, AI on @mention)
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

/**
 * Channel Scope
 *
 * Controls visibility and filtering. Orthogonal to type.
 *
 * pod       — Visible across all workspaces (personal channel, user feed)
 * workspace — Scoped to a single workspace (thread, external, agent_collab)
 * user      — Reserved for future user-scoped surfaces
 */
export const ChannelScope = {
  POD: "pod",
  WORKSPACE: "workspace",
  USER: "user",
} as const;
export type ChannelScope = (typeof ChannelScope)[keyof typeof ChannelScope];

/**
 * Feed Scope (only for FEED type)
 *
 * user      — Personal proactive feed: morning briefing, insights, capture summaries
 * workspace — Workspace-wide feed: connector sync, automation results, team digests
 */
export const FeedScope = {
  USER: "user",
  WORKSPACE: "workspace",
} as const;
export type FeedScope = (typeof FeedScope)[keyof typeof FeedScope];

/**
 * Channel Status
 */
export const ChannelStatus = {
  ACTIVE: "active",
  MERGED: "merged",
  ARCHIVED: "archived",
} as const;
export type ChannelStatus = (typeof ChannelStatus)[keyof typeof ChannelStatus];

/**
 * Channel Agent Types
 *
 * Determines which AI agent handles messages in this channel.
 * Free string at DB level — IS handles unknown values gracefully (falls back to OrchestratorAgent).
 */
export const ChannelAgentType = {
  // Workspace-generalist co-founder AI (canonical alias: META)
  ORCHESTRATOR: "orchestrator",
  // "meta" is the public-facing name users/frontend see; both route to OrchestratorAgent
  META: "meta",
  // Personal assistant: user-centric, memory-first.
  PERSONAL: "personal",
  PROMPTING: "prompting",
  KNOWLEDGE_SEARCH: "knowledge-search",
  CODE: "code",
  WRITING: "writing",
  ACTION: "action",
  ONBOARDING: "onboarding",
  WORKSPACE_CREATION: "workspace-creation", // legacy key
  // Specialists
  INSIGHT_DISCOVERY: "insight-discovery",
  VIEW_BUILDER: "view-builder",
  WORKSPACE_BUILDER: "workspace-builder",
  // AI inactive — was DEFAULT (renamed to be unambiguous: "default" implied AI on, but it suppressed it)
  NONE: "none",
} as const;
export type ChannelAgentType =
  (typeof ChannelAgentType)[keyof typeof ChannelAgentType];

/**
 * AI Reaction Mode — per-channel "how do AI teammates react" control for
 * multiplayer (GROUP / AGENT_COLLAB) channels.
 *
 * only_mentioned — AI teammates respond ONLY when explicitly @mentioned.
 * when_confident — the routing engine may surface a teammate when it judges
 *                  the message in-scope for it (the default; least surprising
 *                  while still letting the room feel alive).
 * off            — no AI reactions at all; humans-only conversation.
 *
 * This is a routing hint consumed by the LATER routing-engine pass — it does
 * NOT gate writes (capabilities do that). Free at the DB level; the router
 * falls back to `when_confident` for unknown values.
 */
export const AiReactionMode = {
  ONLY_MENTIONED: "only_mentioned",
  WHEN_CONFIDENT: "when_confident",
  OFF: "off",
} as const;
export type AiReactionMode =
  (typeof AiReactionMode)[keyof typeof AiReactionMode];

export const channels = pgTable(
  "channels",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Workspace scope for listing/filtering; null = pod-scoped channel (personal-style thread, user feed). */
    workspaceId: uuid("workspace_id"),
    /**
     * Project scope (cross-cutting lens): pins a channel to a project so the
     * Room UI can filter by the active PROJECT lens, independently of
     * workspace_id (domain lens). Nullable — ordinary channels leave it NULL.
     * See 0171.
     */
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),

    // Channel metadata
    title: text("title"),
    channelType: text("channel_type", {
      enum: [
        ChannelType.THREAD,
        ChannelType.PERSONAL,
        ChannelType.SUB_THREAD,
        ChannelType.FEED,
        ChannelType.EXTERNAL,
        ChannelType.AGENT_COLLAB,
        ChannelType.GROUP,
      ],
    })
      .notNull()
      .default(ChannelType.THREAD),

    /**
     * Scope controls visibility across workspaces.
     * thread/external/agent_collab → workspace, feed → pod or workspace.
     */
    scope: text("scope", {
      enum: [ChannelScope.POD, ChannelScope.WORKSPACE, ChannelScope.USER],
    })
      .notNull()
      .default(ChannelScope.WORKSPACE),

    /**
     * Feed scope — only set for FEED type channels.
     * user = personal proactive feed; workspace = team-wide shared feed.
     */
    feedScope: text("feed_scope", {
      enum: [FeedScope.USER, FeedScope.WORKSPACE],
    }),

    // Context: what object this channel is "about"
    // Canonical contextObjectType values: workspace | entity | document | view |
    //   project | task | user | external
    contextObjectType: text("context_object_type"),
    contextObjectId: uuid("context_object_id"),

    // Thread hierarchy — sub_thread channels carry a parent reference.
    parentChannelId: uuid("parent_channel_id"), // Self-reference to channels.id
    branchedFromMessageId: uuid("branched_from_message_id"), // Reference to messages.id
    branchPurpose: text("branch_purpose"), // Task description for branch threads

    // Status
    status: text("status", {
      enum: [
        ChannelStatus.ACTIVE,
        ChannelStatus.MERGED,
        ChannelStatus.ARCHIVED,
      ],
    })
      .notNull()
      .default(ChannelStatus.ACTIVE),

    /**
     * Per-channel "how AI teammates react" control for multiplayer rooms.
     * Routing hint only — it never gates writes (capability flags do).
     * Defaults to `when_confident`. Consumed by the later routing-engine pass.
     */
    aiReactionMode: text("ai_reaction_mode", {
      enum: [
        AiReactionMode.ONLY_MENTIONED,
        AiReactionMode.WHEN_CONFIDENT,
        AiReactionMode.OFF,
      ],
    })
      .notNull()
      .default(AiReactionMode.WHEN_CONFIDENT),

    /** User-configurable overrides (personality, modelTier). Never store systemPrompt or toolsConfig here. */
    agentConfig: jsonb("agent_config"),

    /** MCP servers enabled for this channel. null = inherit no MCPs (opt-in model). */
    mcpServerIds: uuid("mcp_server_id").array(),

    /** The agent assigned to handle messages in this channel. Set at creation time. */
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),

    /** UUID of the agent that sent the first/most recent message in this channel. @deprecated use assignedAgentId */
    senderAgentId: uuid("sender_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),

    // Context (compressed summaries from merged sub-threads)
    contextSummary: text("context_summary"),

    // Branch thread result tracking
    resultSummary: text("result_summary"),
    mergedIntoStateId: uuid("merged_into_state_id"), // FK to compacted_states (circular dep — set in migration)

    // External source (for EXTERNAL channels; reply routing enabled only with live connector capability)
    externalSource: text("external_source"), // 'whatsapp' | 'slack' | 'gmail' | 'telegram' | 'sms' | 'openwebui' | ...
    externalChannelId: text("external_channel_id"), // ID of conversation in external system

    /**
     * External dedup key — used together with `externalSource` to upsert
     * channels created by sidecar pipelines (e.g. OWUI channel-sync). The
     * `(externalSource, externalId)` pair is uniquely indexed when
     * `externalId` is non-null, so concurrent inserts hit a deterministic
     * conflict and the caller can SELECT-then-return the surviving row.
     */
    externalId: text("external_id"),

    // Metadata
    // FEED channels: items may include per-item action metadata (primaryAction, secondaryActions).
    // EXTERNAL channels: relayEnabled + connectorLive gate outbound external reply routing.
    metadata: jsonb("metadata"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    mergedAt: timestamp("merged_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index("channels_user_id_idx").on(table.userId),
    workspaceIdIdx: index("channels_workspace_id_idx").on(table.workspaceId),
    projectIdIdx: index("channels_project_id_idx").on(table.projectId),
    parentChannelIdx: index("channels_parent_channel_id_idx").on(
      table.parentChannelId
    ),
    statusIdx: index("channels_status_idx").on(table.status),
    contextIdx: index("channels_context_idx").on(
      table.contextObjectType,
      table.contextObjectId
    ),
    scopeIdx: index("channels_scope_idx").on(table.scope),
    typeIdx: index("channels_type_idx").on(table.channelType),
    /**
     * Partial unique index over (externalSource, externalId), enforced only
     * when `externalId` is non-null — most channels have no external identity
     * and stay unconstrained. Pairs with the matching SQL in
     * 0017_channels_external_id.sql.
     */
    externalSourceIdUnique: uniqueIndex("channels_external_source_id_unique")
      .on(table.externalSource, table.externalId)
      .where(isNotNull(table.externalId)),
    /**
     * Partial unique indexes cut by migration 0182 (agent-personal, workspace-
     * group) + 0210 (feed, narrowed). Declared here so code and DB agree and
     * schema-coherence can see them — migrations remain the SSOT that creates
     * them (drizzle-kit is forbidden in this repo). Predicates MUST mirror the
     * SQL in 0000_baseline_schema.sql exactly.
     */
    userFeedUnique: uniqueIndex("channels_user_feed_uniq")
      .on(table.userId)
      // Narrowed by 0210: only the context-less PROACTIVE feed is one-per-user.
      // Automation run-recap feeds (context_object_type='automation') are also
      // feed-typed and must NOT collide — they dedup on context_object_id in code.
      .where(
        sql`${table.channelType} = 'feed' AND ${table.status} = 'active' AND ${table.contextObjectType} IS NULL`
      ),
    userAgentPersonalUnique: uniqueIndex("channels_user_agent_personal_uniq")
      .on(table.userId, table.assignedAgentId)
      // Agent-INSTANCE threads share assigned_agent_id with the template DM but
      // dedup on channel_members, so they are excluded via the metadata marker.
      .where(
        sql`${table.channelType} = 'personal' AND ${table.assignedAgentId} IS NOT NULL AND ${table.status} = 'active' AND (${table.metadata} ->> 'agentInstanceThread') IS NULL`
      ),
    userWorkspaceGroupUnique: uniqueIndex("channels_user_workspace_group_uniq")
      .on(table.userId, table.workspaceId)
      .where(
        sql`${table.channelType} = 'thread' AND ${table.contextObjectType} = 'workspace' AND ${table.status} = 'active'`
      ),
  })
);

/** Channel row — explicit interface so consumers don't need drizzle-orm to resolve it. */
export interface Channel {
  id: string;
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  title: string | null;
  channelType: ChannelType;
  scope: ChannelScope;
  feedScope: FeedScope | null;
  contextObjectType: string | null;
  contextObjectId: string | null;
  parentChannelId: string | null;
  branchedFromMessageId: string | null;
  branchPurpose: string | null;
  aiReactionMode: AiReactionMode;
  assignedAgentId: string | null;
  senderAgentId: string | null;
  status: ChannelStatus;
  contextSummary: string | null;
  resultSummary: string | null;
  mergedIntoStateId: string | null;
  externalSource: string | null;
  externalChannelId: string | null;
  externalId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
}
export type NewChannel = Partial<
  Omit<Channel, "id" | "createdAt" | "updatedAt">
> & {
  userId: string;
};

/**
 * Channel Member Kind — distinguishes a human user from an AI agent-user.
 */
export const ChannelMemberKind = {
  HUMAN: "human",
  AI_AGENT: "ai_agent",
} as const;
export type ChannelMemberKind =
  (typeof ChannelMemberKind)[keyof typeof ChannelMemberKind];

/**
 * Channel Member Role — owner (the creator) or a regular member.
 */
export const ChannelMemberRole = {
  OWNER: "owner",
  MEMBER: "member",
} as const;
export type ChannelMemberRole =
  (typeof ChannelMemberRole)[keyof typeof ChannelMemberRole];

/**
 * Channel Members — source of truth for GROUP channel membership.
 *
 * Replaces the legacy `metadata.participants` array. Each row links a channel
 * to a human user or an AI agent-user, with a role. Visibility queries join
 * against this table so group channels are visible to all their members, not
 * just the creator.
 */
export const channelMembers = pgTable(
  "channel_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** A user id OR an agent-user id (both live in the `users` table). */
    memberId: text("member_id").notNull(),
    memberKind: text("member_kind", {
      enum: [ChannelMemberKind.HUMAN, ChannelMemberKind.AI_AGENT],
    }).notNull(),
    role: text("role", {
      enum: [ChannelMemberRole.OWNER, ChannelMemberRole.MEMBER],
    })
      .notNull()
      .default(ChannelMemberRole.MEMBER),

    /**
     * Per-teammate capability flags — the effective per-channel grant that
     * feeds the governance gate (checkPermissionOrPropose) when an AI teammate
     * writes in THIS channel. Conservative defaults:
     *   canDraft   true  — may participate / produce draft content.
     *   canPropose true  — writes become PENDING proposals (reviewable).
     *   canAct     false — writes do NOT auto-commit unless explicitly granted.
     *
     * These are orthogonal to workspace RBAC: they can only RESTRICT a
     * teammate (route a write to a proposal / block commit), never widen its
     * RBAC. Absent/unknown flags resolve to the most restrictive interpretation
     * (propose, not act) in the capability→governance mapping.
     */
    canDraft: boolean("can_draft").notNull().default(true),
    canPropose: boolean("can_propose").notNull().default(true),
    canAct: boolean("can_act").notNull().default(false),

    /** The user id that added this member (the group creator). */
    addedBy: text("added_by"),
    /** When this member last read the channel — used to compute unread counts. */
    lastReadAt: timestamp("last_read_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    channelIdIdx: index("channel_members_channel_id_idx").on(table.channelId),
    memberIdIdx: index("channel_members_member_id_idx").on(table.memberId),
    channelMemberUnique: uniqueIndex(
      "channel_members_channel_member_unique"
    ).on(table.channelId, table.memberId),
  })
);

export type ChannelMember = typeof channelMembers.$inferSelect;
export type NewChannelMember = typeof channelMembers.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertChannelSchema = createInsertSchema(channels);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectChannelSchema = createSelectSchema(channels);
