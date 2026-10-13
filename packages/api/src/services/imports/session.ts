/**
 * The import SESSION — an import (Import → Curate → Build) IS a focus session.
 *
 * Opened through THE intake session door (`ensureIntakeSession`, door
 * `import`), so the row carries `metadata.intake` and `session-kind.ts`
 * classifies it a RUN — never `work`. That is what keeps an open import out of
 * every ambient "what am I working on" pick (the MCP `resolveWorkSession`
 * narrows on `ambientWorkWhere`; relay's `useSessions` defaults to kind
 * `work`), so an unrelated capture or agent write never lands in it.
 *
 * Its curation state lives on `metadata.importCuration`
 * ({@link ImportSessionCuration}); its run manifest (`metadata.run`) is
 * written by the one manifest writer, so `focusSessions.runSources` still
 * lists the staged items.
 *
 * Every read and write is OWNER-FLOORED (`user_id = userId`): a session the
 * caller does not own reads as not found.
 */

import { TRPCError } from "@trpc/server";
import {
  db as defaultDb,
  focusSessions,
  and,
  eq,
  desc,
  drizzleSql,
} from "@synap/database";
import { buildDerivedSessionTitle } from "@synap-core/types/focus-sessions";
import {
  readImportCuration,
  type ImportSessionCuration,
} from "@synap-core/types/imports";
import { resolveImportOriginLabel } from "@synap-core/types/vocabulary";
import { ensureIntakeSession } from "../intake/ensure-intake-session.js";
import { markAdoptionDirty } from "../library/adoption-memo.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";

export type ImportDb = typeof defaultDb;

/** `metadata.importCuration` — the key whose presence marks an import. */
export const IMPORT_CURATION_KEY = "importCuration";

export interface ImportSessionRow {
  id: string;
  title: string;
  status: string;
  workspaceId: string | null;
  projectId: string | null;
  curation: ImportSessionCuration;
  metadata: Record<string, unknown>;
  updatedAt: Date;
}

/** "Import from your phone" — or the person's own title. */
export function importSessionTitle(input: {
  title?: string | null;
  origin?: string | null;
}): string {
  const own = input.title?.trim();
  if (own) return own.slice(0, 200);
  const from = resolveImportOriginLabel(input.origin);
  return from ? `Import from ${from}` : "Import";
}

/**
 * Open a new import session (phase `collecting`). A mint failure is an ERROR
 * — an import with no session has nowhere to keep its items.
 */
export async function openImportSession(args: {
  database?: ImportDb;
  userId: string;
  agentUserId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  title?: string | null;
  origin?: string | null;
}): Promise<{ sessionId: string; curation: ImportSessionCuration }> {
  const database = args.database ?? defaultDb;
  // The import's space is where its items are stored and its bundles filed:
  // the caller must be able to write there (a request-supplied id is a claim).
  await assertWorkspaceWrite(database, args.userId, {
    workspaceId: args.workspaceId ?? null,
    ownerId: args.userId,
  });
  const title = importSessionTitle(args);
  const minted = await ensureIntakeSession({
    userId: args.userId,
    workspaceId: args.workspaceId ?? null,
    projectId: args.projectId ?? null,
    agentUserId: args.agentUserId ?? null,
    door: "import",
    goal: title,
    title: buildDerivedSessionTitle({ kind: "capture", label: title }),
  });
  if (minted.status === "failed") {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `The import could not be opened: ${minted.error}`,
    });
  }
  const curation: ImportSessionCuration = {
    version: 1,
    phase: "collecting",
    groups: [],
    ...(args.origin?.trim() ? { origin: args.origin.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  await database
    .update(focusSessions)
    .set({
      // The name the person reads; the mint's derived title is a fallback.
      title,
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [IMPORT_CURATION_KEY]: curation })}::jsonb`,
    })
    .where(
      and(
        eq(focusSessions.id, minted.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    );
  return { sessionId: minted.sessionId, curation };
}

function toRow(row: {
  id: string;
  title: string | null;
  goal: string;
  status: string;
  workspaceId: string | null;
  projectId: string | null;
  metadata: unknown;
  updatedAt: Date | null;
}): ImportSessionRow | null {
  const curation = readImportCuration(row.metadata);
  if (!curation) return null;
  return {
    id: row.id,
    title: row.title ?? row.goal,
    status: row.status,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    curation,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    updatedAt: row.updatedAt ?? new Date(0),
  };
}

const SESSION_COLUMNS = {
  id: focusSessions.id,
  title: focusSessions.title,
  goal: focusSessions.goal,
  status: focusSessions.status,
  workspaceId: focusSessions.workspaceId,
  projectId: focusSessions.projectId,
  metadata: focusSessions.metadata,
  updatedAt: focusSessions.updatedAt,
};

/**
 * The caller's import session, or NOT_FOUND (foreign, missing, or not an
 * import — the same answer, so existence never leaks). With `forUpdate`, the
 * row is locked for the caller's transaction.
 */
export async function loadImportSession(args: {
  database?: ImportDb;
  userId: string;
  sessionId: string;
  forUpdate?: boolean;
}): Promise<ImportSessionRow> {
  const database = args.database ?? defaultDb;
  const query = database
    .select(SESSION_COLUMNS)
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    )
    .limit(1);
  const [row] = args.forUpdate ? await query.for("update") : await query;
  const session = row ? toRow(row) : null;
  if (!session) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Import not found" });
  }
  return session;
}

/** An import that can still take items, curation or builds. */
export function assertImportOpen(session: ImportSessionRow): void {
  if (session.status !== "active") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This import is closed.",
    });
  }
}

/** Replace `metadata.importCuration` (owner-floored, shallow merge of the bag). */
export async function writeImportCuration(args: {
  database?: ImportDb;
  userId: string;
  sessionId: string;
  curation: ImportSessionCuration;
}): Promise<void> {
  const database = args.database ?? defaultDb;
  // New or renamed groups here are the Library's to adopt on its next read.
  markAdoptionDirty(args.userId);
  const curation = { ...args.curation, updatedAt: new Date().toISOString() };
  await database
    .update(focusSessions)
    .set({
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ [IMPORT_CURATION_KEY]: curation })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    );
}

/** The caller's OPEN imports (active, not done), newest first. */
export async function listOpenImportSessions(args: {
  database?: ImportDb;
  userId: string;
  limit: number;
}): Promise<ImportSessionRow[]> {
  const database = args.database ?? defaultDb;
  const rows = await database
    .select(SESSION_COLUMNS)
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, args.userId),
        eq(focusSessions.status, "active"),
        drizzleSql`${focusSessions.metadata} ? ${IMPORT_CURATION_KEY}`,
        drizzleSql`(${focusSessions.metadata} #>> '{importCuration,phase}') IS DISTINCT FROM 'done'`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: lists IMPORTS only (the `importCuration` key), never a page of mixed sessions — every row is the same run population.
    .orderBy(desc(focusSessions.updatedAt), desc(focusSessions.id))
    .limit(args.limit);
  return rows.map(toRow).filter((r): r is ImportSessionRow => r !== null);
}
