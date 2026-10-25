// Declared HERE, once: `@synap/database` (`schema/profiles.ts`) imports it to
// type `profiles.ai_posture` and re-exports it. Pure type.

/**
 * Per-kind behavioral emphases for AI teaching briefs (base layer). Workspace
 * overlay lives at `workspaces.settings.profileAiPosture[slug]` (jsonb,
 * already exists) — resolved together by `getEffectiveAiPosture()`.
 */
export interface AiPosture {
  explainWhy?: boolean;
  openAfterCreate?: boolean;
  attachOutputs?: boolean;
  directives?: string[];
}
