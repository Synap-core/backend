/**
 * Preferences API - User preferences management
 * 
 * Provides user preference CRUD operations.
 */

import type { SynapClient } from '@synap-core/client';
import type { 
  UserPreferences,
  UpdatePreferencesInput,
} from '@synap-core/types/preferences';

export class PreferencesAPI {
  constructor(private client: SynapClient) {}
  
  /**
   * Get current user preferences
   */
  async get(): Promise<UserPreferences> {
    return this.client.trpc.preferences.get.query();
  }
  
  /**
   * Update user preferences
   */
  async update(input: UpdatePreferencesInput): Promise<UserPreferences> {
    return this.client.trpc.preferences.update.mutate(input);
  }
  
  /**
   * Reset preferences to defaults
   */
  async reset(): Promise<UserPreferences> {
    return this.client.trpc.preferences.reset.mutate();
  }
}
