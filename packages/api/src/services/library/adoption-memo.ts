/**
 * Which people have NO per-import group left to adopt, in this process — so a
 * Library read does not scan `focus_sessions` every time. Any write of an
 * import session's curation (`writeImportCuration`, the one writer) marks the
 * person dirty again; a fresh process starts dirty (one scan per person).
 */
const clean = new Set<string>();

export function isAdoptionClean(userId: string): boolean {
  return clean.has(userId);
}

export function markAdoptionClean(userId: string): void {
  clean.add(userId);
}

export function markAdoptionDirty(userId: string): void {
  clean.delete(userId);
}
