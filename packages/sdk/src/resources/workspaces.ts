/**
 * Workspaces API - High-level workspace management
 * 
 * Provides workspace CRUD operations and member management.
 */

import type { SynapClient } from '@synap-core/client';
import type { 
  Workspace, 
  WorkspaceMember,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  InviteMemberInput,
} from '@synap-core/types/workspaces';

export class WorkspacesAPI {
  constructor(private client: SynapClient) {}
  
  /**
   * List all workspaces the user has access to
   */
  async list(): Promise<Workspace[]> {
    return this.client.trpc.workspaces.list.query();
  }
  
  /**
   * Get a specific workspace
   */
  async get(id: string): Promise<Workspace> {
    return this.client.trpc.workspaces.get.query({ id });
  }
  
  /**
   * Create a new workspace
   */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.client.trpc.workspaces.create.mutate(input);
  }
  
  /**
   * Update workspace details
   */
  async update(id: string, input: UpdateWorkspaceInput): Promise<Workspace> {
    return this.client.trpc.workspaces.update.mutate({ id, ...input });
  }
  
  /**
   * Delete a workspace
   */
  async delete(id: string): Promise<{ success: boolean }> {
    return this.client.trpc.workspaces.delete.mutate({ id });
  }
  
  /**
   * List workspace members
   */
  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.client.trpc.workspaces.listMembers.query({ workspaceId });
  }
  
  /**
   * Invite a member to workspace
   */
  async invite(input: InviteMemberInput) {
    return this.client.trpc.workspaces.createInvite.mutate(input);
  }
  
  /**
   * Remove a member from workspace
   */
  async removeMember(workspaceId: string, userId: string) {
    return this.client.trpc.workspaces.removeMember.mutate({ workspaceId, userId });
  }
  
  /**
   * Accept an invitation
   */
  async acceptInvite(token: string) {
    return this.client.trpc.workspaces.acceptInvite.mutate({ token });
  }
}
