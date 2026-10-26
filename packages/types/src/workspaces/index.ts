/**
 * Workspace Types
 *
 * Declared in this package: the rows in ./rows.js (the database proves its
 * inferred rows equal), the settings/layout shapes in ./settings.js and the
 * definition input in ./definition.js (the database imports both).
 */

export type {
  Workspace,
  NewWorkspace,
  WorkspaceMember,
  NewWorkspaceMember,
  WorkspaceInvite,
  NewWorkspaceInvite,
} from "./rows.js";
export type {
  // Workspace settings/layout types (canonical source of truth)
  WorkspaceSidebarItem,
  WorkspaceSidebarSection,
  WorkspaceLayoutConfig,
  McpServerConfig,
} from "./settings.js";
// Workspace definition (used by createFromDefinition — apps, presets, packages)
export type { WorkspaceDefinitionInput } from "./definition.js";

// Derived types for API convenience
import type { Workspace, WorkspaceMember } from "./rows.js";

export type WorkspaceType = Workspace["workspaceType"];
export type WorkspaceRole = WorkspaceMember["role"];

// Input types for API operations
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  type?: WorkspaceType;
}

export interface UpdateWorkspaceInput {
  name?: string;
  description?: string;
  settings?: Record<string, unknown>;
}

export interface InviteMemberInput {
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
}

// Governed space operations + the space role sets — ONE rule, pod and clients.
export {
  SPACE_WRITE_ROLES,
  SPACE_MANAGE_ROLES,
  isSpaceWriteRole,
  isSpaceManageRole,
  isSpaceRenamePayload,
  classifySpaceOperation,
  type SpaceOperation,
} from "./space-ops.js";
