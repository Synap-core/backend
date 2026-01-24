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
} from "../../../database/src/schema/index.js";

// Derived types for API convenience
import type {
  Workspace,
  WorkspaceMember,
} from "../../../database/src/schema/index.js";

export type WorkspaceType = Workspace["type"];
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
