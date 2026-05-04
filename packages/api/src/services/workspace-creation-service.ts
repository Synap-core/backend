/**
 * Workspace Creation Service
 *
 * Shared idempotent wrapper around `createWorkspaceFromDefinition`. Used by
 * both the tRPC `workspaces.createFromDefinition` mutation and the Hub
 * Protocol REST `/workspaces/from-definition` endpoint so external callers
 * (Eve, Coder) get the same idempotency guarantees as the in-app path.
 *
 * Two idempotency keys are supported:
 *   1. `packageSlug` — historic key used by the tRPC path (see workspaces router).
 *   2. `proposalId`  — caller-supplied stable key used by Hub REST (Eve / Coder
 *      generate this from a template id like "builder-workspace-v1").
 *
 * If a workspace already exists for the user with the given key, return it
 * with `created: false`. Otherwise create a new workspace and return
 * `created: true`.
 */
import {
  createWorkspaceFromDefinition,
  db,
  drizzleSql,
  workspaceMembers,
  workspaces,
  and,
  eq,
  type WorkspaceDefinitionInput,
  type WorkspaceSettings,
} from "@synap/database";
import { getBoss } from "@synap/jobs";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "workspace-creation-service" });

export interface CreateWorkspaceFromDefinitionInput {
  /** WorkspaceProposal-shaped definition (profiles, views, bento, etc.). */
  definition: WorkspaceDefinitionInput;
  /** Owning user — workspace becomes member-owned by this user. */
  userId: string;
  /**
   * Stable caller-supplied idempotency key. If present and a workspace with
   * this `proposalId` already exists for the user → return it untouched.
   */
  proposalId?: string;
  /** Optional human-friendly workspace name override (defaults to definition.workspaceName). */
  workspaceName?: string;
  /** Optional template provenance — stored in settings, not used for idempotency. */
  templateId?: string;
  templateName?: string;
  /** Optional CP package slug. Tracked separately from proposalId for the in-app path. */
  packageSlug?: string;
  packageVersion?: string;
  workspaceType?: "personal" | "agent" | "project" | "operational";
  linkedAgentId?: string;
  /** Audit field — who/what triggered this creation. */
  createdBy?: "user" | "provisioning" | "plugin";
}

export interface CreateWorkspaceFromDefinitionResult {
  workspaceId: string;
  /** True iff a new workspace was provisioned. False on idempotent re-hit. */
  created: boolean;
}

/**
 * Run `fn` while holding a per-(userId, proposalId) advisory lock. Used by
 * both the Hub REST and tRPC `createFromDefinition` paths to serialise
 * concurrent calls with the same idempotency key. The lock auto-releases on
 * session close, so a crashed handler can't deadlock future calls.
 *
 * If `proposalId` is missing, `fn` runs without locking — no idempotency to
 * protect.
 */
export async function withWorkspaceProposalIdLock<T>(
  userId: string,
  proposalId: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!proposalId) return fn();
  await db.execute(
    drizzleSql`SELECT pg_advisory_lock(
      hashtext('synap:workspace-from-definition:' || ${userId}),
      hashtext(${proposalId})
    )`
  );
  try {
    return await fn();
  } finally {
    await db.execute(
      drizzleSql`SELECT pg_advisory_unlock(
        hashtext('synap:workspace-from-definition:' || ${userId}),
        hashtext(${proposalId})
      )`
    );
  }
}

/**
 * Idempotently create a workspace from a definition.
 *
 * Idempotency check (in order):
 *   1. If `proposalId` is provided, look for an existing workspace whose
 *      settings.proposalId matches AND the caller is a member.
 *
 * On hit → return existing { workspaceId, created: false }.
 * On miss → run `createWorkspaceFromDefinition` and stamp `proposalId` into
 * settings so subsequent calls hit.
 */
export async function createWorkspaceFromDefinitionIdempotent(
  input: CreateWorkspaceFromDefinitionInput
): Promise<CreateWorkspaceFromDefinitionResult> {
  const {
    definition,
    userId,
    proposalId,
    workspaceName,
    templateId,
    templateName,
    packageSlug,
    packageVersion,
    workspaceType,
    linkedAgentId,
    createdBy = "user",
  } = input;

  // Serialise concurrent calls with the same (userId, proposalId) so a hung
  // retry can't race the original and double-create. No-op when proposalId
  // is missing.
  return withWorkspaceProposalIdLock(userId, proposalId, async () => {
    // ── 1. Idempotency by proposalId ────────────────────────────────────────────
    if (proposalId) {
      const existingMembership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.userId, userId),
          // Match the JSONB proposalId via SQL — avoids loading every workspace
          // row for the user. The composite (workspace_id, proposalId) check
          // happens server-side; we then verify membership via the join.
          drizzleSql`EXISTS (
          SELECT 1 FROM workspaces w
          WHERE w.id = ${workspaceMembers.workspaceId}
            AND w.settings->>'proposalId' = ${proposalId}
        )`
        ),
        with: { workspace: true },
      });
      if (existingMembership?.workspace) {
        logger.info(
          {
            userId,
            proposalId,
            workspaceId: existingMembership.workspace.id,
          },
          "createFromDefinition (Hub): returning existing workspace by proposalId"
        );
        return {
          workspaceId: existingMembership.workspace.id,
          created: false,
        };
      }
    }

    // ── 2. Create new workspace ────────────────────────────────────────────────
    const result = await createWorkspaceFromDefinition({
      definition,
      userId,
      packageSlug,
      packageVersion,
      templateId,
      templateName,
      workspaceName,
      workspaceType,
      linkedAgentId,
      createdBy,
    });

    // ── 3. Persist proposalId into settings so future calls are idempotent ─────
    // Done as a follow-up merge instead of being passed through
    // CreateFromDefinitionOptions to avoid widening that public type for a
    // Hub-REST-only concern. The merge is best-effort: a transient failure
    // here just means the next call will create a duplicate (acceptable for
    // a setup endpoint).
    if (proposalId) {
      try {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, result.workspaceId),
          columns: { settings: true },
        });
        const existingSettings = (ws?.settings ?? {}) as WorkspaceSettings;
        await db
          .update(workspaces)
          .set({
            settings: {
              ...existingSettings,
              proposalId,
            } satisfies WorkspaceSettings,
          })
          .where(eq(workspaces.id, result.workspaceId));
      } catch (err) {
        logger.warn(
          { err, workspaceId: result.workspaceId, proposalId },
          "Failed to stamp proposalId into workspace settings (non-fatal)"
        );
      }
    }

    // ── 4. Enqueue workspace-init for default whiteboard/commands ──────────────
    // Mirrors the tRPC path so the Hub-created workspace has the same defaults.
    try {
      const boss = getBoss();
      await boss.send("workspace-init", {
        workspaceId: result.workspaceId,
        userId,
        packageSlug,
      });
    } catch (err) {
      logger.warn(
        { err, workspaceId: result.workspaceId },
        "Failed to enqueue workspace-init from Hub path (non-fatal)"
      );
    }

    return {
      workspaceId: result.workspaceId,
      created: true,
    };
  });
}

/**
 * Allow-list of agentTypes that may call the Hub Protocol REST workspace
 * creation endpoint. Other agentTypes get 403. Easy to extend by adding
 * a new entry below.
 */
export const WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST: ReadonlyArray<string> = [
  "eve",
  "coder",
];

export function isAgentTypeAllowedToCreateWorkspaces(
  agentType: string | null | undefined
): boolean {
  if (!agentType) return false;
  return WORKSPACE_CREATE_AGENT_TYPE_ALLOWLIST.includes(agentType);
}
