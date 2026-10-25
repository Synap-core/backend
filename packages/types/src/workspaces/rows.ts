/**
 * Workspace rows on the wire — `workspaces`, `workspace_members`, `invites` as
 * the pod reads and inserts them.
 *
 * The pod's types are inferred from its drizzle tables; this package cannot see
 * those tables, so the wire shape is declared here and `@synap/database` proves
 * it equal to the inferred one (`src/wire-parity/workspaces.ts`): a column
 * added on one side only fails the database build.
 */

import type { WorkspaceSettings } from "./settings.js";

export interface Workspace {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  domain: string | null;
  settings: WorkspaceSettings;
  systemSlug: string | null;
  packageSlug: string | null;
  provisioningProposalId: string | null;
  provisioningStatus: string | null;
  workspaceType: string;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface NewWorkspace {
  id?: string;
  ownerId: string;
  name: string;
  description?: string | null;
  domain?: string | null;
  settings?: WorkspaceSettings;
  systemSlug?: string | null;
  packageSlug?: string | null;
  provisioningProposalId?: string | null;
  provisioningStatus?: string | null;
  workspaceType?: string;
  subscriptionTier?: string | null;
  subscriptionStatus?: string | null;
  stripeCustomerId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  archivedAt?: Date | null;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  joinedAt: Date;
  invitedBy: string | null;
}

export interface NewWorkspaceMember {
  id?: string;
  workspaceId: string;
  userId: string;
  role: string;
  joinedAt?: Date;
  invitedBy?: string | null;
}

/** An `invites` row — a workspace invite, or a pod invite (`workspaceId` null). */
export interface WorkspaceInvite {
  id: string;
  workspaceId: string | null;
  type: "workspace" | "pod";
  email: string;
  role: string;
  token: string;
  tokenDigest: string | null;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface NewWorkspaceInvite {
  id?: string;
  workspaceId?: string | null;
  type: "workspace" | "pod";
  email: string;
  role: string;
  token: string;
  tokenDigest?: string | null;
  invitedBy: string;
  expiresAt: Date;
  createdAt?: Date;
}
