/**
 * The import READ MODEL — what every client reads of one import (`ImportView`):
 * its phase and groups (session metadata) and its staged items (one
 * intake-source document each, `metadata.importItem` + `importCuration`).
 *
 * Metadata only — never a body. Counts are over EVERY item; `items` is a page.
 * A failed read throws: an import with no items reads `items: []`, never a
 * swallowed error.
 */

import { TRPCError } from "@trpc/server";
import { documents, and, asc, eq, isNull, drizzleSql } from "@synap/database";
import {
  importCounts,
  type ImportContentStatus,
  type ImportItemCuration,
  type ImportItemMetadata,
  type ImportItemView,
  type ImportView,
  IMPORT_CONTENT_STATUSES,
  IMPORT_ITEM_DECISIONS,
} from "@synap-core/types/imports";
import type { ImportDb, ImportSessionRow } from "./session.js";

export const IMPORT_ITEM_KEY = "importItem";
export const IMPORT_ITEM_CURATION_KEY = "importCuration";

export const IMPORT_VIEW_PAGE_DEFAULT = 200;
export const IMPORT_VIEW_PAGE_MAX = 500;

export interface ImportItemRow {
  id: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  storageKey: string | null;
  mimeType: string | null;
}

/** The documents of one import session (own, live, staged by the import door). */
export function importItemsWhere(userId: string, sessionId: string) {
  return and(
    eq(documents.userId, userId),
    isNull(documents.deletedAt),
    drizzleSql`${documents.metadata} #>> '{intakeSource,sessionId}' = ${sessionId}`,
    drizzleSql`${documents.metadata} ? ${IMPORT_ITEM_KEY}`
  )!;
}

/** Default curation of an untouched item: keep, follows no group yet. */
export function readItemCuration(metadata: unknown): ImportItemCuration {
  const raw = (metadata as Record<string, unknown> | null)?.[
    IMPORT_ITEM_CURATION_KEY
  ] as Partial<ImportItemCuration> | undefined;
  const decision = (IMPORT_ITEM_DECISIONS as readonly string[]).includes(
    raw?.decision as string
  )
    ? (raw!.decision as ImportItemCuration["decision"])
    : "keep";
  return {
    decision,
    ...(typeof raw?.note === "string" && raw.note.trim()
      ? { note: raw.note }
      : {}),
    groupKeys: Array.isArray(raw?.groupKeys)
      ? raw!.groupKeys.filter((k): k is string => typeof k === "string")
      : [],
  };
}

export function readItemMetadata(metadata: unknown): ImportItemMetadata | null {
  const raw = (metadata as Record<string, unknown> | null)?.[
    IMPORT_ITEM_KEY
  ] as Partial<ImportItemMetadata> | undefined;
  if (!raw || raw.version !== 1 || !raw.source) return null;
  const status = (IMPORT_CONTENT_STATUSES as readonly string[]).includes(
    raw.contentStatus as string
  )
    ? (raw.contentStatus as ImportContentStatus)
    : "title_only";
  return {
    version: 1,
    title: raw.title ?? "",
    source: raw.source,
    ...(raw.card ? { card: raw.card } : {}),
    contentStatus: status,
    stagedAt: raw.stagedAt ?? "",
  };
}

export function toItemView(row: {
  id: string;
  metadata: unknown;
  createdAt: Date;
}): ImportItemView | null {
  const meta = readItemMetadata(row.metadata);
  if (!meta) return null;
  const curation = readItemCuration(row.metadata);
  return {
    id: row.id,
    title: meta.title,
    source: meta.source,
    ...(meta.card ? { card: meta.card } : {}),
    contentStatus: meta.contentStatus,
    decision: curation.decision,
    ...(curation.note ? { note: curation.note } : {}),
    groupKeys: curation.groupKeys,
    stagedAt: meta.stagedAt || row.createdAt.toISOString(),
  };
}

/** Every item row of an import, in staging order. */
export async function loadImportItemRows(args: {
  database: ImportDb;
  userId: string;
  sessionId: string;
  ids?: readonly string[];
}): Promise<ImportItemRow[]> {
  const rows = await args.database
    .select({
      id: documents.id,
      metadata: documents.metadata,
      createdAt: documents.createdAt,
      storageKey: documents.storageKey,
      mimeType: documents.mimeType,
    })
    .from(documents)
    .where(importItemsWhere(args.userId, args.sessionId))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  const wanted = args.ids ? new Set(args.ids) : null;
  return rows
    .filter((r) => !wanted || wanted.has(r.id))
    .map((r) => ({
      ...r,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const createdAt = new Date(parsed.c);
    if (typeof parsed.i !== "string" || Number.isNaN(createdAt.getTime())) {
      throw new Error("malformed");
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
  }
}

/** Counts over every item of an import (light read: curation only). */
export async function countImportItems(args: {
  database: ImportDb;
  userId: string;
  session: ImportSessionRow;
}) {
  const rows = await args.database
    .select({
      id: documents.id,
      metadata: documents.metadata,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(importItemsWhere(args.userId, args.session.id));
  const views = rows
    .map(toItemView)
    .filter((v): v is ImportItemView => v !== null);
  return importCounts(views, args.session.curation.groups);
}

/** `imports.get` — the whole import, items paged in staging order. */
export async function buildImportView(args: {
  database: ImportDb;
  userId: string;
  session: ImportSessionRow;
  cursor?: string | null;
  limit?: number;
}): Promise<ImportView> {
  const limit = Math.min(
    Math.max(args.limit ?? IMPORT_VIEW_PAGE_DEFAULT, 1),
    IMPORT_VIEW_PAGE_MAX
  );
  const after = args.cursor ? decodeCursor(args.cursor) : null;
  const all = await args.database
    .select({
      id: documents.id,
      metadata: documents.metadata,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(importItemsWhere(args.userId, args.session.id))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  const views = all
    .map((row) => ({ row, view: toItemView(row) }))
    .filter(
      (x): x is { row: (typeof all)[number]; view: ImportItemView } =>
        x.view !== null
    );
  const start = after
    ? views.findIndex(
        ({ row }) =>
          row.createdAt.getTime() > after.createdAt.getTime() ||
          (row.createdAt.getTime() === after.createdAt.getTime() &&
            row.id > after.id)
      )
    : 0;
  const page = start < 0 ? [] : views.slice(start, start + limit);
  const more = start >= 0 && start + limit < views.length;
  const { curation } = args.session;
  return {
    sessionId: args.session.id,
    title: args.session.title,
    phase: curation.phase,
    ...(curation.origin ? { origin: curation.origin } : {}),
    groups: curation.groups,
    items: page.map((p) => p.view),
    counts: importCounts(
      views.map((v) => v.view),
      curation.groups
    ),
    nextCursor: more ? encodeCursor(page[page.length - 1]!.row) : null,
  };
}
