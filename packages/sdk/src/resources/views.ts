/**
 * Views API - High-level view management
 * 
 * Provides view CRUD operations for whiteboards, timelines, etc.
 */

import type { SynapClient } from '@synap-core/client';
import type { 
  View,
  CreateViewInput,
  UpdateViewInput,
  SaveViewInput,
} from '@synap-core/types/views';

export class ViewsAPI {
  constructor(private client: SynapClient) {}
  
  /**
   * List all views
   */
  async list(options?: { workspaceId?: string; type?: string }) {
    return this.client.trpc.views.list.query(options);
  }
  
  /**
   * Get a specific view
   */
  async get(id: string): Promise<View> {
    return this.client.trpc.views.get.query({ id });
  }
  
  /**
   * Create a new view
   */
  async create(input: CreateViewInput) {
    return this.client.trpc.views.create.mutate(input);
  }
  
  /**
   * Update view metadata
   */
  async update(id: string, input: UpdateViewInput) {
    return this.client.trpc.views.update.mutate({ id, ...input });
  }
  
  /**
   * Save view content (manual save)
   */
  async save(id: string, content: unknown) {
    return this.client.trpc.views.save.mutate({ id, content });
  }
  
  /**
   * Delete a view
   */
  async delete(id: string) {
    return this.client.trpc.views.delete.mutate({ id });
  }
  
  /**
   * Get view content
   */
  async getContent(id: string) {
    return this.client.trpc.views.getContent.query({ id });
  }
}
