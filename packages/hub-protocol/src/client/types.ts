/**
 * Hub Protocol Client Types
 *
 * Type definitions for the Hub Protocol Client
 */

export type HubScope =
  | "preferences"
  | "calendar"
  | "notes"
  | "tasks"
  | "projects"
  | "conversations"
  | "entities"
  | "relations"
  | "knowledge_facts";

export interface HubProtocolClientConfig {
  /** Data Pod API URL (e.g., 'http://localhost:3000') */
  dataPodUrl: string;

  /** Authentication token getter (for user authentication) */
  getToken?: () => Promise<string | null> | string | null;

  /** Static authentication token (alternative to getToken) */
  token?: string;

  /** Additional headers */
  headers?: Record<string, string>;

  /** Retry configuration */
  retry?: {
    maxAttempts?: number;
    delayMs?: number;
  };
}

export interface RequestDataFilters {
  dateRange?: {
    start: string; // ISO datetime
    end: string; // ISO datetime
  };
  entityTypes?: string[];
  limit?: number;
  offset?: number;
}
