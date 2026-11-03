/**
 * TEMPLATE DOCUMENTS — the documents a workspace template carries
 * (`definition.documents[]`, plan 9ad4b2fc §5 lane 12, P4: a pinned set of
 * documents hosts a space package), installed through the SAME layer-1 path as
 * the template's views:
 *
 *   - `createWorkspaceFromDefinition` creates them after the views and seed
 *     data, then resolves every sidebar item `{kind:"document", documentSlug}`
 *     to its `documentId` in the same pass that resolves `viewName → viewId`;
 *   - `reconcileWorkspaceFromDefinition` (template update, compose overlay)
 *     creates the ones the space does not have yet and resolves an overlay's
 *     sidebar items the same way.
 *
 * One installer, two callers: neither door creates a template document any
 * other way.
 *
 * IDENTITY. A template document is identified in its space by its `slug`,
 * stamped on `documents.metadata.templateDocument.slug` at creation (a title the
 * person renames stays the same document). Lookups read every row of the space
 * with that stamp, DELETED ONES INCLUDED: a re-install never recreates a
 * document the person deleted, and never rewrites the body of one that exists
 * (the person owns it after the first install, like a seeded command). A
 * sidebar item resolves only to a LIVE document.
 *
 * THE ONE CREATE DOOR. Bodies are written by `createDocumentWithContent`
 * (`claim-document-revision.ts`, tripwire `document-content-one-door`), with
 * system provenance (the template wrote it, like seed entities), owned by the
 * installing user, in the space.
 *
 * SCOPE. A template cannot name ids, so its scope is a hint: `space` stores
 * `{kind:"workspace", workspaceId: <this space>}`, `pod` stores `{kind:"pod"}`.
 * Neither names an object the installer could not read: the install door has
 * already checked the installer may write this space.
 *
 * NOT HERE: a refresher binding (`refresh_automation_id`). Binding one grants
 * the automation's runs the right to rewrite the document's AI sections
 * without review (decision D4), and template automations only exist after
 * layer 2; it is its own slice.
 */
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import type { LensScope } from "@synap-core/types/lens";
import type {
  WorkspaceDocumentInput,
  WorkspaceDocumentScopeHint,
} from "@synap-core/types/workspaces/definition";
import { documents } from "../schema/documents.js";
import type { EventRepository } from "../repositories/event-repository.js";
import { createDocumentWithContent } from "./claim-document-revision.js";

/** The `documents.metadata` key that stamps a template document's identity. */
export const TEMPLATE_DOCUMENT_METADATA_KEY = "templateDocument";

/** The stored scope for a template's scope hint; `null` when it names none. */
export function templateDocumentScope(
  hint: WorkspaceDocumentScopeHint | undefined,
  workspaceId: string
): LensScope | null {
  if (hint === "space") return { kind: "workspace", workspaceId };
  if (hint === "pod") return { kind: "pod" };
  return null;
}

/** A space's template documents by slug: `live` false = the person deleted it. */
export type TemplateDocumentsBySlug = Map<
  string,
  { id: string; live: boolean }
>;

/** Every template document of the space, deleted ones included (see IDENTITY). */
export async function templateDocumentsOfSpace(
  dbConn: any,
  workspaceId: string
): Promise<TemplateDocumentsBySlug> {
  const rows: Array<{
    id: string;
    slug: string | null;
    deletedAt: Date | null;
  }> = await dbConn
    .select({
      id: documents.id,
      slug: drizzleSql<
        string | null
      >`${documents.metadata} -> ${TEMPLATE_DOCUMENT_METADATA_KEY} ->> 'slug'`,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, workspaceId),
        drizzleSql`${documents.metadata} -> ${TEMPLATE_DOCUMENT_METADATA_KEY} ->> 'slug' IS NOT NULL`
      )
    );
  const out: TemplateDocumentsBySlug = new Map();
  for (const r of rows) {
    if (!r.slug) continue;
    const live = r.deletedAt === null;
    const seen = out.get(r.slug);
    // Two rows with one slug cannot come from this installer; if a hand-made
    // one exists, a live row wins so the sidebar still opens something.
    if (!seen || (!seen.live && live)) out.set(r.slug, { id: r.id, live });
  }
  return out;
}

export interface InstallTemplateDocumentsReport {
  /** Slugs created by this run (or that a dry run WOULD create). */
  added: string[];
  /** Slugs the space already has (live, or deleted by the person): untouched. */
  skipped: string[];
  /** Live document id per slug, after this run — what sidebar items resolve to. */
  idBySlug: Record<string, string>;
}

/**
 * Create the template documents the space does not have yet. Idempotent: a
 * second run with the same definition creates nothing (also the create door's
 * resume: a crash after some documents leaves them found by slug next time).
 */
export async function installTemplateDocuments(opts: {
  dbConn: any;
  eventRepo: EventRepository;
  workspaceId: string;
  userId: string;
  documents: readonly WorkspaceDocumentInput[] | undefined;
  /**
   * The sidebar items the caller resolves with `idBySlug`. With no document
   * and no `kind:"document"` item there is nothing to install or resolve, and
   * the space is not read (every template without documents).
   */
  sidebarItems?: ReadonlyArray<{ kind?: string }>;
  dryRun?: boolean;
}): Promise<InstallTemplateDocumentsReport> {
  const report: InstallTemplateDocumentsReport = {
    added: [],
    skipped: [],
    idBySlug: {},
  };
  if (
    !opts.documents?.length &&
    !opts.sidebarItems?.some((item) => item?.kind === "document")
  ) {
    return report;
  }
  const existing = await templateDocumentsOfSpace(
    opts.dbConn,
    opts.workspaceId
  );
  for (const [slug, row] of existing) {
    if (row.live) report.idBySlug[slug] = row.id;
  }
  for (const doc of opts.documents ?? []) {
    if (!doc?.slug) continue;
    if (existing.has(doc.slug)) {
      report.skipped.push(doc.slug);
      continue;
    }
    // A slug declared twice is refused before any write (`collectCrossRefErrors`);
    // a door that skipped that check still gets one document per slug.
    if (report.added.includes(doc.slug)) continue;
    report.added.push(doc.slug);
    if (opts.dryRun) continue;
    const created = await createDocumentWithContent(
      opts.dbConn,
      opts.eventRepo,
      {
        ownerUserId: opts.userId,
        workspaceId: opts.workspaceId,
        title: doc.title,
        type: "markdown",
        content: doc.content ?? "",
        mimeType: "text/markdown",
        metadata: { [TEMPLATE_DOCUMENT_METADATA_KEY]: { slug: doc.slug } },
        scope: templateDocumentScope(doc.scope, opts.workspaceId),
        provenance: { createdByKind: "system", createdByUserId: opts.userId },
      }
    );
    report.idBySlug[doc.slug] = created.id;
  }
  return report;
}

/**
 * A sidebar item with its `documentId` filled from `documentSlug`, when the
 * space has that document live. Any other item, or an unresolved one, is
 * returned as it is (the slug kept, like an unresolved `viewName`).
 */
export function resolveDocumentSidebarItem<
  T extends { kind?: string; documentSlug?: string; documentId?: string },
>(item: T, idBySlug: Readonly<Record<string, string>>): T {
  if (item.kind !== "document" || item.documentId || !item.documentSlug) {
    return item;
  }
  const id = idBySlug[item.documentSlug];
  return id ? { ...item, documentId: id } : item;
}
