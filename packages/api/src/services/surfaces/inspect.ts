/**
 * THE surface inspect: what a framed surface does, read before
 * it is handed over. tRPC `surfaces.inspect`, Hub `GET /surfaces/inspect` and
 * MCP `synap_inspect_surface` all call `inspectSurface`.
 *
 * The surface: `{kind: "cell", typeKey}` (a cell type), `{kind: "cell", id}`
 * (a cell instance: its type, or its page when it is an html-embed),
 * `{kind: "document", id}` (an HTML page) or `{kind: "view", id}` (a view:
 * the cells it places). Loaded AS THE CALLER: one it cannot see is a
 * NOT_FOUND.
 *
 * Four sections, each `{status: "ok", …}` or `{status: "unavailable",
 * reason}`: a check that could not run says so, never an empty pass.
 *   reads   what the frame read door logged for it (`frame_read_log`, the
 *           last `days` days, at most the log's retention): ops answered,
 *           ops refused (FRAME_READ_UNDECLARED), declared but never used,
 *           asked but not declared. Only rows the caller may see: a row in a
 *           space it reads, or its own.
 *   tokens  hard-coded colours and fonts in the stored code (inspect-lint).
 *   a11y    static accessibility lint of the stored HTML (inspect-lint).
 *   render  always unavailable here: the pod has no browser. A screenshot
 *           and the console errors come from the person's computer.
 */

import { TRPCError } from "@trpc/server";
import { db, and, eq, or, inArray } from "@synap/database";
import {
  cellInstances,
  documents,
  frameReadLog,
  views,
  FRAME_READ_LOG_RETENTION_DAYS,
} from "@synap/database/schema";
import { storage } from "@synap/storage";
import { count, gte, max, type SQL } from "drizzle-orm";
import {
  CELL_FRAME_MAX_BYTES,
  FRAME_READ_UNDECLARED,
  storedDeclaredReads,
  type CellBridgeDeclaredReads,
} from "@synap-core/types/cell-bridge";
import { blockCellKey, readLegacyBlock } from "@synap-core/types/blocks";
import { permits } from "@synap/governance-policy/grants";
import { scopedDb } from "../../access/scoped-db.js";
import type { AccessContext } from "../../access/context.js";
import type { Principal } from "../../access/door.js";
import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import {
  callerPrincipal,
  callerReadsLens,
  isFramePage,
  keyBindingReaches,
  resolveCellType,
  type ResolvedCellType,
} from "./frame-read.js";
import {
  lintA11y,
  lintTokens,
  type A11yFinding,
  type LintSource,
  type TokenFinding,
} from "./inspect-lint.js";

export const INSPECT_SURFACE_KINDS = ["cell", "document", "view"] as const;
export type InspectSurfaceKind = (typeof INSPECT_SURFACE_KINDS)[number];

export interface InspectSurfaceInput {
  surface: { kind: InspectSurfaceKind; id?: string; typeKey?: string };
  /** A cell type's space (its lens); ignored for a document or a view. */
  workspaceId?: string | null;
  /** How far back the read log is read (1 to the log's retention). */
  days?: number;
}

export interface InspectContext {
  userId: string;
  access: AccessContext;
  /** The acting agent, when an agent calls. */
  agentUserId?: string | null;
  /**
   * The space the calling key is bound to (null/absent: no key, or a
   * pod-wide one). A surface of another space is refused (403), and the read
   * log is read in that space only, whatever the person may read.
   */
  keyWorkspaceId?: string | null;
}

export type Section<T> =
  ({ status: "ok" } & T) | { status: "unavailable"; reason: string };

export interface OpCount {
  op: string;
  count: number;
  lastAt: string;
}

/** What one logged surface (a cell type or a page) read. */
export interface SurfaceReads {
  surfaceKind: "cell" | "document";
  key: string;
  /** What it declares; null = it declares nothing (every read answered). */
  declared: CellBridgeDeclaredReads | null;
  used: OpCount[];
  refused: Array<OpCount & { code: typeof FRAME_READ_UNDECLARED }>;
  declaredUnused: string[];
  /** Ops it asked for that the declaration does not name (all, when it declares nothing). */
  usedUndeclared: string[];
}

