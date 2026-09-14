/**
 * Captures — the caller's own raw captures (raw-capture contract §4).
 *
 * A capture IS an intake source document (`documents.metadata.intakeSource`,
 * written only by `stageIntakeSource`). There is no captures table and no
 * stored status: `status` is derived per row by `deriveCaptureStatus`.
 *
 * ── Access ────────────────────────────────────────────────────────────────
 * Documents are read through `scopedDb` (the `documents` VisibilityRule —
 * `accessScopeWhere`), NARROWED to `documents.userId = caller`: the rule lets a
 * workspace member see a colleague's documents, but "my captures" is the
 * caller's own. Everything else hangs off those loaded rows:
 *   - produced edges (`links`) are keyed by the owner-floored document ids and
 *     only COUNTED in `list`; `get` hydrates the entities through `scopedDb`, so
 *     an entity the caller cannot see is dropped, never named;
 *   - sessions are loaded through `scopedDb` (focus_sessions is ownerPrivate);
 *     the open-question probe reads messages only in those sessions' channels
 *     and returns a boolean.
 *
 * ── producedCount ─────────────────────────────────────────────────────────
 * `document --produced--> entity` edges (written by `stampMaterialized`). A
 * document with NO document edge falls back to its session's
 * `session --produced--> entity` edges. TRANSITIONAL: that fallback exists for
 * captures materialized before the document edge was written, it over-counts
 * when one session staged several sources, and it is pinned by
 * `captures.pglite.test.ts` so removing it is a deliberate, visible change.
 * Only live (not soft-deleted) entities count.
 *
 * ── door ──────────────────────────────────────────────────────────────────
 * `intakeSource.door` when it is one of `CAPTURE_DOORS`; null when absent or
 * unrecognised — never guessed, never passed through raw.
 *
 * ── kinds ─────────────────────────────────────────────────────────────────
 * `list` shows ONLY `CAPTURE_LIST_KINDS` (what a person captured). Machine
 * intake kinds added later (sync records, run I/O) must never flood the list,
 * so it is an allowlist, not a denylist. `get` resolves any kind the caller owns.
 *
 * ── structureAgain ────────────────────────────────────────────────────────
 * Redo ONE capture from its raw, including a capture staged with no run
 * (`services/captures/structure-capture-again.ts`). It delegates to the one
 * rerun door (`rerunSession`, scoped to this document) and answers in its
 * shapes, so the room's confirm and `describeRerunOutcome` read it unchanged.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  or,
  eq,
  lt,
  desc,
  isNull,
  inArray,
  drizzleSql,
  documents,
  documentVersions,
  entities,
  profiles,
  focusSessions,
  links,
  messages,
  readDocumentVersionContent,
} from "@synap/database";
import { router, protectedProcedure } from "../trpc.js";
import { requireUserId } from "../utils/user-scoped.js";
import { AccessContext, scopedDb } from "../access/index.js";
import {
  CAPTURE_STATUSES,
  deriveCaptureStatus,
  type CaptureStatus,
} from "../services/captures/derive-capture-status.js";
import {
  INTAKE_SOURCE_METADATA_KEY,
  type IntakeSourceMetadata,
} from "../services/intake/stage-intake-source.js";
import {
  CAPTURE_LIST_KINDS,
  ownCapturesWhere,
} from "../services/captures/capture-scope.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";

export { CAPTURE_LIST_KINDS };

export const CAPTURES_LIST_DEFAULT_LIMIT = 30;
export const CAPTURES_LIST_MAX_LIMIT = 100;
export const CAPTURE_PREVIEW_MAX = 200;
/**
 * A `status` filter scans newest-first in pages; it stops after this many
 * pages and hands back a cursor, so a rare status cannot turn one call into a
 * full-table walk. A short page with a non-null `nextCursor` means "keep going".
 */
export const CAPTURES_FILTER_MAX_SCAN_PAGES = 5;

/** The intake doors a capture can name; anything else reads as null. */
export const CAPTURE_DOORS = [
  "capture",
  "capture.execute",
  "capture.graph",
  "message.interpret",
  "calcom.webhook",
  "calcom.backfill",
  "import",
  "structure_again",
] as const;

export type CaptureDoor = (typeof CAPTURE_DOORS)[number];

export function captureDoorOf(door: unknown): CaptureDoor | null {
  return (CAPTURE_DOORS as ReadonlyArray<unknown>).includes(door)
    ? (door as CaptureDoor)
    : null;
}

export interface CaptureItem {
  documentId: string;
  kind: IntakeSourceMetadata["kind"];
  preview: string;
  createdAt: Date;
  door: CaptureDoor | null;
  sessionId: string | null;
  status: CaptureStatus;
  degradedReason: string | null;
  producedCount: number;
}

