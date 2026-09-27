/**
 * Workspace Types
 *
 * Re-exports workspace types from database schema (single source of truth).
 *
 * @see {@link @synap/database/schema}
 */

// Direct re-exports from database
export type {
  Workspace,
  NewWorkspace,
  WorkspaceMember,
  NewWorkspaceMember,
  WorkspaceInvite,
  NewWorkspaceInvite,
  // Workspace settings/layout types (canonical source of truth)
  WorkspaceSidebarItem,
  WorkspaceSidebarSection,
  WorkspaceLayoutConfig,
  McpServerConfig,
  // Workspace definition (used by createFromDefinition — apps, presets, packages)
  WorkspaceDefinitionInput,
} from "@synap/database";

// Derived types for API convenience
import type { Workspace, WorkspaceMember } from "@synap/database";

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
