/**
 * THE stored shape of a Library item, for tests — one builder, so a change to
 * `importItem` / `importRead` / `importCuration` is one edit here instead of
 * five drifting copies (each suite keeps its own INSERT: their columns differ).
 * Produces `documents.metadata` exactly as the pod stores it.
 */
import type {
  ImportItemMetadata,
  LibraryItemRead,
} from "@synap-core/types/imports";

export interface LibraryItemFixture {
  /** The staged bag's fields over the defaults (a url link, `readable`). */
  item?: Partial<ImportItemMetadata>;
  /** `importRead` as stored (absent = never read). */
  read?: Partial<LibraryItemRead> & Record<string, unknown>;
  /** `importCuration` as stored (absent = none). */
  curation?: Record<string, unknown>;
  /** Any other top-level key (`importMedia`, `importMediaFailures`…). */
  extra?: Record<string, unknown>;
}

/** The item's `documents.metadata` bag. */
export function libraryItemMetadata(
  f: LibraryItemFixture = {}
): Record<string, unknown> {
  const item = {
    version: 1,
    title: "A kept link",
    source: { kind: "url", url: "https://example.com/x" },
    contentStatus: "readable",
    stagedAt: "2026-10-14T08:00:00.000Z",
    ...f.item,
  };
  return {
    importItem: item,
    ...(f.curation ? { importCuration: f.curation } : {}),
    ...(f.read ? { importRead: { suggestedActions: [], ...f.read } } : {}),
    ...f.extra,
  };
}
