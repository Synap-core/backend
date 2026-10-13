/**
 * DISCARD — drop an import: soft-delete every staged item no group was built
 * from (it still carries the staged marker), then close the import through the
 * ONE close door (`cancelSession` → `completeFocusSession`).
 *
 * Items a Build already used are NOT touched: they are the raw of a filed
 * proposal (its `sourceDocumentIds`) and are undone with that proposal through
 * the session's revert, never here. `revertSession` walks proposals only, so
 * without this door a never-built item would outlive its import forever.
 */

import {
  db as defaultDb,
  documents,
  and,
  eq,
  isNull,
  drizzleSql,
  IMPORT_AWAITING_CURATION,
} from "@synap/database";
import { loadImportSession, type ImportDb } from "./session.js";

export type CloseImportSession = (args: {
  sessionId: string;
  userId: string;
  agentUserId?: string;
  reason?: string;
}) => Promise<unknown>;

export async function discardImport(args: {
  database?: ImportDb;
  userId: string;
  agentUserId?: string | null;
  sessionId: string;
  /** Injected in tests; defaults to the one cancel door. */
  closeSession?: CloseImportSession;
}): Promise<{ discarded: number }> {
  const database = args.database ?? defaultDb;
  const session = await loadImportSession({
    database,
    userId: args.userId,
    sessionId: args.sessionId,
  });
  const deleted = await database
    .update(documents)
    .set({ deletedAt: new Date() })
    .where(
      and(
        // Every never-built document of this import: its staged items AND the
        // files attached to them (both carry the staged marker).
        eq(documents.userId, args.userId),
        isNull(documents.deletedAt),
        drizzleSql`${documents.metadata} #>> '{intakeSource,sessionId}' = ${session.id}`,
        drizzleSql`${documents.metadata} #>> '{intakeSource,pending}' = ${IMPORT_AWAITING_CURATION}`
      )
    )
    .returning({
      id: documents.id,
      isItem: drizzleSql<boolean>`${documents.metadata} ? 'importItem'`,
    });
  if (session.status === "active") {
    const close =
      args.closeSession ??
      (async (a) => {
        const { cancelSession } =
          await import("../focus-sessions/cancel-session.js");
        return cancelSession(a);
      });
    await close({
      sessionId: session.id,
      userId: args.userId,
      ...(args.agentUserId ? { agentUserId: args.agentUserId } : {}),
      reason: "Import discarded",
    });
  }
  // Attached files go with their item; the count is the person's items.
  return { discarded: deleted.filter((d) => d.isItem).length };
}
