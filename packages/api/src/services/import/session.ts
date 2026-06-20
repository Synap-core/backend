import { db, linkEntityToProject } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { CsvTablePlan } from "../../import/import-adapters.js";
import type { OrchestratorContext } from "./types.js";
import type { ImportAnalyzeInput } from "../import-orchestrator.js";

const logger = createLogger({ module: "import-orchestrator/session" });

/**
 * Resolve the session this import attaches to:
 * 1. Caller-supplied sessionId (e.g. from a prior analyze call).
 * 2. When `input.playbookId` is present, instantiate a NEW session FROM the
 *    playbook — goal resolved from goalTemplate, expectedOutputs from the
 *    playbook, `playbookId` FK + `instantiated_from` link written. This makes
 *    the import a first-class playbook-templated session.
 * 3. When `input.sessionId` is set and no playbook, use it directly.
 * 4. Otherwise null — session-agnostic import (e.g. pod-wide).
 *
 * The playbook is the single source of truth for a session's goal/outputs;
 * when present, the caller MUST NOT also pass a bare sessionId.
 */
export async function resolveImportSession(
  ctx: OrchestratorContext,
  input: ImportAnalyzeInput,
  _tablePlan: CsvTablePlan | null
): Promise<string | null> {
  // Existing session — pass through unchanged.
  if (input.sessionId) return input.sessionId;

  // Playbook-templated session: instantiate FROM the playbook, which sets
  // goal (resolved), expectedOutputs, playbookId FK, and the
  // instantiated_from link.
  if (input.playbookId && ctx.workspaceId) {
    const { instantiateSession } =
      await import("../playbooks/playbook-lifecycle.js");
    try {
      const session = await instantiateSession({
        playbookId: input.playbookId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        params: input.playbookParams,
      });
      return session.id;
    } catch (err) {
      // Session instantiation is best-effort — an import must not fail
      // because a playbook instantiation hiccupped. Log and return null
      // (the import still completes; it just won't be session-attached).
      logger.warn(
        { err, playbookId: input.playbookId },
        "import: playbook session instantiation failed (import preserved)"
      );
      return null;
    }
  }

  return null;
}

/**
 * Resolve a playbook's target profileSlug from its `expectedOutputs[0].kind`,
 * so the playbook is the single source of truth for entity typing (overriding
 * the IS-inferred slug). Returns null when the playbook has no declared output
 * kind or is not found.
 */
export async function resolvePlaybookOutputKind(
  playbookId: string
): Promise<{ profileSlug: string } | null> {
  await import("@synap/database/schema");
  const { db: db2 } = await import("@synap/database");
  const row = await db2.query.playbooks.findFirst({
    where: (fields, { eq }) => eq(fields.id, playbookId),
    columns: { expectedOutputs: true },
  });
  if (!row) return null;
  const outputs = row.expectedOutputs as Array<{ kind?: string }> | null;
  const kind = outputs?.[0]?.kind;
  return kind ? { profileSlug: kind } : null;
}

/**
 * File freshly-materialized entities into the active project (`belongs_to_project`)
 * when a project lens is set. The single membership write for both import paths
 * (apply + applyLarge); the `linkEntityToProject` helper is idempotent.
 */
export async function stampProjectMembership(
  ctx: OrchestratorContext,
  entities: { entityId: string; linked?: boolean }[]
): Promise<void> {
  const projectId = ctx.projectId;
  if (!projectId) return;
  for (const e of entities) {
    if (e.linked) continue;
    await linkEntityToProject(db, {
      entityId: e.entityId,
      projectId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
  }
}
