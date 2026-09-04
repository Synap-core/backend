/**
 * recordSessionArtifact — the ONE producer door for "this session made that".
 *
 * The read side (`session-outputs.ts`) joins three ledgers, but two agent write
 * doors were writing into NONE of them:
 *
 *   - `synap_create_document` created a document and stopped. `documents` has
 *     no `sessionId` column and `links` has no `document` endpoint type, so
 *     there was no coordinate anywhere tying the doc to the session that asked
 *     for it. Every agent-authored document was invisible to its own session.
 *   - `synap_store_file` threaded `sessionId` all the way into
 *     `createGovernedFileEntityFromBuffer` — where it lands on the PROPOSAL,
 *     not on any output ledger. An auto-approved store therefore produced a
 *     `file` entity nothing could attribute to the session.
 *
 * `artifacts` is the only ledger that can hold both (its `kind` enum already
 * covers document and entity, and it carries `sessionId` + provenance), so this
 * writes there. It deliberately does NOT add a `file` kind: a stored file IS a
 * `file`-profile ENTITY, and `kind: "entity"` is what it actually references.
 *
 * BEST-EFFORT BY CONTRACT: a provenance row must never fail the write that
 * produced it. Errors are logged and swallowed, exactly like the `produced`
 * edge writers (`channel-origin.ts`, `entities/create.ts`).
 */

import { db, artifacts, eq, focusSessions } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-artifact" });

export interface RecordSessionArtifactParams {
  /** The session to attribute to. No session ⇒ nothing to record. */
  sessionId: string | null | undefined;
  workspaceId: string | null | undefined;
  /** Owner — the human principal, even when an agent acted for them. */
  userId: string;
  /** What the artifact references. `file` is not a kind — a stored file is an entity. */
  kind: "view" | "cell" | "document" | "entity" | "url";
  /** The UNDERLYING object's id — what the room navigates with. */
  refId: string;
  title: string;
  /** Present ⇒ an agent produced this, and the ledger says so. */
  agentUserId?: string | null;
  /**
   * Where the output lands. Omitted ⇒ `desk` only when the session DECLARED
   * an expected output of this kind (the person asked for it), else `library`
   * — an agent that writes twenty files must not bury the desk under them.
   */
  placement?: "desk" | "home" | "sidebar" | "library";
}

async function sessionDeclaresKind(
  sessionId: string,
  kind: RecordSessionArtifactParams["kind"]
): Promise<boolean> {
  const row = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, sessionId),
    columns: { expectedOutputs: true },
  });
  const declared = (row?.expectedOutputs ?? []) as Array<{ kind?: string }>;
  return declared.some((o) => o.kind === kind);
}

/**
 * Record one session output. No-ops (silently) without a session or workspace:
 * `artifacts.workspaceId` is NOT NULL, and an unattributed row is worse than no
 * row — it would show up in another lens as an orphan.
 */
export async function recordSessionArtifact(
  params: RecordSessionArtifactParams
): Promise<void> {
  const { sessionId, workspaceId, userId, kind, refId, title, agentUserId } =
    params;
  if (!sessionId || !workspaceId || !refId) return;
  try {
    const placement =
      params.placement ??
      ((await sessionDeclaresKind(sessionId, kind)) ? "desk" : "library");
    await db.insert(artifacts).values({
      workspaceId,
      userId,
      kind,
      refId,
      title,
      originKind: agentUserId ? "agent" : "user",
      actorId: agentUserId ?? null,
      sessionId,
      state: "working",
      placement,
    });
  } catch (err) {
    logger.warn(
      { err, sessionId, kind, refId },
      "session-artifact: output ledger write failed (non-fatal)"
    );
  }
}
