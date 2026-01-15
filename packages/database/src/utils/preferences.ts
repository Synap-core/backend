/**
 * Preferences Utilities
 * 
 * Type-safe utilities for fetching user and workspace preferences
 * with proper defaults and validation.
 * 
 * Schema Structure:
 * - User: userPreferences.uiPreferences (JSONB)
 * - Workspace: workspaces.settings (JSONB)
 */

import { db } from '../index.js';
import { eq } from 'drizzle-orm';
import { userPreferences, workspaces } from '../schema/index.js';

/**
 * User Preference Keys
 * These are stored in userPreferences.uiPreferences JSONB field
 */
export type UserPreferenceKey =
  | 'entity.deleteDocument'     // Whether to cascade delete documents when deleting entities
  | 'editor.autosave'           // Boolean
  | 'editor.autosaveInterval'   // Number (seconds)
  | 'notifications.email'       // Boolean
  | 'notifications.push'        // Boolean
  | 'theme.mode'                // 'light' | 'dark' | 'system' (separate field, not in uiPreferences)
  | 'ui.sidebarCollapsed'       // Boolean
  | 'ui.compactMode'            // Boolean
  | 'ui.defaultView';           // 'list' | 'grid' | 'timeline'

/**
 * Workspace Preference Keys
 * These are stored in workspaces.settings JSONB field
 */
export type WorkspacePreferenceKey =
  | 'defaultEntityBehavior.deleteDocument'  // Workspace-wide default for entity deletion
  | 'features.aiEnabled'                    // Boolean
  | 'features.collaborativeEditing'         // Boolean
  | 'retention.documentDays'                // Number
  | 'security.requireStrongPasswords'       // Boolean
  | 'defaultEntityTypes';                   // string[] (separate field in WorkspaceSettings)

/**
 * Default values for user preferences
 */
const USER_PREFERENCE_DEFAULTS: Record<string, any> = {
  'entity.deleteDocument': true,           // Default: cascade delete
  'editor.autosave': true,
  'editor.autosaveInterval': 30,
  'notifications.email': true,
  'notifications.push': false,
  'theme.mode': 'system',
  'ui.sidebarCollapsed': false,
  'ui.compactMode': false,
  'ui.defaultView': 'list',
};

/**
 * Default values for workspace preferences
 */
const WORKSPACE_PREFERENCE_DEFAULTS: Record<string, any> = {
  'defaultEntityBehavior.deleteDocument': true,
  'features.aiEnabled': true,
  'features.collaborativeEditing': true,
  'retention.documentDays': 90,
  'security.requireStrongPasswords': false,
  'defaultEntityTypes': ['note', 'task'],
};

/**
 * Get a single user preference with type safety
 * 
 * @param userId - User ID
 * @param key - Preference key
 * @returns Preference value or default
 * 
 * @example
 * const deleteDocOnEntityDelete = await getUserPreference(
 *   'user-123',
 *   'entity.deleteDocument'
 * ); // Returns: true (default)
 */
export async function getUserPreference(
  userId: string,
  key: UserPreferenceKey
): Promise<any> {
  // Special case: theme.mode is a separate column
  if (key === 'theme.mode') {
    const prefs = await db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId)
    });
    return prefs?.theme || USER_PREFERENCE_DEFAULTS[key];
  }

  const prefs = await db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, userId)
  });

  if (!prefs?.uiPreferences) {
    return USER_PREFERENCE_DEFAULTS[key];
  }

  const uiPrefs = prefs.uiPreferences as Record<string, any>;
  const value = getNestedValue(uiPrefs, key);
  
  return value !== undefined ? value : USER_PREFERENCE_DEFAULTS[key];
}

/**
 * Get multiple user preferences at once
 * 
 * @param userId - User ID
 * @param keys - Array of preference keys
 * @returns Object with preference values
 */
export async function getUserPreferences<K extends UserPreferenceKey>(
  userId: string,
  keys: K[]
): Promise<Record<K, any>> {
  const prefs = await db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, userId)
  });

  const result = {} as Record<K, any>;
  
  for (const key of keys) {
    // Special case: theme.mode
    if (key === 'theme.mode') {
      result[key] = prefs?.theme || USER_PREFERENCE_DEFAULTS[key];
      continue;
    }

    if (!prefs?.uiPreferences) {
      result[key] = USER_PREFERENCE_DEFAULTS[key];
    } else {
      const uiPrefs = prefs.uiPreferences as Record<string, any>;
      const value = getNestedValue(uiPrefs, key);
      result[key] = value !== undefined ? value : USER_PREFERENCE_DEFAULTS[key];
    }
  }
  
  return result;
}

