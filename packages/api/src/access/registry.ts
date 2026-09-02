/**
 * Visibility registry — the actual per-table scoping declarations.
 *
 * Importing this module registers every scoped table. `access/index.ts` imports
 * it for its side effects so the registry is populated before any route reads
 * through `scopedDb()`. Add a line here when a new workspace/user-scoped table
 * becomes readable through the access layer — the read tripwire will tell you
 * when one is missing.
 */

import { db } from "@synap/database";
import {
  automations,
  automationRuns,
  mcpServers,
  cellInstances,
  roles,
  channels,
  artifacts,
  tools,
  playbooks,
  links,
  playbookRuns,
  relationDefs,
  widgetDefinitions,
  intelligenceCommands,
  entities,
  documents,
  relations,
  entityFacets,
  proposals,
  secrets,
  apiKeys,
  notifications,
  feeds,
  inboxItems,
  messagingAccounts,
  sourceConfigs,
  sourceSubscriptions,
  userPreferences,
  userResourceState,
  agentConfigs,
} from "@synap/database/schema";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { registerVisibility } from "./visibility.js";
import { channelVisibilityWhere } from "../utils/channel-visibility.js";
import { accessScopeWhere } from "../utils/project-scope.js";
import {
  workspaceLensWhere,
  podMemberWhere,
} from "../utils/user-visible-where.js";