export interface ReadsReport {
  days: number;
  since: string;
  surfaces: SurfaceReads[];
  /** Cells whose reads do not go through the frame read door. */
  notLogged: Array<{ key: string; reason: string }>;
}

export interface LintReport<F> {
  findings: F[];
  linted: string[];
  notLinted: Array<{ source: string; reason: string }>;
}

export interface SurfaceInspection {
  surface: {
    kind: InspectSurfaceKind;
    id: string | null;
    typeKey: string | null;
    title: string;
    workspaceId: string | null;
    /** view: the cell types it places. */
    cellKeys?: string[];
  };
  reads: Section<ReadsReport>;
  tokens: Section<LintReport<TokenFinding>>;
  a11y: Section<LintReport<A11yFinding>>;
  render: { status: "unavailable"; reason: string };
}

export const RENDER_UNAVAILABLE_REASON =
  "no headless renderer on the pod: the screenshot and console errors come from the person's computer";

const notFound = (what: string) =>
  new TRPCError({ code: "NOT_FOUND", message: `${what} not found.` });

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// ── What is inspected ──────────────────────────────────────────────────────

/** A cell type as the catalog stores it. */
type CellType = ResolvedCellType;

/** A page: an html document, or an html-embed cell's source. */
interface Page {
  id: string;
  title: string;
  workspaceId: string | null;
  storageKey: string | null;
  size: number;
  metadata: Record<string, unknown> | null;
}

interface Target {
  surface: SurfaceInspection["surface"];
  /** The cell types it draws with (one for a cell, the placed ones for a view). */
  cells: Array<{ key: string; type: CellType | null }>;
  page: Page | null;
  /** The space the read log is read in (a view's, a cell lens); null = every space the caller reads. */
  logSpace: string | null;
}

async function loadPage(
  access: AccessContext,
  documentId: string
): Promise<Page | null> {
  const doc = await scopedDb(access).findFirst<{
    id: string;
    title: string;
    type: string;
    mimeType: string | null;
    workspaceId: string | null;
    storageKey: string | null;
    size: number;
    metadata: unknown;
    deletedAt: Date | null;
  }>(documents, {
    where: eq(documents.id, documentId),
    columns: {
      id: true,
      title: true,
      type: true,
      mimeType: true,
      workspaceId: true,
      storageKey: true,
      size: true,
      metadata: true,
      deletedAt: true,
    },
  });
  if (!doc || doc.deletedAt) return null;
  if (!isFramePage(doc)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This document is not a page: only an HTML page (type html) runs in a frame and can be inspected.",
    });
  }
  return {
    id: doc.id,
    title: doc.title,
    workspaceId: doc.workspaceId,
    storageKey: doc.storageKey,
    size: doc.size,
    metadata: (doc.metadata ?? null) as Record<string, unknown> | null,
  };
}

/** The cell types a view places (`config.blocks`: cell keys and legacy widget tiles). */
export function viewCellKeys(config: unknown): string[] {
  const blocks = (config as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const keys = new Set<string>();
  for (const raw of blocks) {
    // The one block reader (`@synap-core/types/blocks`): a `cell` block, a
    // legacy `widget` tile, a whiteboard shape's props.
    const block = readLegacyBlock(raw);
    const key = block ? blockCellKey(block) : undefined;
    if (key) keys.add(key);
  }
  return [...keys];
}

/** A surface in another space than the calling key's: refused. */
function assertKeyReaches(principal: Principal, workspaceId: string | null) {
  if (!keyBindingReaches(principal, workspaceId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This surface is in another space than the one this key is bound to.",
    });
  }
}