export interface CaptureDetail extends CaptureItem {
  raw: {
    /** The full text body (latest version), or null for a bytes-only file. */
    text: string | null;
    /**
     * A stored file. Resolve it through the stored-file door
     * (`GET /api/files/documents/:documentId/url` / `useStoredFileUrl`) — the
     * pod never signs a blob here.
     */
    file: {
      documentId: string;
      filename: string | null;
      mimeType: string | null;
      size: number | null;
    } | null;
  };
  produced: Array<{
    entityId: string;
    title: string | null;
    kind: string | null;
  }>;
  runs: Array<{ sessionId: string; spawnedFrom: string | null; at: Date }>;
}

type SourceRow = {
  id: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  storageKey: string | null;
  mimeType: string | null;
  size: number | null;
};

const SOURCE_COLUMNS = {
  id: true,
  title: true,
  metadata: true,
  createdAt: true,
  storageKey: true,
  mimeType: true,
  size: true,
} as const;

// ── cursor ──────────────────────────────────────────────────────────────────

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

// ── reads ───────────────────────────────────────────────────────────────────

function sourceOf(row: SourceRow): IntakeSourceMetadata {
  return (row.metadata ?? {})[
    INTAKE_SOURCE_METADATA_KEY
  ] as IntakeSourceMetadata;
}

/** `list` only: the capture kind is on the allowlist. */
function listedKindWhere() {
  return inArray(
    drizzleSql<string>`${documents.metadata} -> ${INTAKE_SOURCE_METADATA_KEY} ->> 'kind'`,
    [...CAPTURE_LIST_KINDS]
  );
}

/**
 * Produced entity ids per document: document edges first; the session edges
 * of the source's run only for a document that has no document edge
 * (TRANSITIONAL — see the file header).
 */
