/**
 * The agent-facing READ of a document — what an agent needs to make a guarded
 * edit through `applyDocumentPatch`:
 *   - `revision` — pass it back as `baseRevision`;
 *   - `sections[]` — each top-level section's id, owner and heading, so an agent
 *     can `upsert_section` its own and knows which ones are a person's;
 *   - `diagnostics[]` — what will not render (the stored stamp when it describes
 *     this revision, else checked now); `null` + `diagnosticsError` when the
 *     check could not run;
 *   - `format` — `raw` (the stored markdown) or `readable` (every embed replaced
 *     by its markdown fallback: what relay, exports and other agents read).
 */

import { WIDGET_BY_KEY, fallbackFor } from "@synap-core/types/renderables";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  parseSections,
  sectionOwner,
  type SectionOwner,
} from "../session-document/sections.js";
import { readableMarkdown as coreReadableMarkdown } from "@synap-core/markdown-core/readable";
import type { Embed } from "@synap-core/markdown-core/embeds";
import type { LensScope } from "@synap-core/types/lens";
import {
  diagnoseForDocument,
  readStoredDiagnostics,
  storedRunTimeDiagnostics,
  type DiagnosticsOutcome,
} from "./apply-document-patch.js";

export const DOCUMENT_READ_FORMATS = ["raw", "readable"] as const;

/**
 * The longest document a read parses as markdown, in characters. The largest
 * markdown document on the founder's pod was 175 KB (3 Nov 2026).
 */
export const MARKDOWN_READ_MAX_CHARS = 1_000_000;

/**
 * Whether a read may parse this document as markdown (its diagnostics, its
 * readable form, its sections): a `markdown` or `text` document whose type is
 * text (or unset), up to {@link MARKDOWN_READ_MAX_CHARS}. A stored file (a
 * video, an audio, an image, a PDF) and anything longer are never parsed: the
 * parse runs on the request thread, and on 3 Nov 2026 reading a 126 MB video
 * parsed its bytes as markdown for 60-110 s per read, so the pod answered
 * nothing else and its health check restarted it.
 */
export function readsAsMarkdown(
  doc: { type: string; mimeType?: string | null },
  content: string
): boolean {
  if (content.length > MARKDOWN_READ_MAX_CHARS) return false;
  if (doc.type !== "markdown" && doc.type !== "text") return false;
  const mime = doc.mimeType?.trim().toLowerCase() ?? "";
  return mime === "" || mime.startsWith("text/");
}

/**
 * Whether a read may check this document as a stored HTML page (`documents.type
 * = "html"`), up to the same {@link MARKDOWN_READ_MAX_CHARS}. A page is never
 * parsed as markdown: its one check is the frame policy's (`diagnoseHtmlPage`,
 * a scan of its markup for network loads), so the author reads why a page whose
 * code is on a CDN does not run. A stored file holding HTML (`type = "file"`) is
 * a file, not a page.
 */
export function readsAsPage(
  doc: { type: string; mimeType?: string | null },
  content: string
): boolean {
  return doc.type === "html" && content.length <= MARKDOWN_READ_MAX_CHARS;
}

/** The diagnostics of a document a read does not parse: not checked, and why. */
export function unparsedDiagnostics(
  doc: { type: string; mimeType?: string | null },
  content: string
): DiagnosticsOutcome {
  return {
    items: null,
    error:
      content.length > MARKDOWN_READ_MAX_CHARS
        ? `Not checked: the document is longer than ${MARKDOWN_READ_MAX_CHARS} characters.`
        : `Not checked: a ${doc.mimeType?.trim() || doc.type} document is not markdown.`,
  };
}
export type DocumentReadFormat = (typeof DOCUMENT_READ_FORMATS)[number];

export interface DocumentSectionSummary {
  id: string;
  owner: SectionOwner;
  title: string | null;
  author: string | null;
}

