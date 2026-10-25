/**
 * Compile-time contract: the workspace rows `@synap-core/types/workspaces`
 * declares are EXACTLY the rows inferred from this package's tables
 * (`schema/workspaces.ts`), and the definition's `WorkspaceIntentDefinition` is
 * EXACTLY what the install doors' zod accepts (`utils/workspace-intent.ts`).
 * No runtime code. (`WorkspaceSettings` and the definition input are not
 * copied: this package imports them from `@synap-core/types/workspaces/*`.)
 */
import type {
  Workspace as WireWorkspace,
  NewWorkspace as WireNewWorkspace,
  WorkspaceMember as WireWorkspaceMember,
  NewWorkspaceMember as WireNewWorkspaceMember,
  WorkspaceInvite as WireWorkspaceInvite,
  NewWorkspaceInvite as WireNewWorkspaceInvite,
} from "@synap-core/types/workspaces";
import type { WorkspaceIntentDefinition as WireWorkspaceIntentDefinition } from "@synap-core/types/workspaces/definition";
import type {
  Workspace,
  NewWorkspace,
  WorkspaceMember,
  NewWorkspaceMember,
  WorkspaceInvite,
  NewWorkspaceInvite,
} from "../schema/workspaces.js";
import type { WorkspaceIntentDefinition } from "../utils/workspace-intent.js";
import type { Equal, Flat } from "./equal.js";

export const _workspace: Equal<Workspace, WireWorkspace> = true;
export const _newWorkspace: Equal<NewWorkspace, WireNewWorkspace> = true;
export const _workspaceMember: Equal<WorkspaceMember, WireWorkspaceMember> =
  true;
export const _newWorkspaceMember: Equal<
  NewWorkspaceMember,
  WireNewWorkspaceMember
> = true;
export const _workspaceInvite: Equal<WorkspaceInvite, WireWorkspaceInvite> =
  true;
export const _newWorkspaceInvite: Equal<
  NewWorkspaceInvite,
  WireNewWorkspaceInvite
> = true;
export const _intentDefinition: Equal<
  Flat<WorkspaceIntentDefinition>,
  WireWorkspaceIntentDefinition
> = true;