async function resolveTarget(
  ctx: InspectContext,
  input: InspectSurfaceInput
): Promise<Target> {
  const { kind, id, typeKey } = input.surface;
  const principal = callerPrincipal(ctx);
  if (kind === "document") {
    if (!id) throw badRequest("Pass the document's id.");
    const page = await loadPage(ctx.access, id);
    if (!page) throw notFound("Page");
    assertKeyReaches(principal, page.workspaceId);
    return {
      surface: {
        kind,
        id: page.id,
        typeKey: null,
        title: page.title,
        workspaceId: page.workspaceId,
      },
      cells: [],
      page,
      logSpace: null,
    };
  }

  if (kind === "view") {
    if (!id) throw badRequest("Pass the view's id.");
    const view = await scopedDb(ctx.access).findFirst<{
      id: string;
      name: string;
      config: unknown;
      workspaceId: string | null;
    }>(views, {
      where: eq(views.id, id),
      columns: { id: true, name: true, config: true, workspaceId: true },
    });
    if (!view) throw notFound("View");
    assertKeyReaches(principal, view.workspaceId);
    const keys = viewCellKeys(view.config);
    const cells = await Promise.all(
      keys.map(async (key) => ({
        key,
        type: await resolveCellType(key, view.workspaceId),
      }))
    );
    return {
      surface: {
        kind,
        id: view.id,
        typeKey: null,
        title: view.name,
        workspaceId: view.workspaceId,
        cellKeys: keys,
      },
      cells,
      page: null,
      logSpace: view.workspaceId,
    };
  }

  // A cell: by its instance, or by its type key.
  if (id) {
    const instance = await scopedDb(ctx.access).findFirst<{
      id: string;
      cellType: string;
      name: string | null;
      workspaceId: string;
      sourceDocumentId: string | null;
    }>(cellInstances, {
      where: eq(cellInstances.id, id),
      columns: {
        id: true,
        cellType: true,
        name: true,
        workspaceId: true,
        sourceDocumentId: true,
      },
    });
    if (!instance) throw notFound("Cell");
    assertKeyReaches(principal, instance.workspaceId);
    // An html-embed draws its source document as a page: that is what runs.
    const page = instance.sourceDocumentId
      ? await loadPage(ctx.access, instance.sourceDocumentId)
      : null;
    if (instance.sourceDocumentId && !page) throw notFound("Cell's page");
    if (page) assertKeyReaches(principal, page.workspaceId);
    const type = page
      ? null
      : await resolveCellType(instance.cellType, instance.workspaceId);
    return {
      surface: {
        kind,
        id: instance.id,
        typeKey: instance.cellType,
        title: instance.name || instance.cellType,
        workspaceId: instance.workspaceId,
      },
      cells: page ? [] : [{ key: instance.cellType, type }],
      page,
      logSpace: instance.workspaceId,
    };
  }
  if (!typeKey) throw badRequest("Pass the cell's typeKey or its id.");
  const lens = input.workspaceId ?? null;
  // The caller reads the lens: the key's binding and grant, not only the person.
  if (!(await callerReadsLens(principal, lens))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You cannot read this space.",
    });
  }
  const type = await resolveCellType(typeKey, lens);
  if (!type) throw notFound("Cell type");
  return {
    surface: {
      kind,
      id: null,
      typeKey,
      title: typeKey,
      workspaceId: type.workspaceId,
    },
    cells: [{ key: typeKey, type }],
    page: null,
    logSpace: lens,
  };
}

function badRequest(message: string) {
  return new TRPCError({ code: "BAD_REQUEST", message });
}

/** A cell type that runs in a frame (its reads go through the frame read door). */
const isFramed = (type: CellType) => type.rendererType !== "builtin";

// ── Reads ──────────────────────────────────────────────────────────────────

async function readLog(
  ctx: InspectContext,
  surfaceKind: "cell" | "document",
  key: string,
  logSpace: string | null,
  since: Date,
  readable: string[],
  boundSpace: string | null
) {
  const floor: SQL | undefined =
    readable.length > 0
      ? or(
          inArray(frameReadLog.workspaceId, readable),
          eq(frameReadLog.userId, ctx.userId)
        )
      : eq(frameReadLog.userId, ctx.userId);
  return db
    .select({
      op: frameReadLog.op,
      allowed: frameReadLog.allowed,
      n: count(),
      lastAt: max(frameReadLog.at),
    })
    .from(frameReadLog)
    .where(
      and(
        eq(frameReadLog.surfaceKind, surfaceKind),
        eq(frameReadLog.surfaceKey, key),
        gte(frameReadLog.at, since),
        logSpace ? eq(frameReadLog.workspaceId, logSpace) : undefined,
        // A bound key reads its own space's rows only, its person's included.
        boundSpace ? eq(frameReadLog.workspaceId, boundSpace) : undefined,
        floor
      )
    )
    .groupBy(frameReadLog.op, frameReadLog.allowed);
}

