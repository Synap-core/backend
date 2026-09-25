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
import { locateEmbeds } from "./patch-ops.js";
import {
  diagnoseForDocument,
  readStoredDiagnostics,
  type DiagnosticsOutcome,
} from "./apply-document-patch.js";

export const DOCUMENT_READ_FORMATS = ["raw", "readable"] as const;
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
 * The readable form: each embed's source replaced by the markdown fallback its
 * author wrote; with none, the catalog's fallback template for a cell, or the
 * embed's noun. Never the raw directive.
 */
export function readableMarkdown(markdown: string): string {
  const embeds = locateEmbeds(markdown);
  let out = "";
  let cursor = 0;
  for (const { embed, start, end, fallbackRange } of embeds) {
    out += markdown.slice(cursor, start);
    if (fallbackRange) {
      out += markdown.slice(fallbackRange.start, fallbackRange.end);
    } else {
      const key = embed.ref.cellKey ?? embed.ref["data-cell-key"];
      const def = key ? WIDGET_BY_KEY[key] : undefined;
      const label = def
        ? fallbackFor(def, embed.props)
        : resolveObjectNoun(embed.kind);
      out += `*${label}*`;
    }
    cursor = end;
  }
  return out + markdown.slice(cursor);
}

/** Diagnostics for the document at `revision`: the stored stamp if current, else checked now. */
export async function currentDiagnostics(args: {
  documentId: string;
  workspaceId: string | null;
  metadata: unknown;
  revision: number;
  content: string;
  readerUserId: string;
}): Promise<DiagnosticsOutcome> {
  const stored = readStoredDiagnostics(args.metadata, args.revision);
  if (stored) return { items: stored };
  return diagnoseForDocument(
    args.content,
    { id: args.documentId, workspaceId: args.workspaceId },
    args.readerUserId
  );
}

/** The stored row fields the agent projection reads. */
export interface AgentDocumentRow {
  id: string;
  title: string;
  type: string;
  language: string | null;
  workspaceId: string | null;
  contentRevision: number;
  currentVersion: number;
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
  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    language: doc.language,
    workspaceId: doc.workspaceId,
    format,
    content: format === "readable" ? readableMarkdown(raw) : raw,
    revision: doc.contentRevision,
    version: doc.currentVersion,
    sections: listDocumentSections(raw),
    diagnostics: diagnostics.items,
    ...(diagnostics.error ? { diagnosticsError: diagnostics.error } : {}),
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
  };
}
