/**
 * Shared context for the import orchestrator and its extracted helper modules
 * (`structuring.ts`, `session.ts`). Threaded from the import input; carries the
 * workspace/user identity plus the optional session/project/playbook lenses.
 */
export type OrchestratorContext = {
  workspaceId: string | null;
  userId: string;
  trpcCtx: Record<string, unknown>;
  /**
   * Active focus session this import belongs to. When set, every `import.graph`
   * proposal is stamped with it (via createEventBackedProposal), so the
   * session→produced-entity links + `proposals.list({sessionId})` light up. Null
   * → a session-agnostic import (unchanged behavior).
   */
  sessionId?: string | null;
  /**
   * Active project lens (or surface override). When set, every imported entity
   * is filed into this project (`belongs_to_project`) — the project mirror of
   * `workspaceId`. Threaded from the import input.
   */
  projectId?: string | null;
  /**
   * Playbook to instantiate the import session from. When present,
   * `resolveImportSession` calls `instantiateSession({playbookId,...})` instead
   * of a bare session create. Threaded from `ImportAnalyzeInput.playbookId`.
   */
  playbookId?: string | null;
};
