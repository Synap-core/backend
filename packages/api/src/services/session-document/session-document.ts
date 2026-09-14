/**
 * THE session document — the one stored narrative document a focus session
 * owns.
 *
 * No new table and no new column: a session already records its outputs in the
 * `artifacts` ledger through `recordSessionArtifact`, and that ledger already
 * carries a declared-slot label (`props.expectedLabel`). The session document is
 * the `kind: "document"` artifact of the session carrying the RESERVED label
 * {@link SESSION_DOCUMENT_LABEL}. Designating it is recording that artifact;
 * finding it is reading the earliest one.
 *
 * Race: `artifacts_session_ref_unique` keys on the REF, so two concurrent
 * creators would each record a DIFFERENT document under the same label. The
 * earliest artifact is the designated one by definition (`asc(createdAt, id)`),
 * and a creator that finds it lost removes its own artifact and document — so
 * callers always converge on one document.
 */

import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  db,
  artifacts,
  documents,
  focusSessions,
  and,
  asc,
  eq,
  drizzleSql,
  DocumentRepository,
  eventRepository,
} from "@synap/database";
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";
import { recordSessionArtifact } from "../focus-sessions/record-session-artifact.js";

const logger = createLogger({ module: "session-document" });

/** The reserved `artifacts.props.expectedLabel` that marks THE session document. */
export const SESSION_DOCUMENT_LABEL = "session-document";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnedSession {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  goal: string;
  status: string;
  currentStage: string | null;
}

/** Load a session the caller owns. Anything else — including a malformed id — is NOT_FOUND. */
export async function loadOwnedSession(
  sessionId: string,
  userId: string
): Promise<OwnedSession> {
  const row = UUID_RE.test(sessionId)
    ? (
        await db
          .select({
            id: focusSessions.id,
            userId: focusSessions.userId,
            workspaceId: focusSessions.workspaceId,
            title: focusSessions.title,
            goal: focusSessions.goal,
            status: focusSessions.status,
            currentStage: focusSessions.currentStage,
          })
          .from(focusSessions)
          .where(
            and(
              eq(focusSessions.id, sessionId),
              eq(focusSessions.userId, userId)
            )
          )
          .limit(1)
      )[0]
    : undefined;
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });
  }
  return row;
}

/**
 * The session state a section is written against — `status`, plus the stage
 * when the session has one. A reader compares it to the session's current value
 * to say a section is stale.
 */
export function sessionStateStamp(
  session: Pick<OwnedSession, "status" | "currentStage">
): string {
  return session.currentStage
    ? `${session.status}:${session.currentStage}`
    : session.status;
}

/** The designated document id, or `null` when the session has none yet. */
export async function findSessionDocumentId(
  sessionId: string
): Promise<string | null> {
  const [row] = await db
    .select({ refId: artifacts.refId })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.sessionId, sessionId),
        eq(artifacts.kind, "document"),
        drizzleSql`${artifacts.props}->>'expectedLabel' = ${SESSION_DOCUMENT_LABEL}`
      )
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .limit(1);
  return row?.refId ?? null;
}

function sessionDocumentTitle(session: OwnedSession): string {
  const name =
    session.title?.trim() || session.goal.split("\n")[0]!.trim() || "Session";
  return name.slice(0, 200);
}

/**
 * Get the session's document, creating and designating an empty markdown
 * document when it has none. `created` is true only for the caller whose
 * document became the designated one.
 */
export async function getOrCreateSessionDocument(
  session: OwnedSession,
  opts: { agentUserId?: string | null } = {}
): Promise<{ documentId: string; created: boolean }> {
  const existing = await findSessionDocumentId(session.id);
  if (existing) return { documentId: existing, created: false };

  const documentId = randomUUID();
  const title = sessionDocumentTitle(session);
  const storageKey = storage.buildPath(
    session.userId,
    "document",
    documentId,
    "md"
  );
  const uploaded = await storage.upload(storageKey, "", {
    contentType: "text/markdown",
  });
  const repo = new DocumentRepository(db, eventRepository);
  await repo.create(
    {
      id: documentId,
      title,
      type: "markdown",
      storageUrl: uploaded.url,
      storageKey: uploaded.path,
      size: uploaded.size,
      mimeType: "text/markdown",
      workspaceId: session.workspaceId,
      content: "",
      userId: session.userId,
      createdByKind: opts.agentUserId ? "ai_agent" : "human",
      createdByUserId: session.userId,
      ...(opts.agentUserId ? { agentUserId: opts.agentUserId } : {}),
    },
    session.userId
  );

  await recordSessionArtifact({
    sessionId: session.id,
    workspaceId: session.workspaceId,
    userId: session.userId,
    kind: "document",
    refId: documentId,
    title,
    agentUserId: opts.agentUserId ?? null,
    expectedLabel: SESSION_DOCUMENT_LABEL,
  });

  const designated = await findSessionDocumentId(session.id);
  if (designated === documentId) return { documentId, created: true };

  // Lost the race (or the ledger write was swallowed): retire what this call
  // made so the session never shows two documents under the reserved label.
  await db
    .delete(artifacts)
    .where(
      and(eq(artifacts.sessionId, session.id), eq(artifacts.refId, documentId))
    );
  await db.delete(documents).where(eq(documents.id, documentId));
  if (!designated) {
    logger.error(
      { sessionId: session.id, documentId },
      "session-document: designation was not recorded"
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not designate the session document. Try again.",
    });
  }
  return { documentId: designated, created: false };
}
