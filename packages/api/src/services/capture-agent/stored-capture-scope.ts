/**
 * THE SCOPE A CAPTURE RECEIPT REPORTS IS READ OFF THE ROW THE WRITE STORED.
 *
 * Live, 2026-09-14: a capture re-sent WITH `sessionId` hit the idempotency
 * dedup and came back with the SAME proposalId — and a receipt whose `scope`
 * echoed the session it had just been handed, while the stored row still
 * carried the ambient session (and project) the first send had guessed. A fresh
 * write reported `scope.projectId: null` over a row the insert had filed into
 * a project through the declared-focus rung (3.5).
 *
 * Both were ECHOES: the receipt restated the call's inputs, or re-ran a part of
 * the placement ladder, instead of reading what the write produced. The ladder
 * runs INSIDE the insert (explicit → session → channel → declared focus →
 * relational, plus an agent-receipt session the insert may mint), so no handler
 * can re-derive it faithfully. This module is the one derivation: take the
 * columns off the proposal row.
 *
 * `storedScopeOfProposal` is used where the write already holds the row
 * (`submitCaptureGraph` gets it back from the insert). `readStoredProposalScope`
 * is the read-back for a door that only gets ids back (the text lane, whose
 * rows are inserted inside `capture.execute`).
 */

import { db, proposals, and, eq, or, inArray } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "stored-capture-scope" });

export interface StoredCaptureScope {
  workspaceId: string | null;
  projectId: string | null;
  sessionId: string | null;
}

export function storedScopeOfProposal(row: {
  workspaceId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
}): StoredCaptureScope {
  return {
    workspaceId: row.workspaceId ?? null,
    projectId: row.projectId ?? null,
    sessionId: row.sessionId ?? null,
  };
}

export type StoredScopeReadback =
  | {
      status: "read";
      /** The (first) proposal's stored scope. */
      scope: StoredCaptureScope;
      /**
       * Present ONLY when the call filed several proposals and they do NOT
       * share one scope (each insert runs the ladder, and may mint its own
       * agent-receipt session). `scope` alone would then speak for rows it
       * does not describe.
       */
      proposalScopes?: Array<StoredCaptureScope & { proposalId: string }>;
    }
  | {
      /**
       * The stored scope could NOT be read. Never folded into a null scope: a
       * failed read is not "no session, no project".
       */
      status: "unavailable";
      reason: "no-proposal-id" | "proposal-not-found" | "read-failed";
    };

export async function readStoredProposalScope(
  database: typeof db,
  params: { userId: string; proposalIds: ReadonlyArray<string> }
): Promise<StoredScopeReadback> {
  const ids = [...new Set(params.proposalIds.filter((id) => !!id))];
  if (ids.length === 0)
    return { status: "unavailable", reason: "no-proposal-id" };
  let rows: Array<{
    id: string;
    workspaceId: string | null;
    projectId: string | null;
    sessionId: string | null;
  }>;
  try {
    rows = await database
      .select({
        id: proposals.id,
        workspaceId: proposals.workspaceId,
        projectId: proposals.projectId,
        sessionId: proposals.sessionId,
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.id, ids),
          // Owner floor. The ids come from the write this call just made, never
          // from caller input — the floor only keeps this reader from becoming
          // a way to read anyone else's row if that ever changes. An agent-filed
          // row carries the agent in `createdBy` and the human in
          // `subjectUserId`; either names this user.
          or(
            eq(proposals.createdBy, params.userId),
            eq(proposals.subjectUserId, params.userId)
          )
        )
      );
  } catch (err) {
    logger.warn(
      { err, userId: params.userId, proposalIds: ids },
      "capture receipt: stored scope read-back failed"
    );
    return { status: "unavailable", reason: "read-failed" };
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (ids.some((id) => !byId.has(id))) {
    return { status: "unavailable", reason: "proposal-not-found" };
  }
  const scopes = ids.map((id) => ({
    proposalId: id,
    ...storedScopeOfProposal(byId.get(id)!),
  }));
  const [first] = scopes;
  const uniform = scopes.every(
    (s) =>
      s.workspaceId === first.workspaceId &&
      s.projectId === first.projectId &&
      s.sessionId === first.sessionId
  );
  return {
    status: "read",
    scope: storedScopeOfProposal(first),
    ...(uniform ? {} : { proposalScopes: scopes }),
  };
}
