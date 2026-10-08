/**
 * THE run-capture write — what `POST /api/hub/runs/:runId/capture` applies once
 * governance said yes, extracted so the external-agent status poll records a
 * provider-reported outcome through the SAME write (status + summary + error,
 * terminal stamp, parent settle, `produced` / `used` provenance edges) instead
 * of a second copy of it.
 *
 * Caller-gated: this performs no authorization. The Hub route gates on
 * `checkPermissionOrPropose` first; the poll is the pod's own bookkeeping of a
 * run it dispatched (see `poll-external-agents.ts`).
 */

import {
  db,
  and,
  eq,
  inArray,
  playbookRuns,
  liveRunStatusWhere,
} from "@synap/database";
import { entities } from "@synap/database/schema";
import type { PlaybookRun } from "@synap/database/schema";
import { settleParentAutomationRunFromChild } from "@synap/jobs";
import { createLinks } from "../links/links-service.js";

export type CaptureRunStatus = "running" | "completed" | "failed" | "proposed";

export async function applyRunCapture(p: {
  run: Pick<
    PlaybookRun,
    | "id"
    | "status"
    | "summary"
    | "error"
    | "completedAt"
    | "sessionId"
    | "workspaceId"
  >;
  status?: CaptureRunStatus;
  summary?: string;
  error?: string;
  producedEntityIds?: string[];
  usedCapabilities?: Array<{ kind: "tool" | "skill" | "command"; id: string }>;
}): Promise<PlaybookRun | null> {
  const { run } = p;
  // Terminal statuses stamp completed_at.
  const nextStatus = p.status ?? run.status;
  const terminal =
    nextStatus === "completed" ||
    nextStatus === "failed" ||
    nextStatus === "proposed";
  // EVERY capture lands only on a run that is still LIVE — terminal or not: a
  // run that was cancelled (or already finished) in between keeps its verdict,
  // and a late `running` capture never revives it. The caller's copy of the
  // row is stale, never authoritative. `null` ⇒ nothing was written (and
  // nothing settled or linked).
  const [updated] = await db
    .update(playbookRuns)
    .set({
      status: nextStatus,
      summary: p.summary ?? run.summary,
      error: p.error ?? run.error,
      completedAt: terminal ? new Date() : run.completedAt,
    })
    .where(
      and(eq(playbookRuns.id, run.id), liveRunStatusWhere(playbookRuns.status))
    )
    .returning();
  if (!updated) return null;
  // A failed child of an automation run settles its parent (never throws).
  if (terminal)
    await settleParentAutomationRunFromChild({ playbookRunId: run.id });

  // Record produced entities as `session → produced → entity` links (the
  // provenance edge for what this run generated). VALIDATE each id resolves
  // to an entity in the run's OWN workspace before linking — a capture-back
  // caller must not fabricate provenance to arbitrary / cross-tenant ids.
  // Capped to bound the write.
  if (run.sessionId && run.workspaceId && p.producedEntityIds?.length) {
    const requested = p.producedEntityIds.slice(0, 100);
    const found = await db.query.entities.findMany({
      where: inArray(entities.id, requested),
      columns: { id: true, workspaceId: true },
    });
    const validIds = found
      .filter((e) => e.workspaceId === run.workspaceId)
      .map((e) => e.id);
    if (validIds.length) {
      await createLinks(
        validIds.map((entityId) => ({
          workspaceId: run.workspaceId,
          fromType: "session" as const,
          fromId: run.sessionId as string,
          toType: "entity" as const,
          toId: entityId,
          linkType: "produced" as const,
        }))
      );
    }
  }

  // Record invoked capabilities as `session → used → {tool|skill|command}` —
  // the provenance the session room's "Tools & skills" Frame reads, and what
  // promoteSessionToPlaybook re-grants. Capped; idempotent (links unique edge).
  if (run.sessionId && run.workspaceId && p.usedCapabilities?.length) {
    await createLinks(
      p.usedCapabilities.slice(0, 100).map((cap) => ({
        workspaceId: run.workspaceId,
        fromType: "session" as const,
        fromId: run.sessionId as string,
        toType: cap.kind,
        toId: cap.id,
        linkType: "used" as const,
      }))
    );
  }

  return updated as PlaybookRun;
}
