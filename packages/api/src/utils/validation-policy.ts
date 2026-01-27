/**
 * Validation Policy Service
 *
 * Determines if an operation requires validation based on:
 * 1. Global defaults (per table/operation)
 * 2. Workspace preferences (override)
 *
 * This is a ROUTING decision, not validation itself.
 * The actual validation happens in GlobalValidator.
 */

export interface ValidationPolicyParams {
  operation: "create" | "update" | "delete";
  subjectType: string; // 'entity', 'chat_thread', etc.
  workspaceId?: string;
  projectId?: string;
  userRole?: string;
}

export interface ValidationPolicyResult {
  requiresValidation: boolean;
  reason: string; // For debugging/audit
  source: "global-default" | "workspace-preference" | "system-override";
}

/**
 * Global defaults for validation requirements
 *
 * Philosophy:
 * - Deletions ALWAYS require validation by default (safety first)
 * - Creates/updates can be fast-tracked for certain tables
 * - Workspace preferences can override any default (except system overrides)
 */
const GLOBAL_VALIDATION_DEFAULTS: Record<
  string,
  {
    create: boolean;
    update: boolean;
    delete: boolean;
  }
> = {
  // Fast-path tables (no validation for create/update)
  conversation_message: {
    create: false, // Direct write (real-time chat)
    update: false, // Direct write
    delete: true, // Always validate deletions
  },

  chat_thread: {
    create: false, // Any role (except viewer) can create
    update: false, // Any role (except viewer) can update
    delete: true, // Requires validation
  },

  // Context linking (read-only tracking, fast-path)
  thread_entity: {
    create: false, // Context tracking only, no validation needed
    update: false,
    delete: false,
  },

  thread_document: {
    create: false, // Context tracking only, no validation needed
    update: false,
    delete: false,
  },

  user_entity_state: {
    create: false, // Direct write (starred/pinned)
    update: false, // Direct write
    delete: false, // Direct write (unstar/unpin)
  },

  // Standard tables (full validation)
  entity: {
    create: true,
    update: true,
    delete: true,
  },

  document: {
    create: true,
    update: true,
    delete: true,
  },

  workspace: {
    create: true,
    update: true,
    delete: true,
  },

  project: {
    create: true,
    update: true,
    delete: true,
  },

  view: {
    create: true,
    update: true,
    delete: true,
  },

  tag: {
    create: true,
    update: true,
    delete: true,
  },

  relation: {
    create: true,
    update: true,
    delete: true,
  },

  role: {
    create: true,
    update: true,
    delete: true,
  },

  api_key: {
    create: true,
    update: true,
    delete: true,
  },

  // Default for unlisted tables
  _default: {
    create: true,
    update: true,
    delete: true,
  },
};

export class ValidationPolicyService {
  /**
   * Check if an operation requires validation
   */
  async requiresValidation(
    params: ValidationPolicyParams
  ): Promise<ValidationPolicyResult> {
    // SYSTEM OVERRIDE: Deletions always require validation (safety first)
    // This cannot be overridden by workspace preferences
    if (params.operation === "delete") {
      const tableDefaults =
        GLOBAL_VALIDATION_DEFAULTS[params.subjectType] ||
        GLOBAL_VALIDATION_DEFAULTS._default;

      // Only allow fast-path delete if explicitly set to false in global defaults
      if (tableDefaults.delete === false) {
        return {
          requiresValidation: false,
          reason: `Global default allows fast-path for ${params.subjectType}.delete`,
          source: "global-default",
        };
      }

      return {
        requiresValidation: true,
        reason: `System policy: deletions require validation`,
        source: "system-override",
      };
    }

    // 1. Check workspace preferences first (if workspace-scoped)
    if (params.workspaceId) {
      const workspaceOverride = await this.getWorkspacePreference(
        params.workspaceId,
        params.subjectType,
        params.operation
      );

      if (workspaceOverride !== null) {
        return {
          requiresValidation: workspaceOverride,
          reason: `Workspace preference for ${params.subjectType}.${params.operation}`,
          source: "workspace-preference",
        };
      }
    }

    // 2. Fall back to global defaults
    const tableDefaults =
      GLOBAL_VALIDATION_DEFAULTS[params.subjectType] ||
      GLOBAL_VALIDATION_DEFAULTS._default;

    const requiresValidation = tableDefaults[params.operation];

    return {
      requiresValidation,
      reason: `Global default for ${params.subjectType}.${params.operation}`,
      source: "global-default",
    };
  }

  /**
   * Get workspace validation preference
   * Returns null if no preference set (use global default)
   */
  private async getWorkspacePreference(
    workspaceId: string,
    subjectType: string,
    operation: string
  ): Promise<boolean | null> {
    try {
      // Dynamic import to avoid circular dependencies
      const db = await import("@synap/database").then((m) => m.db);
      const { workspaces, eq } = await import("@synap/database");

      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      if (!workspace) return null;

      const settings = workspace.settings as any;
      const validationRules = settings?.validationRules;

      if (!validationRules) return null;

      const tableRules = validationRules[subjectType];
      if (!tableRules) return null;

      return tableRules[operation] ?? null;
    } catch (error) {
      // If there's an error fetching preferences, fall back to global defaults
      console.error("Error fetching workspace preferences:", error);
      return null;
    }
  }
}