/** Compare what a surface declares with what its frame asked for. */
export function compareReads(
  declared: CellBridgeDeclaredReads | null,
  rows: Array<{ op: string; allowed: boolean; n: number; lastAt: Date | null }>
): Omit<SurfaceReads, "surfaceKind" | "key" | "declared"> {
  const toCount = (r: (typeof rows)[number]): OpCount => ({
    op: r.op,
    count: Number(r.n),
    lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : "",
  });
  const byOp = (a: OpCount, b: OpCount) => a.op.localeCompare(b.op);
  const used = rows
    .filter((r) => r.allowed)
    .map(toCount)
    .sort(byOp);
  const refused = rows
    .filter((r) => !r.allowed)
    .map((r) => ({ ...toCount(r), code: FRAME_READ_UNDECLARED }))
    .sort(byOp);
  const declaredOps = new Set((declared ?? []).map((d) => d.op as string));
  const usedOps = new Set(used.map((u) => u.op));
  const askedOps = new Set(rows.map((r) => r.op));
  return {
    used,
    refused,
    declaredUnused: [...declaredOps].filter((op) => !usedOps.has(op)).sort(),
    usedUndeclared: [...askedOps]
      .filter((op) => declared === null || !declaredOps.has(op))
      .sort(),
  };
}

async function readsSection(
  ctx: InspectContext,
  target: Target,
  days: number
): Promise<Section<ReadsReport>> {
  const since = new Date(Date.now() - days * 86_400_000);
  const logged: Array<{
    surfaceKind: "cell" | "document";
    key: string;
    declared: CellBridgeDeclaredReads | null;
  }> = [];
  const notLogged: ReadsReport["notLogged"] = [];
  if (target.page) {
    logged.push({
      surfaceKind: "document",
      key: target.page.id,
      declared: storedDeclaredReads(target.page.metadata?.reads),
    });
  }
  for (const { key, type } of target.cells) {
    if (!type) {
      notLogged.push({ key, reason: "no active cell type with this key here" });
    } else if (!isFramed(type)) {
      notLogged.push({
        key,
        reason:
          "a built-in cell reads through the app's own hooks, not the frame read door: its reads are not logged",
      });
    } else {
      logged.push({
        surfaceKind: "cell",
        key,
        declared: storedDeclaredReads(type.reads),
      });
    }
  }
  if (logged.length === 0) {
    return {
      status: "unavailable",
      reason:
        notLogged.length > 0
          ? `nothing here reads through the frame read door (${notLogged.map((n) => `${n.key}: ${n.reason}`).join("; ")})`
          : "this view places no cells, so there is no frame read to show",
    };
  }
  try {
    const principal = callerPrincipal(ctx);
    const boundSpace = principal.key?.workspaceId ?? null;
    const readable = (await getUserWorkspaceIds(ctx.userId)).filter(
      (workspaceId) =>
        keyBindingReaches(principal, workspaceId) &&
        // Under a grant, a space's log is read where the grant reads its
        // events (the access door's rule for reading a space).
        (!principal.grant ||
          principal.grant.scopes.some((scope) =>
            permits(scope, { subject: "event", action: "read", workspaceId })
          ))
    );
    const surfaces: SurfaceReads[] = [];
    for (const s of logged) {
      const rows = await readLog(
        ctx,
        s.surfaceKind,
        s.key,
        // A page reads in its own space; a cell in the host's lens.
        s.surfaceKind === "document" ? null : target.logSpace,
        since,
        readable,
        boundSpace
      );
      surfaces.push({ ...s, ...compareReads(s.declared, rows) });
    }
    return {
      status: "ok",
      days,
      since: since.toISOString(),
      surfaces,
      notLogged,
    };
  } catch (err) {
    return {
      status: "unavailable",
      reason: `the frame read log could not be read: ${errorText(err)}`,
    };
  }
}

