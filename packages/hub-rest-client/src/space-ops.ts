/**
 * Space-operation wire types — the Hub routes in rest/workspace-ops.ts (R8a).
 *
 * A SPACE is the user's word for a workspace; ids and params keep
 * `workspace`. Every route forwards to the governed tRPC procedure, so an
 * agent key answers `{ status: "proposed" }` (202) — a SUCCESS, queued for
 * review — and a human owner gets the applied result.
 */

/** A governed space write that became a proposal — SUCCESS, queued for review. */
export interface HubSpaceOpProposed {
  status: "proposed";
  proposalId: string;
  proposalType?: string;
  message?: string;
  reviewUrl?: string;
}

/** An automation archive paused (or that stays paused after a restore). */
export interface HubPausedAutomationRef {
  id: string;
  name?: string | null;
  [key: string]: unknown;
}

/** POST /workspaces/:id/archive | /restore */
export type HubArchiveWorkspaceResult =
  | HubSpaceOpProposed
  | {
      status: "archived" | "restored";
      id?: string;
      name?: string;
      /** Already in the requested state — nothing was written. */
      unchanged?: true;
      pausedAutomations?: HubPausedAutomationRef[];
      pausedByArchive?: HubPausedAutomationRef[];
      [key: string]: unknown;
    };

/** PATCH /workspaces/:id */
export type HubRenameWorkspaceResult =
  HubSpaceOpProposed | { status: "updated"; message?: string };

export interface MoveEntitiesInput {
  /** 1–500 entity UUIDs. */
  entityIds: string[];
  /** Destination workspace UUID. */
  workspaceId: string;
  /** Why they belong there — shown to the reviewer. */
  reason?: string;
}

/** POST /entities/move — best-effort per entity; a proposed move is success. */
export interface HubMoveEntitiesResult {
  moved: string[];
  proposed: Array<{ entityId: string; proposalId: string }>;
  errors: Array<{ entityId: string; error: string }>;
}

export interface GrantProfileAccessInput {
  profileId: string;
  /** The workspace that gains access to the kind. */
  targetWorkspaceId: string;
  /** Acting workspace; omitted ⇒ the kind's home workspace. */
  workspaceId?: string;
  reasoning?: string;
}

/** POST /profiles/grant-access */
export type HubGrantProfileAccessResult =
  | (HubSpaceOpProposed & { success?: false })
  | { success: true; status: "granted" };
