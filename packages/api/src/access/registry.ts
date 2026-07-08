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
} from "@synap/database/schema";
import { registerVisibility } from "./visibility.js";
import { channelVisibilityWhere } from "../utils/channel-visibility.js";
import { accessScopeWhere } from "../utils/project-scope.js";

// ── Workspace-scoped: visible = pod-wide (NULL) OR a workspace the user is in ──
registerVisibility({
  table: automations,
  query: () => db.query.automations,
  rule: { kind: "workspace", workspaceColumn: automations.workspaceId },
});
registerVisibility({
  table: automationRuns,
  query: () => db.query.automationRuns,
  rule: { kind: "workspace", workspaceColumn: automationRuns.workspaceId },
});
registerVisibility({
  table: mcpServers,
  query: () => db.query.mcpServers,
  rule: { kind: "workspace", workspaceColumn: mcpServers.workspaceId },
});
registerVisibility({
  table: cellInstances,
  query: () => db.query.cellInstances,
  rule: { kind: "workspace", workspaceColumn: cellInstances.workspaceId },
});
registerVisibility({
  table: roles,
  query: () => db.query.roles,
  rule: { kind: "workspace", workspaceColumn: roles.workspaceId },
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
  },
});
registerVisibility({
  table: artifacts,
  query: () => db.query.artifacts,
  rule: { kind: "workspace", workspaceColumn: artifacts.workspaceId },
});

// Playbooks & Capability Substrate — all three carry a nullable workspaceId
// (NULL = pod-wide config visible to every workspace).
registerVisibility({
  table: tools,
  query: () => db.query.tools,
  rule: { kind: "workspace", workspaceColumn: tools.workspaceId },
});
registerVisibility({
  table: playbooks,
  query: () => db.query.playbooks,
  rule: { kind: "workspace", workspaceColumn: playbooks.workspaceId },
});
registerVisibility({
  table: links,
  query: () => db.query.links,
  rule: { kind: "workspace", workspaceColumn: links.workspaceId },
});
registerVisibility({
  table: playbookRuns,
  query: () => db.query.playbookRuns,
  rule: { kind: "workspace", workspaceColumn: playbookRuns.workspaceId },
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
  },
});
registerVisibility({
  table: widgetDefinitions,
  query: () => db.query.widgetDefinitions,
  rule: {
    kind: "workspace",
    workspaceColumn: widgetDefinitions.workspaceId,
    includeGlobalsInLens: true,
  },
});

// Operational workspace config (member-shared; NOT substrate) — a focused
// workspace shows only its own rows, pod-wide rows surface in the user-wide view.
registerVisibility({
  table: intelligenceCommands,
  query: () => db.query.intelligenceCommands,
  rule: {
    kind: "workspace",
    workspaceColumn: intelligenceCommands.workspaceId,
  },
});

// ── DATA tables (nullable workspace_id → pod-wide-capable) ────────────────────
// These converge on ONE resolver: the user floor is the union of pod-personal
// (NULL workspace, owner-gated), workspace-member access, and exposure
// membership; both lenses only narrow. entities/documents declare a `custom`
// rule delegating to `accessScopeWhere` (the canonical DATA-table resolver —
// the same predicate documents.list / entities' entityVisibleWhere now use), so
// a scopedDb read of either table is floored identically to the hand-rolled
// path. `relations` carries a NOT-NULL `userId` owner, so it uses
// `workspaceOwned` (owner floor AND workspace lens) — a NULL-workspace edge
// stays owner-private instead of leaking pod-wide. `proposals` has NO human-
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
      }),
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
      }),
  },
});
registerVisibility({
  table: relations,
  query: () => db.query.relations,
  // `relations.userId` (NOT NULL) is the OWNER floor — the agent-key identity
  // remap (hub/MCP) sets it to the operator the agent acts for, so a NULL-
  // workspace (pod-personal) edge stays visible only to its owner instead of
  // leaking pod-wide via the flat `workspace` rule's `IS NULL` branch.
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: relations.workspaceId,
    userColumn: relations.userId,
  },
});
registerVisibility({
  table: proposals,
  query: () => db.query.proposals,
  rule: { kind: "workspace", workspaceColumn: proposals.workspaceId },
});
registerVisibility({
  table: entityFacets,
  query: () => db.query.entityFacets,
  // `entityFacets.userId` (NOT NULL) is the OWNER floor, same reasoning as
  // `relations`: a NULL-workspace (pod-wide) facet stays visible only to its
  // owner instead of leaking pod-wide via the flat `workspace` rule.
  rule: {
    kind: "workspaceOwned",
    workspaceColumn: entityFacets.workspaceId,
    userColumn: entityFacets.userId,
  },
});

// NOTE: entityTemplates (bespoke userVisibleWhere in templates.list — its
// conditional includePublic semantics don't match a uniform rule) and `profiles`
// (a 4-way scope enum + grant-table EXISTS, still read through
// ProfileRepository.getAccessibleProfiles, NOT scopedDb) are intentionally NOT
// registered yet — see the `custom`-rule note in visibility.ts. Register
// `profiles` only once its reads actually flow through scopedDb, with a
// predicate co-located with its repo.