/**
 * Set a user preference
 * 
 * @param userId - User ID
 * @param key - Preference key
 * @param value - Preference value
 */
export async function setUserPreference<K extends UserPreferenceKey>(
  userId: string,
  key: K,
  value: any
): Promise<void> {
  // Special case: theme.mode
  if (key === 'theme.mode') {
    const existing = await db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId)
    });

    if (existing) {
      await db
        .update(userPreferences)
        .set({ theme: value })
        .where(eq(userPreferences.userId, userId));
    } else {
      await db
        .insert(userPreferences)
        .values({ userId, theme: value });
    }
    return;
  }

  const existing = await db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, userId)
  });

  const currentPrefs = (existing?.uiPreferences as Record<string, any>) || {};
  const updatedPrefs = setNestedValue(currentPrefs, key, value);

  if (existing) {
    await db
      .update(userPreferences)
      .set({ uiPreferences: updatedPrefs })
      .where(eq(userPreferences.userId, userId));
  } else {
    await db
      .insert(userPreferences)
      .values({
        userId,
        uiPreferences: updatedPrefs,
      });
  }
}

/**
 * Get a workspace preference with type safety
 * 
 * @param workspaceId - Workspace ID
 * @param key - Preference key
 * @returns Preference value or default
 */
export async function getWorkspacePreference<K extends WorkspacePreferenceKey>(
  workspaceId: string,
  key: K
): Promise<any> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId)
  });

  if (!workspace?.settings) {
    return WORKSPACE_PREFERENCE_DEFAULTS[key];
  }

  const settings = workspace.settings as Record<string, any>;
  const value = getNestedValue(settings, key);
  
  return value !== undefined ? value : WORKSPACE_PREFERENCE_DEFAULTS[key];
}

/**
 * Get multiple workspace preferences at once
 * 
 * @param workspaceId - Workspace ID
 * @param keys - Array of preference keys
 * @returns Object with preference values
 */
export async function getWorkspacePreferences<K extends WorkspacePreferenceKey>(
  workspaceId: string,
  keys: K[]
): Promise<Record<K, any>> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId)
  });

  const result = {} as Record<K, any>;
  
  for (const key of keys) {
    if (!workspace?.settings) {
      result[key] = WORKSPACE_PREFERENCE_DEFAULTS[key];
    } else {
      const settings = workspace.settings as Record<string, any>;
      const value = getNestedValue(settings, key);
      result[key] = value !== undefined ? value : WORKSPACE_PREFERENCE_DEFAULTS[key];
    }
  }
  
  return result;
}

/**
 * Set a workspace preference
 * 
 * @param workspaceId - Workspace ID
 * @param key - Preference key
 * @param value - Preference value
 */
export async function setWorkspacePreference<K extends WorkspacePreferenceKey>(
  workspaceId: string,
  key: K,
  value: any
): Promise<void> {
  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId)
  });

  if (!existing) {
    throw new Error('Workspace not found');
  }

  const currentSettings = (existing.settings as Record<string, any>) || {};
  const updatedSettings = setNestedValue(currentSettings, key, value);

  await db
    .update(workspaces)
    .set({ settings: updatedSettings })
    .where(eq(workspaces.id, workspaceId));
}

// Helper functions for nested key access

function getNestedValue(obj: Record<string, any>, key: string): any {
  const keys = key.split('.');
  let value = obj;
  
  for (const k of keys) {
    if (value === undefined || value === null) return undefined;
    value = value[k];
  }
  
  return value;
}

function setNestedValue(obj: Record<string, any>, key: string, value: any): Record<string, any> {
  const keys = key.split('.');
  const result = { ...obj };
  let current: any = result;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!current[k] || typeof current[k] !== 'object') {
      current[k] = {};
    } else {
      current[k] = { ...current[k] };
    }
    current = current[k];
  }
  
  current[keys[keys.length - 1]] = value;
  return result;
}
