/**
 * A DOCUMENT on the person's rail (Generative UI plan 9ad4b2fc, P4 "documents
 * as an app", lane 9; founder Q5 + Q6, 3 Nov 2026).
 *
 * A living document (a dashboard, a space's page) is pinned like a goal: one
 * pin in the person's own rail pins (`preferences.railPins`), key
 * `doc:<documentId>`. Only the PERSON pins one (Q6): templates and space
 * admins may suggest, never pin for them. The pod sends document pins only to
 * a client that asks (`includeDocuments: true`, Q5), as it does goal pins, so
 * a shipped build that reads every pin as a kind's surface never meets a pin
 * with no kind.
 *
 * PURE: the pod, the desktop and the phone import the same spelling, so
 * "is this document pinned?" and "unpin it" name the same key everywhere.
 */

/** The rail pin key of a document — THE one spelling (`unpin` / `reorder` take it). */
export function documentRailPinKey(documentId: string): string {
  return `doc:${documentId}`;
}