// ── Workspace-scoped: visible = pod-wide (NULL) OR a workspace the user is in ──
registerVisibility({
  table: automations,
  query: () => db.query.automations,
  rule: {
    kind: "workspace",
    workspaceColumn: automations.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: automationRuns,
  query: () => db.query.automationRuns,
  rule: {
    kind: "workspace",
    workspaceColumn: automationRuns.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: mcpServers,
  query: () => db.query.mcpServers,
  rule: {
    kind: "workspace",
    workspaceColumn: mcpServers.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: cellInstances,
  query: () => db.query.cellInstances,
  rule: {
    kind: "workspace",
    workspaceColumn: cellInstances.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: roles,
  query: () => db.query.roles,
  rule: {
    kind: "workspace",
    workspaceColumn: roles.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: channels,
  query: () => db.query.channels,
  // Channels need CUSTOM visibility, not the flat `workspace` rule: a channel's
  // workspace_id = NULL means "personal" (owner-private), but the `workspace`
  // rule treats a NULL workspace column as a pod-wide GLOBAL (visible to
  // everyone) — which would leak every user's personal channels. The custom
  // predicate encodes the correct semantics (own / explicit-member /
  // shared-type-in-accessible-workspace).
  rule: {
    kind: "custom",
    predicate: (access) => channelVisibilityWhere(access.userId),
    // A NULL-workspace personal channel is owner-private (channelVisibilityWhere
    // owner-gates it); only shared-TYPE NULL channels go pod-wide.
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: artifacts,
  query: () => db.query.artifacts,
  rule: {
    kind: "workspace",
    workspaceColumn: artifacts.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});

// Playbooks & Capability Substrate — all three carry a nullable workspaceId
// (NULL = pod-wide config visible to every workspace).
registerVisibility({
  table: tools,
  query: () => db.query.tools,
  rule: {
    kind: "workspace",
    workspaceColumn: tools.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: playbooks,
  query: () => db.query.playbooks,
  rule: {
    kind: "workspace",
    workspaceColumn: playbooks.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: links,
  query: () => db.query.links,
  rule: {
    kind: "workspace",
    workspaceColumn: links.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: playbookRuns,
  query: () => db.query.playbookRuns,
  rule: {
    kind: "workspace",
    workspaceColumn: playbookRuns.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});

// SUBSTRATE config — NULL workspace = pod-wide builtin/base config that EVERY
// workspace needs (base relation types, builtin widgets), so globals stay
// visible inside a focused workspace (`includeGlobalsInLens: true`). userId here
// is creator-attribution, NOT a visibility floor.
registerVisibility({
  table: relationDefs,
  query: () => db.query.relationDefs,
  rule: {
    kind: "workspace",
    workspaceColumn: relationDefs.workspaceId,
    includeGlobalsInLens: true,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: widgetDefinitions,
  query: () => db.query.widgetDefinitions,
  rule: {
    kind: "workspace",
    workspaceColumn: widgetDefinitions.workspaceId,
    includeGlobalsInLens: true,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});

// Operational workspace config — but with a per-COMMAND sharing scope:
// `sharedScope='workspace'` = shared with the workspace's members (member-shared,
// focused-workspace-narrowed like other config); `sharedScope='user'` =
// creator-private (visible ONLY to `createdBy`, never to teammates who share the
// workspace). The flat `workspace` rule IGNORED `sharedScope`, so a user-private
// command LEAKED to every member of its workspace — this custom predicate ORs the
// two scopes so a private command is floored on its creator.
registerVisibility({
  table: intelligenceCommands,
  query: () => db.query.intelligenceCommands,
  rule: {
    kind: "custom",
    predicate: (access) =>
      or(
        and(
          eq(intelligenceCommands.sharedScope, "workspace"),
          workspaceLensWhere(
            intelligenceCommands.workspaceId,
            access.userId,
            access.workspaceLens
          )
        ),
        and(
          eq(intelligenceCommands.sharedScope, "user"),
          eq(intelligenceCommands.createdBy, access.userId)
        )
      ),
    // Operational config: a `sharedScope='workspace'` NULL-workspace command is
    // pod-wide (visible to members); the `sharedScope='user'` branch owner-gates
    // the private ones. Config-dominant → podGlobalConfig.
    nullWorkspaceMeans: "podGlobalConfig",
  },
});

// ── DATA tables (nullable workspace_id → pod-wide-capable) ────────────────────
// These converge on ONE resolver: the user floor is the union of pod-personal
// (NULL workspace, owner-gated), workspace-member access, and exposure
// membership; both lenses only narrow. entities/documents declare a `custom`
// rule delegating to `accessScopeWhere` (the canonical DATA-table resolver —
// the same predicate documents.list / entities' entityVisibleWhere now use), so
// a scopedDb read of either table is floored identically to the hand-rolled
// path. `relations` are shared when workspace-scoped, but a NULL-workspace edge
// stays owner-private because it has no collaborative boundary. `proposals` has NO human-
// owner column (its `createdBy` is the AGENT user id for AI-authored proposals),
// so it CANNOT be floored by an owner column without hiding AI proposals from
// the human reviewer; it stays on the flat `workspace` floor (pod-wide NULL OR a
// member workspace) — the same predicate proposals.list reaches for via
// userVisibleWhere — until a human-owner column exists to floor it on.

registerVisibility({
  table: entities,
  query: () => db.query.entities,
  rule: {
    kind: "custom",
    predicate: (access) =>
      accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId: access.userId,
        workspaceLens: access.workspaceLens,
        projectLens: access.projectLens,
        exposureRelationTypes: access.exposureRelationTypes,
        // Role-as-lens (Membership → Visibility): a pod-wide entity is visible to
        // a workspace's members once it carries a facet there. `entities` only —
        // `entity_facets.entity_id` maps to `entities.id` (documents have no
        // facets, so their rule below stays owner/workspace-floored).
        facetLens: true,
      }),
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: documents,
  query: () => db.query.documents,
  rule: {
    kind: "custom",
    predicate: (access) =>
      accessScopeWhere({
        workspaceIdColumn: documents.workspaceId,
        entityIdColumn: documents.id,
        ownerColumn: documents.userId,
        userId: access.userId,
        workspaceLens: access.workspaceLens,
        projectLens: access.projectLens,
        exposureRelationTypes: access.exposureRelationTypes,
      }),
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: relations,
  query: () => db.query.relations,
  // Workspace relations are collaboration data, while pod-wide relations have
  // no collaborative boundary and stay private to their author. This mirrors
  // entity-facet semantics: workspace rows follow membership; NULL rows retain
  // an owner floor. A flat `workspace` rule would leak private pod-wide edges.
  rule: {
    kind: "custom",
    predicate: (access) =>
      or(
        and(
          isNotNull(relations.workspaceId),
          workspaceLensWhere(
            relations.workspaceId,
            access.userId,
            access.workspaceLens
          )
        ),
        and(isNull(relations.workspaceId), eq(relations.userId, access.userId))
      ),
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: proposals,
  query: () => db.query.proposals,
  // NO human-owner column yet (createdBy = AGENT id for AI proposals), so a
  // NULL-workspace proposal is pod-wide TODAY — flagged podGlobalConfig to state
  // the current behaviour; a subjectUserId column (D7) is the real owner floor.
  rule: {
    kind: "workspace",
    workspaceColumn: proposals.workspaceId,
    nullWorkspaceMeans: "podGlobalConfig",
  },
});
registerVisibility({
  table: entityFacets,
  query: () => db.query.entityFacets,
  // Facet visibility POLICY (access-layer twin of the single-lens predicate
  // in @synap/database utils/facet-visibility.ts — keep the two in sync):
  // workspace-scoped facets are shared with the workspace's members, exactly
  // like the entities they dress; pod-wide (NULL-workspace) facets carry an
  // OWNER floor so they never leak via the flat `workspace` rule. NOT
  // `workspaceOwned` (owner-only on ALL rows) — that would hide a member's
  // facets from teammates on shared entities.
  //
  // Wave 2 (Membership → Visibility): the pod-wide branch ALSO admits any caller
  // who is a `pod_members` row — a pod-wide facet is the pod-level share signal,
  // the twin of the workspace branch above. Widening-only, pod-wide rows only; a
  // non-pod-member still sees just their own (the EXISTS is false → fail closed).
  rule: {
    kind: "custom",
    predicate: (access) =>
      or(
        and(
          isNotNull(entityFacets.workspaceId),
          workspaceLensWhere(
            entityFacets.workspaceId,
            access.userId,
            access.workspaceLens,
            { includeGlobals: false }
          )
        ),
        and(
          isNull(entityFacets.workspaceId),
          or(
            eq(entityFacets.userId, access.userId),
            podMemberWhere(access.userId)
          )
        )
      ),
    nullWorkspaceMeans: "ownerPrivate",
  },
});

// ── USER-PRIVATE tables (per-user floor; a NULL workspace is NEVER pod-wide) ──
// These carry a NOT-NULL per-user owner and are read back only by (or on behalf
// of) that user. Their floor is `eq(userId)` — the tightest rule — matching what
// every current read hand-rolls today (verified across the routers). This is a
// FLOOR declaration, not a behaviour change: raw reads are unaffected until they
// convert to scopedDb, and a converted read floors to exactly the same rows.
//
// CROWN JEWELS — `secrets` + `apiKeys`: `user` (= `eq(userId)`) is deliberately
// the NARROWEST rule so registration can never widen a credential read. The
// broader reads that legitimately exist (secrets service-credential resolution
// by serviceId; apiKeys admin/workspace listings) run on podAdmin/workspace-gated
// or pod-internal paths and are NOT converted here — narrowing them onto this
// owner floor would break credential resolution, so they stay raw (ledgered).
registerVisibility({
  table: secrets,
  query: () => db.query.secrets,
  rule: { kind: "user", userColumn: secrets.userId },
});
registerVisibility({
  table: apiKeys,
  query: () => db.query.apiKeys,
  rule: { kind: "user", userColumn: apiKeys.userId },
});
registerVisibility({
  table: notifications,
  query: () => db.query.notifications,
  // `userId` is the RECIPIENT — a notification belongs to exactly one user.
  rule: { kind: "user", userColumn: notifications.userId },
});
registerVisibility({
  table: inboxItems,
  query: () => db.query.inboxItems,
  // External items (email/calendar/slack) ingested per user; every read floors
  // by `userId` alone (the nullable workspaceId is a tag, not a read lens).
  rule: { kind: "user", userColumn: inboxItems.userId },
});
registerVisibility({
  table: messagingAccounts,
  query: () => db.query.messagingAccounts,
  // CREDENTIAL-BEARING — `metadata` jsonb carries provider tokens/scopes, so the
  // owner floor is deliberately the narrowest rule (same reasoning as apiKeys /
  // secrets above). The one read that legitimately cannot be user-scoped is the
  // INBOUND webhook lookup by (externalId, provider) — resolving the owning user
  // is its entire purpose — and it runs on raw `db`, not scopedDb
  // (routers/webhooks-inbound.ts:720), so this floor does not narrow it.
  rule: { kind: "user", userColumn: messagingAccounts.userId },
});
registerVisibility({
  table: userPreferences,
  query: () => db.query.userPreferences,
  // PK IS `userId` — one row per user, strictly private.
  rule: { kind: "user", userColumn: userPreferences.userId },
});
registerVisibility({
  table: userResourceState,
  query: () => db.query.userResourceState,
  // Composite key (userId, resourceId, resourceType); state is
  // strictly per-user. No workspace column.
  rule: { kind: "user", userColumn: userResourceState.userId },
});

// ── USER-OWNED, workspace-lensed tables (owner floor AND workspace lens) ──────
// Same shape as `relations`: a NOT-NULL `userId` owner plus a nullable
// workspaceId. `workspaceOwned` keeps a NULL-workspace row OWNER-private (never
// pod-wide via the flat `workspace` rule's IS-NULL branch) while still letting a
// workspace lens narrow. Every current read floors by `eq(userId)`, so this
// declaration matches (the added membership floor only narrows, and the owner is
// always a member of any workspace they filed a row into).
registerVisibility({
  table: feeds,
  query: () => db.query.feeds,
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: feeds.workspaceId,
    userColumn: feeds.userId,
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: sourceConfigs,
  query: () => db.query.sourceConfigs,
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: sourceConfigs.workspaceId,
    userColumn: sourceConfigs.userId,
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: sourceSubscriptions,
  query: () => db.query.sourceSubscriptions,
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: sourceSubscriptions.workspaceId,
    userColumn: sourceSubscriptions.userId,
    nullWorkspaceMeans: "ownerPrivate",
  },
});
registerVisibility({
  table: agentConfigs,
  query: () => db.query.agentConfigs,
  // Config keyed on (userId, workspaceId, agentType). The workspace is part of
  // the KEY; the owner floor is `userId`. Reads floor by `eq(userId)` (+ the key
  // workspace), which `workspaceOwned` reproduces.
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: agentConfigs.workspaceId,
    userColumn: agentConfigs.userId,
    nullWorkspaceMeans: "ownerPrivate",
  },
});

// NOTE: entityTemplates (bespoke userVisibleWhere in templates.list — its
// conditional includePublic semantics don't match a uniform rule) and `profiles`
// (a 4-way scope enum + grant-table EXISTS, still read through
// ProfileRepository.getAccessibleProfiles, NOT scopedDb) are intentionally NOT
// registered yet — see the `custom`-rule note in visibility.ts. Register
// `profiles` only once its reads actually flow through scopedDb, with a
// predicate co-located with its repo.
