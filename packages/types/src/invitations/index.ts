/**
 * Invitation contracts shared across clients.
 */

export type InviteScope = "workspace" | "pod";

export type InviteStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "revoked";

export interface InviteSummary {
  id: string;
  type: InviteScope;
  email: string;
  role: "owner" | "admin" | "editor" | "viewer";
  workspaceId: string | null;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

export interface InvitePreview {
  type: InviteScope;
  workspaceName?: string;
  inviterName: string;
  role: string;
  expiresAt: string;
  expired?: boolean;
}

export interface AcceptInviteResult {
  status: "accepted";
  type: InviteScope;
  workspaceId?: string;
  workspacesJoined?: number;
}
