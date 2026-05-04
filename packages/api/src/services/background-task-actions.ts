/**
 * Background Task Action Registry
 *
 * Standardized + extensible vocabulary for `background_tasks.action`.
 *
 * Adding a new action is one line: add an entry to BACKGROUND_TASK_ACTIONS.
 * The escape hatch is the literal id `"custom"` — any free-form NL prompt
 * is allowed under that id, with the prompt itself stored in the task's
 * `context` JSONB column.
 *
 * This registry is the single source of truth used by:
 *   - Hub Protocol REST `/background-tasks` POST validator
 *   - tRPC `backgroundTasks.create` (to be wired)
 *   - Future Eve / Coder / Hermes runners that dispatch by action id
 */
export interface BackgroundTaskActionDefinition {
  /** Stable identifier — what callers send as `action`. Namespaced by runner. */
  id: string;
  /** Short human description (rendered in CLI/UI listings). */
  description: string;
  /** When true, the task's `context` MUST include an `entityId`. */
  requiresEntity?: boolean;
  /** When true, the task MUST be associated with a workspace. */
  requiresWorkspace?: boolean;
}

/**
 * Initial action vocabulary. Keep entries terse — long-form docs belong
 * in the per-runner skill files, not here.
 */
export const BACKGROUND_TASK_ACTIONS: Record<
  string,
  BackgroundTaskActionDefinition
> = {
  "coder.research": {
    id: "coder.research",
    description: "Research a topic, write findings to a Note entity",
  },
  "coder.build": {
    id: "coder.build",
    description: "Build/scaffold code in a project workspace",
    requiresWorkspace: true,
  },
  "coder.review": {
    id: "coder.review",
    description: "Review code in a project",
    requiresWorkspace: true,
  },
  "coder.refactor": {
    id: "coder.refactor",
    description: "Refactor code in a project",
    requiresWorkspace: true,
  },
  "hermes.summarize": {
    id: "hermes.summarize",
    description: "Summarize entities or conversations",
  },
  "hermes.digest": {
    id: "hermes.digest",
    description: "Generate daily/weekly digest",
  },
  "eve.healthcheck": {
    id: "eve.healthcheck",
    description: "Run periodic eve-doctor probes",
  },
  "openclaw.skill": {
    id: "openclaw.skill",
    description: "Invoke a named OpenClaw skill",
  },
  custom: {
    id: "custom",
    description: "Free-form NL prompt (escape hatch)",
  },
};

/**
 * True iff the given id is a registered action. Use this in API validators
 * so unknown ids are rejected with a helpful 400 listing the registry.
 */
export function isValidAction(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(BACKGROUND_TASK_ACTIONS, id);
}

/**
 * Lightweight projection for listing endpoints — strip flags meant for the
 * runtime dispatcher and return just `{id, description}` pairs.
 */
export function listActions(): Array<{ id: string; description: string }> {
  return Object.values(BACKGROUND_TASK_ACTIONS).map(({ id, description }) => ({
    id,
    description,
  }));
}