// ── Static lint ────────────────────────────────────────────────────────────

/** The stored code to lint, and what could not be read (never dropped). */
async function lintSources(target: Target): Promise<{
  sources: LintSource[];
  notLinted: Array<{ source: string; reason: string }>;
}> {
  const sources: LintSource[] = [];
  const notLinted: Array<{ source: string; reason: string }> = [];
  if (target.page) {
    const label = `document:${target.page.id}`;
    if (!target.page.storageKey) {
      notLinted.push({ source: label, reason: "the page has no stored body" });
    } else if (target.page.size > CELL_FRAME_MAX_BYTES) {
      notLinted.push({
        source: label,
        reason: `the page is ${target.page.size} bytes, over the frame cap of ${CELL_FRAME_MAX_BYTES}: hosts show it as source only`,
      });
    } else {
      try {
        const text = (
          await storage.downloadBuffer(target.page.storageKey)
        ).toString("utf-8");
        sources.push({ label, text, language: "html" });
      } catch (err) {
        notLinted.push({
          source: label,
          reason: `the page body could not be read: ${errorText(err)}`,
        });
      }
    }
  }
  for (const { key, type } of target.cells) {
    const label = `cell:${key}`;
    if (!type) {
      notLinted.push({
        source: label,
        reason: "no active cell type with this key here",
      });
      continue;
    }
    let any = false;
    if (type.rendererSource) {
      any = true;
      sources.push({
        label: `${label} rendererSource`,
        text: type.rendererSource,
        // `iframe` and `mcp-app` store a page; `frame` stores a module.
        language:
          type.rendererType === "iframe" || type.rendererType === "mcp-app"
            ? "html"
            : "module",
      });
    }
    if (type.source) {
      any = true;
      sources.push({
        label: `${label} source`,
        text: type.source,
        language: "module",
      });
    }
    if (!any) {
      notLinted.push({
        source: label,
        reason:
          type.rendererType === "builtin"
            ? "a built-in cell: its code ships with the app, not stored on the pod"
            : "the cell type stores no source",
      });
    }
  }
  return { sources, notLinted };
}

function lintSection<F>(
  sources: LintSource[],
  notLinted: Array<{ source: string; reason: string }>,
  accepts: (s: LintSource) => boolean,
  lint: (s: LintSource) => F[],
  skippedReason: string
): Section<LintReport<F>> {
  const linted = sources.filter(accepts);
  const skipped = sources
    .filter((s) => !accepts(s))
    .map((s) => ({ source: s.label, reason: skippedReason }));
  const all = [...notLinted, ...skipped];
  if (linted.length === 0) {
    return {
      status: "unavailable",
      reason:
        all.length > 0
          ? `nothing could be linted (${all.map((n) => `${n.source}: ${n.reason}`).join("; ")})`
          : "this view places no cells, so there is no code to lint",
    };
  }
  return {
    status: "ok",
    findings: linted.flatMap(lint),
    linted: linted.map((s) => s.label),
    notLinted: all,
  };
}

// ── The door ───────────────────────────────────────────────────────────────

export function clampInspectDays(days: number | undefined): number {
  if (days === undefined || !Number.isFinite(days))
    return FRAME_READ_LOG_RETENTION_DAYS;
  return Math.min(FRAME_READ_LOG_RETENTION_DAYS, Math.max(1, Math.floor(days)));
}

export async function inspectSurface(
  ctx: InspectContext,
  input: InspectSurfaceInput
): Promise<SurfaceInspection> {
  const target = await resolveTarget(ctx, input);
  const days = clampInspectDays(input.days);
  const [reads, lint] = await Promise.all([
    readsSection(ctx, target, days),
    lintSources(target),
  ]);
  return {
    surface: target.surface,
    reads,
    tokens: lintSection(
      lint.sources,
      lint.notLinted,
      () => true,
      lintTokens,
      ""
    ),
    a11y: lintSection(
      lint.sources,
      lint.notLinted,
      (s) => s.language === "html",
      lintA11y,
      "a module (JS/JSX) source: the accessibility lint reads HTML only"
    ),
    render: { status: "unavailable", reason: RENDER_UNAVAILABLE_REASON },
  };
}
