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
} from "@synap/database/schema";
import { registerVisibility } from "./visibility.js";

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
  rule: { kind: "workspace", workspaceColumn: channels.workspaceId },
});

// NOTE: only tables actually READ through scopedDb() are registered here.
// entities/proposals (own scoping) and entityTemplates (bespoke userVisibleWhere
// in templates.list — its conditional includePublic semantics don't match a
// uniform rule) are intentionally NOT registered.