async function producedEntityIds(
  rows: SourceRow[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (rows.length === 0) return out;
  const liveTargets = (fromType: "document" | "session", fromIds: string[]) =>
    db
      .select({ fromId: links.fromId, entityId: links.toId })
      .from(links)
      .innerJoin(
        entities,
        and(
          eq(drizzleSql`${entities.id}::text`, links.toId),
          isNull(entities.deletedAt)
        )
      )
      .where(
        and(
          eq(links.fromType, fromType),
          inArray(links.fromId, fromIds),
          eq(links.toType, "entity"),
          eq(links.linkType, "produced")
        )
      );

  for (const r of await liveTargets(
    "document",
    rows.map((row) => row.id)
  )) {
    out.set(r.fromId, [...(out.get(r.fromId) ?? []), r.entityId]);
  }

  const fallback = rows.filter(
    (row) => !out.has(row.id) && sourceOf(row).sessionId
  );
  if (fallback.length > 0) {
    const bySession = new Map<string, string[]>();
    for (const r of await liveTargets("session", [
      ...new Set(fallback.map((row) => sourceOf(row).sessionId!)),
    ])) {
      bySession.set(r.fromId, [...(bySession.get(r.fromId) ?? []), r.entityId]);
    }
    for (const row of fallback) {
      const ids = bySession.get(sourceOf(row).sessionId!);
      if (ids) out.set(row.id, ids);
    }
  }
  for (const [id, ids] of out) out.set(id, [...new Set(ids)]);
  return out;
}

/** Session ids (among the caller's visible sessions) holding an OPEN capture_question. */
async function sessionsWithOpenQuestion(
  access: AccessContext,
  sessionIds: string[]
): Promise<Set<string>> {
  const open = new Set<string>();
  if (sessionIds.length === 0) return open;
  const sessions = await scopedDb(access).findMany<{
    id: string;
    channelId: string | null;
  }>(focusSessions, {
    where: inArray(focusSessions.id, sessionIds),
    columns: { id: true, channelId: true },
  });
  const sessionByChannel = new Map(
    sessions.flatMap((s) => (s.channelId ? [[s.channelId, s.id] as const] : []))
  );
  if (sessionByChannel.size === 0) return open;
  const rows = await db
    .selectDistinct({ channelId: messages.channelId })
    .from(messages)
    .where(
      and(
        inArray(messages.channelId, [...sessionByChannel.keys()]),
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'kind' = 'capture_question'`,
        drizzleSql`${messages.metadata} -> 'capturePart' ->> 'status' = 'open'`
      )
    );
  for (const r of rows) {
    const sessionId = r.channelId ? sessionByChannel.get(r.channelId) : null;
    if (sessionId) open.add(sessionId);
  }
  return open;
}

/** The latest version's stored preview per document (list preview only). */
async function versionPreviews(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectDistinctOn([documentVersions.documentId], {
      documentId: documentVersions.documentId,
      content: documentVersions.content,
    })
    .from(documentVersions)
    .where(inArray(documentVersions.documentId, ids))
    .orderBy(documentVersions.documentId, desc(documentVersions.version));
  for (const r of rows) if (r.content?.trim()) out.set(r.documentId, r.content);
  return out;
}

function previewFor(row: SourceRow, versionText: string | undefined): string {
  const source = sourceOf(row);
  const text =
    versionText?.trim() ||
    source.url ||
    source.path ||
    source.filename ||
    row.title ||
    "";
  return text.replace(/\s+/g, " ").trim().slice(0, CAPTURE_PREVIEW_MAX);
}

async function toItems(
  access: AccessContext,
  rows: SourceRow[]
): Promise<{ items: CaptureItem[]; produced: Map<string, string[]> }> {
  const sessionIds = [
    ...new Set(rows.flatMap((row) => sourceOf(row).sessionId ?? [])),
  ];
  const [produced, openSessions, previews] = await Promise.all([
    producedEntityIds(rows),
    sessionsWithOpenQuestion(access, sessionIds),
    versionPreviews(rows.map((row) => row.id)),
  ]);
  const items = rows.map((row): CaptureItem => {
    const source = sourceOf(row);
    const producedCount = produced.get(row.id)?.length ?? 0;
    return {
      documentId: row.id,
      kind: source.kind,
      preview: previewFor(row, previews.get(row.id)),
      createdAt: row.createdAt,
      door: captureDoorOf(source.door),
      sessionId: source.sessionId ?? null,
      status: deriveCaptureStatus({
        hasOpenQuestion: Boolean(
          source.sessionId && openSessions.has(source.sessionId)
        ),
        degraded: Boolean(source.degraded),
        producedCount,
      }),
      degradedReason: source.degraded?.reason ?? null,
      producedCount,
    };
  });
  return { items, produced };
}

// ── router ──────────────────────────────────────────────────────────────────

export const capturesRouter = router({
  /** The caller's own captures, newest first. */
  list: protectedProcedure
    .input(
      z
        .object({
          cursor: z.string().optional(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(CAPTURES_LIST_MAX_LIMIT)
            .default(CAPTURES_LIST_DEFAULT_LIMIT),
          status: z.enum(CAPTURE_STATUSES).optional(),
        })
        .default({ limit: CAPTURES_LIST_DEFAULT_LIMIT })
    )
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ items: CaptureItem[]; nextCursor: string | null }> => {
        const userId = requireUserId(ctx.userId);
        const access = AccessContext.from(ctx);
        const items: CaptureItem[] = [];
        let after = input.cursor ? decodeCursor(input.cursor) : null;

        for (
          let page = 0;
          page < (input.status ? CAPTURES_FILTER_MAX_SCAN_PAGES : 1);
          page++
        ) {
          const want = input.limit - items.length;
          const rows = await scopedDb(access).findMany<SourceRow>(documents, {
            where: and(
              ownCapturesWhere(userId),
              listedKindWhere(),
              after
                ? or(
                    lt(documents.createdAt, after.createdAt),
                    and(
                      eq(documents.createdAt, after.createdAt),
                      lt(documents.id, after.id)
                    )
                  )
                : undefined
            ),
            columns: SOURCE_COLUMNS,
            orderBy: [desc(documents.createdAt), desc(documents.id)],
            // Unfiltered: one extra row says whether a next page exists.
            // Filtered: scan a full page, since rows are dropped after derivation.
            limit: input.status ? input.limit : want + 1,
          });
          const hasMore = input.status
            ? rows.length === input.limit
            : rows.length > want;
          const scanned = input.status ? rows : rows.slice(0, want);
          const { items: derived } = await toItems(access, scanned);

          for (let i = 0; i < derived.length; i++) {
            if (input.status && derived[i]!.status !== input.status) continue;
            items.push(derived[i]!);
            if (items.length === input.limit) {
              const last = scanned[i]!;
              const more = i < scanned.length - 1 || hasMore;
              return { items, nextCursor: more ? encodeCursor(last) : null };
            }
          }
          if (!hasMore) return { items, nextCursor: null };
          after = scanned[scanned.length - 1]!;
          if (!input.status) return { items, nextCursor: encodeCursor(after) };
        }
        return { items, nextCursor: after ? encodeCursor(after) : null };
      }
    ),

  /** One own capture: the item, its full raw, what it made, and its runs. */
  get: protectedProcedure
    .input(z.object({ documentId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<CaptureDetail> => {
      const userId = requireUserId(ctx.userId);
      const access = AccessContext.from(ctx);
      const row = await scopedDb(access).findFirst<SourceRow>(documents, {
        where: and(
          ownCapturesWhere(userId),
          eq(documents.id, input.documentId)
        ),
        columns: SOURCE_COLUMNS,
      });
      // A foreign id and a missing id are the same answer: never leak existence.
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Capture not found",
        });
      }
      const source = sourceOf(row);
      const {
        items: [item],
        produced,
      } = await toItems(access, [row]);

      const [latest] = await db
        .select({
          content: documentVersions.content,
          storageKey: documentVersions.storageKey,
          mimeType: documentVersions.mimeType,
        })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, row.id))
        .orderBy(desc(documentVersions.version))
        .limit(1);
      const text = latest ? await readDocumentVersionContent(latest) : null;
      const isStoredFile =
        Boolean(row.storageKey) &&
        (source.kind === "file" || !row.mimeType?.startsWith("text/"));

      const producedIds = produced.get(row.id) ?? [];
      const visibleEntities = producedIds.length
        ? await scopedDb(access).findMany<{
            id: string;
            title: string | null;
            profileId: string | null;
          }>(entities, {
            where: and(
              inArray(entities.id, producedIds),
              isNull(entities.deletedAt)
            ),
            columns: { id: true, title: true, profileId: true },
          })
        : [];
      const profileIds = [
        ...new Set(visibleEntities.flatMap((e) => e.profileId ?? [])),
      ];
      const slugs = new Map(
        profileIds.length
          ? (
              await db
                .select({ id: profiles.id, slug: profiles.slug })
                .from(profiles)
                .where(inArray(profiles.id, profileIds))
            ).map((p) => [p.id, p.slug] as const)
          : []
      );

      return {
        ...item!,
        raw: {
          text: text?.trim() ? text : null,
          file: isStoredFile
            ? {
                documentId: row.id,
                filename: source.filename ?? row.title ?? null,
                mimeType: source.mimeType ?? row.mimeType ?? null,
                size: row.size ?? null,
              }
            : null,
        },
        produced: visibleEntities.map((e) => ({
          entityId: e.id,
          title: e.title,
          kind: e.profileId ? (slugs.get(e.profileId) ?? null) : null,
        })),
        runs: source.sessionId ? await runsOf(access, source.sessionId) : [],
      };
    }),

  /**
   * STRUCTURE AGAIN — redo one own capture from its stored raw: a rerun of the
   * run that holds it, scoped to this document. A capture with no run is first
   * adopted into one. `dryRun` answers the plan and writes nothing. A refusal
   * (machine kind, replace wider than this capture, in flight…) RETURNS
   * `{ ok: false, reason, message }`; a foreign or missing id throws NOT_FOUND.
   */
  structureAgain: protectedProcedure
    .use(aiRateLimitMiddleware)
    .input(
      z.object({
        documentId: z.string().uuid(),
        mode: z.enum(["add", "replace"]).default("add"),
        dryRun: z.boolean().optional(),
        reason: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { structureCaptureAgain } =
        await import("../services/captures/structure-capture-again.js");
      const result = await structureCaptureAgain({
        documentId: input.documentId,
        userId: requireUserId(ctx.userId),
        mode: input.mode,
        dryRun: input.dryRun,
        reason: input.reason,
        agentUserId: ctx.agentUserId ?? null,
        callerContext: ctx,
      });
      if (!result.ok && result.reason === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: result.message });
      }
      return result;
    }),
});

/**
 * The source's run and its reruns (`session --spawned_from--> source run`),
 * oldest first. Sessions load through `scopedDb`, so a session the caller
 * cannot see is dropped rather than named.
 */
async function runsOf(
  access: AccessContext,
  sessionId: string
): Promise<CaptureDetail["runs"]> {
  const edges = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        eq(links.linkType, "spawned_from"),
        or(eq(links.toId, sessionId), eq(links.fromId, sessionId))
      )
    );
  const parentOf = new Map<string, string>();
  for (const e of edges)
    if (!parentOf.has(e.fromId)) parentOf.set(e.fromId, e.toId);
  const childIds = edges
    .filter((e) => e.toId === sessionId)
    .map((e) => e.fromId);
  const sessions = await scopedDb(access).findMany<{
    id: string;
    createdAt: Date;
  }>(focusSessions, {
    where: inArray(focusSessions.id, [sessionId, ...childIds]),
    columns: { id: true, createdAt: true },
    orderBy: [focusSessions.createdAt],
  });
  return sessions.map((s) => ({
    sessionId: s.id,
    spawnedFrom: parentOf.get(s.id) ?? null,
    at: s.createdAt,
  }));
}