/** Every top-level section, in order. A document with no sections has none. */
export function listDocumentSections(
  markdown: string
): DocumentSectionSummary[] {
  const lines = markdown.split("\n");
  return parseSections(markdown).sections.map((s) => {
    const heading = lines
      .slice(s.startLine + 1, s.endLine)
      .find((l) => /^#{1,6}\s/.test(l));
    return {
      id: s.id,
      owner: sectionOwner(s),
      title: heading ? heading.replace(/^#{1,6}\s+/, "").trim() : null,
      author: s.attributes.author ?? null,
    };
  });
}

/**
 * How the pod names an embed that carries no authored fallback in the readable
 * form: the catalog's fallback template for a cell, else the embed's noun. The
 * walk itself is markdown-core's `readableMarkdown` (the one rule).
 */
export function readableEmbedLabel(embed: Embed): string {
  const key = embed.ref.cellKey ?? embed.ref["data-cell-key"];
  const def = key ? WIDGET_BY_KEY[key] : undefined;
  return def ? fallbackFor(def, embed.props) : resolveObjectNoun(embed.kind);
}

/** The pod's readable form of a stored document (agent read + user export). */
export function readableMarkdown(markdown: string): string {
  return coreReadableMarkdown(markdown, readableEmbedLabel);
}

/**
 * Diagnostics for the document at `revision`: the stored stamp if current
 * (this revision, this checker), else checked now as the reader, keeping a
 * stale same-revision stamp's run-time items, which no re-check can derive.
 * Nothing is stored here: re-stamping is the owner's (the reactor's).
 */
export async function currentDiagnostics(args: {
  documentId: string;
  workspaceId: string | null;
  /** `documents.type`: an `html` page is checked as a page, never from a stamp. */
  type?: string | null;
  metadata: unknown;
  revision: number;
  content: string;
  readerUserId: string;
}): Promise<DiagnosticsOutcome> {
  // A page's check is pure and cheap, and no stamp was ever judged as a page
  // (the reactor stamps markdown only), so it is always checked now.
  if (args.type === "html") {
    return diagnoseForDocument(
      args.content,
      { id: args.documentId, workspaceId: args.workspaceId, type: "html" },
      args.readerUserId
    );
  }
  const stored = readStoredDiagnostics(args.metadata, args.revision);
  if (stored) return { items: stored };
  const checked = await diagnoseForDocument(
    args.content,
    { id: args.documentId, workspaceId: args.workspaceId },
    args.readerUserId
  );
  if (!checked.items) return checked;
  return {
    items: [
      ...checked.items,
      ...storedRunTimeDiagnostics(args.metadata, args.revision),
    ],
  };
}

/** The stored row fields the agent projection reads. */
export interface AgentDocumentRow {
  id: string;
  title: string;
  type: string;
  /** The stored file's media type, when it is one (`readsAsMarkdown`). */
  mimeType?: string | null;
  language: string | null;
  workspaceId: string | null;
  contentRevision: number;
  currentVersion: number;
  /** The living document's `LensScope` (0387), or null. */
  scope: LensScope | null;
  /** The automation bound to refresh it (0387, D4), or null. */
  refreshAutomationId: string | null;
  updatedAt: Date | string;
  createdAt: Date | string;
}

/**
 * THE agent-facing document projection (hub `getDocument` → MCP
 * `synap_get_document`, REST GET, IS `get_document`). It used to project away
 * the version and the workspace, so no agent could make a guarded edit; every
 * field an edit needs is here, and the test pins that it arrives.
 */
export function projectAgentDocument(
  doc: AgentDocumentRow,
  raw: string,
  format: DocumentReadFormat,
  diagnostics: DiagnosticsOutcome
) {
  const parsed = readsAsMarkdown(doc, raw);
  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    language: doc.language,
    workspaceId: doc.workspaceId,
    scope: doc.scope ?? null,
    refreshAutomationId: doc.refreshAutomationId ?? null,
    format,
    // A file or an oversized document is never parsed (`readsAsMarkdown`):
    // its content comes back as stored, with no sections.
    content: format === "readable" && parsed ? readableMarkdown(raw) : raw,
    revision: doc.contentRevision,
    version: doc.currentVersion,
    sections: parsed ? listDocumentSections(raw) : [],
    diagnostics: diagnostics.items,
    ...(diagnostics.error ? { diagnosticsError: diagnostics.error } : {}),
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
  };
}
