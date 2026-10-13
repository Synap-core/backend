/**
 * Intake routing — THE rule for where something a PERSON brings in goes, and
 * the record of the old intake paths that are going away.
 *
 * Decision: `docs/CAPTURE_LIBRARY_PLAN.md` (founder, 2026-10-13).
 *
 * THE MODEL, IN THREE LINES.
 * - **Capture = the person's words** (typed or dictated — even when the text
 *   holds a URL), read now: the AI files it.
 * - **Library = everything the person brings in** (shared, saved, dropped,
 *   selected-and-saved, forwarded: links, pages, files, photos, shared text),
 *   read cheaply on save, built into structure only when asked.
 * - **A note typed at share time is a Capture**, linked to the Library item.
 *
 * The line is AUTHORSHIP ("did the person write it?"), not CARDINALITY ("one
 * thing vs a batch"). The rule it replaces — "a capture is what you write; an
 * import is a batch you didn't write", which still sent ONE link / ONE photo /
 * ONE file to capture — is retired by the plan above.
 *
 * SCOPE: THE PERSON'S DOORS ONLY. The AI's capture door — MCP `synap_capture`
 * and the Hub REST capture an agent calls with its own key — is OUT OF SCOPE
 * and UNCHANGED (founder, 2026-10-13). An agent may keep sending words, links
 * or files there. It is never routed by {@link routeIntake}, never a
 * {@link DEPRECATED_INTAKE_PATHS} row; it is listed in
 * {@link KEPT_AGENT_INTAKE_DOORS} so nobody mistakes it for a forgotten path.
 *
 * WAVE L1 = NO BEHAVIOUR CHANGE. This module writes the rule and the
 * deprecation record down. No door calls `routeIntake` yet (wave L4 routes the
 * clients); every row below is at stage `marked`.
 *
 * Pure + dependency-free — safe to import from browser (Electron), relay
 * (React Native), CLI, or server contexts (same contract as `./surfaces`).
 */

// ── The routing rule ─────────────────────────────────────────────────────

/** Where a person's input goes. */
export type IntakeRoute = "capture" | "library";

/**
 * What the person handed us, classified by HOW it arrived — never by what the
 * text contains. A typed sentence holding a URL is still `typed`.
 */
export type IntakeInput =
  /** Composer, dictation, omni bar, widget, Siri: the person's own words. */
  | { kind: "typed"; text: string }
  /** A note typed WHILE sharing: a capture, linked to the Library item. */
  | { kind: "share-note"; text: string }
  /** Brought in: shared, saved, dropped, selected-and-saved, forwarded. */
  | {
      kind: "url" | "page" | "file" | "photo" | "selection" | "shared-text";
    };

/** Every {@link IntakeInput} kind. */
export type IntakeInputKind = IntakeInput["kind"];

/**
 * Every input kind, as data (tests and clients iterate it). Coverage floor:
 * a kind added to {@link IntakeInput} and missing here makes `_AllKinds`
 * `never` and the BUILD fails — the list cannot fall behind the union.
 */
export const INTAKE_INPUT_KINDS = [
  "typed",
  "share-note",
  "url",
  "page",
  "file",
  "photo",
  "selection",
  "shared-text",
] as const satisfies readonly IntakeInputKind[];
type _AllKinds =
  Exclude<IntakeInputKind, (typeof INTAKE_INPUT_KINDS)[number]> extends never
    ? true
    : never;
const _allKinds: _AllKinds = true;
void _allKinds;

/**
 * The ONE routing rule for the person's doors. Pure, total, and an exhaustive
 * switch with no `default`: adding an input kind fails the build here until it
 * is routed on purpose.
 *
 * Never called for the agent door (MCP `synap_capture`, Hub capture with an
 * agent key) — see {@link KEPT_AGENT_INTAKE_DOORS}.
 */
export function routeIntake(input: IntakeInput): IntakeRoute {
  switch (input.kind) {
    case "typed":
    case "share-note":
      return "capture";
    case "url":
    case "page":
    case "file":
    case "photo":
    case "selection":
    case "shared-text":
      return "library";
  }
}

// ── The deprecation record ───────────────────────────────────────────────

/**
 * The lifecycle of a deprecated path (`docs/CAPTURE_LIBRARY_PLAN.md` §2):
 * `marked` (registry row + `@deprecated` JSDoc) → `redirected` (clients route
 * to the Library; the pod still accepts and logs) → `refused` (a typed
 * `USE_LIBRARY` error from a person's door, never from an agent key) →
 * `removed` (code deleted; the row moves to {@link REMOVED_INTAKE_PATHS}).
 */
export type IntakeDeprecationStage =
  "marked" | "redirected" | "refused" | "removed";

export type DeprecatedIntakeHost =
  "pod" | "relay" | "browser" | "extension" | "cli";

export interface DeprecatedIntakePath {
  /** Grep-able id, also named verbatim in the `@deprecated` JSDoc at `where`. */
  id: string;
  host: DeprecatedIntakeHost;
  /** ISO date the deprecation was decided. */
  since: string;
  stage: IntakeDeprecationStage;
  /** Why, in plain words, so a reader needs no history. */
  reason: string;
  replacedBy: string;
  removalCriteria: string;
  decisionDoc: string;
  /**
   * `<repo>/<repo-relative path>:<symbol>` of the code site the row is about.
   * Repos are named as in the monorepo root: `synap-backend`, `relay-app`,
   * `browser`, `synap-app`, `synap-cli`.
   */
  where: string;
}

const SINCE = "2026-10-13";
const STAGE: IntakeDeprecationStage = "marked";
const DECISION_DOC = "docs/CAPTURE_LIBRARY_PLAN.md";
const REMOVAL_CRITERIA = "docs/CAPTURE_LIBRARY_PLAN.md §2";
const AGENT_KEPT =
  " The agent path (MCP synap_capture / Hub capture with an agent key) is kept — founder 2026-10-13.";
const LIBRARY = "the Library (import.stage today; library.add from wave L2)";

const BASE = {
  since: SINCE,
  stage: STAGE,
  removalCriteria: REMOVAL_CRITERIA,
  decisionDoc: DECISION_DOC,
} as const;

/**
 * Every path where NON-TYPED content (a URL, an HTML page, a file, a photo)
 * enters through Capture from a PERSON's door. Add rows; never delete one —
 * a removed path moves to {@link REMOVED_INTAKE_PATHS} with its commit, so
 * anyone grepping the old id still finds why.
 *
 * Never a row for the agent door: see {@link KEPT_AGENT_INTAKE_DOORS}.
 */
export const DEPRECATED_INTAKE_PATHS: readonly DeprecatedIntakePath[] = [
  // ── pod ───────────────────────────────────────────────────────────────
  {
    ...BASE,
    id: "capture.url",
    host: "pod",
    reason:
      "Capture is your words, read now. A link is material you bring in: it belongs to the Library (read cheaply, searchable, built on request)." +
      AGENT_KEPT,
    replacedBy: LIBRARY,
    where: "synap-backend/packages/api/src/routers/capture.ts:structure",
  },
  {
    ...BASE,
    id: "capture.file",
    host: "pod",
    reason:
      "A file or photo is material you bring in, not your words. Through Capture every file spent AI on arrival, even ones never looked at again; the Library keeps it, reads it cheaply and builds on request." +
      AGENT_KEPT,
    replacedBy: LIBRARY,
    where: "synap-backend/packages/api/src/routers/capture.ts:keepRaw",
  },
  {
    ...BASE,
    id: "capture.html",
    host: "pod",
    reason:
      "A saved page's HTML is material you bring in. It belongs to the Library, where the page is read on save and kept searchable." +
      AGENT_KEPT,
    replacedBy: LIBRARY,
    where: "synap-backend/packages/api/src/routers/capture.ts:html",
  },
  {
    ...BASE,
    id: "capture.vision",
    host: "pod",
    reason:
      "The vision lane exists for photos sent through Capture, which were often silently unread. Photos belong to the Library, whose light read (OCR) and Build take over the vision lane and the pod vision preference." +
      AGENT_KEPT,
    replacedBy:
      "the Library light read and Build (vision lane + pod vision preference re-homed, wave L2)",
    where: "synap-backend/packages/api/src/routers/capture.ts:visionModelId",
  },
  {
    ...BASE,
    id: "capture.linkReader",
    host: "pod",
    reason:
      "The link reader bolted onto Capture reads a lone URL a person sent as a capture. A link a person brings in belongs to the Library, which reads it with the same reader (readPublicUrl) on save." +
      AGENT_KEPT,
    replacedBy: `${LIBRARY}; read-public-url stays for Stage and Build`,
    where: "synap-backend/packages/api/src/routers/capture.ts:publicUrlReader",
  },
  {
    ...BASE,
    id: "capture.thought.url",
    host: "pod",
    reason:
      "The legacy single-entity thought capture still takes a source URL. Your words stay a capture; the link you bring belongs to the Library." +
      AGENT_KEPT,
    replacedBy: LIBRARY,
    where: "synap-backend/packages/api/src/routers/capture.ts:thought",
  },

  // ── relay ─────────────────────────────────────────────────────────────
  {
    ...BASE,
    // Relay routes this to the Library now (wave L4, FE-3).
    stage: "redirected",
    id: "relay.note.attachments",
    host: "relay",
    reason:
      "The note screen attaches a photo, camera shot or file to a capture. The note is your words; what you attach is material you bring in and belongs to the Library (a note typed with it stays a capture, linked).",
    replacedBy: `${LIBRARY}, with the note as a linked capture (wave L4)`,
    where: "relay-app/src/lib/capture-file.ts:validateCaptureFile",
  },
  {
    ...BASE,
    // Relay routes this to the Library now (wave L4, FE-3).
    stage: "redirected",
    id: "relay.captureUrlHint",
    host: "relay",
    reason:
      "A lone shared link opens a capture with a 'prefer bookmark' hint. A shared link is material you bring in: it belongs to the Library.",
    replacedBy: `${LIBRARY} (wave L4)`,
    where: "relay-app/src/lib/captureBus.ts:captureUrlHint",
  },

  // ── browser ───────────────────────────────────────────────────────────
  {
    ...BASE,
    // The browser routes this to the Library now (wave L4, FE-2).
    stage: "redirected",
    id: "browser.saveLink.capture",
    host: "browser",
    reason:
      "Save page/link sends the URL and its HTML to Capture. A saved page is material you bring in: it belongs to the Library, with Read now for the urgent ones.",
    replacedBy: `${LIBRARY}, Add to Library + Read now (wave L4)`,
    where:
      "browser/electron/renderer/src/components/browser/SavePopover.tsx:SavePopover",
  },
  {
    ...BASE,
    // The browser routes this to the Library now (wave L4, FE-2).
    stage: "redirected",
    id: "browser.smartCapture",
    host: "browser",
    reason:
      "Right-click Smart capture sends a selection or page to Capture. Selected-and-saved text is material you bring in, not your words: it belongs to the Library.",
    replacedBy: `${LIBRARY}, one Add to Library entry (wave L4)`,
    where:
      "browser/electron/renderer/src/components/browser/ContextCaptureMenu.tsx:ContextCaptureMenu",
  },
  {
    ...BASE,
    id: "browser.quickCapture.file",
    host: "browser",
    reason:
      "Quick capture (⌘N) also takes a file or a lone link. Quick capture stays for your words; a file or link you bring belongs to the Library.",
    replacedBy: `${LIBRARY} (wave L4)`,
    where:
      "browser/electron/renderer/src/components/modals/QuickCaptureModal.tsx:QuickCaptureModal",
  },

  // ── extension ─────────────────────────────────────────────────────────
  {
    ...BASE,
    id: "extension.savePage.capture",
    host: "extension",
    reason:
      "The extension saves the current page through Capture. A saved page is material you bring in: it belongs to the Library.",
    replacedBy: "the Library Hub door /library/add (wave L4)",
    where: "synap-app/apps/extension/src/shared/api/hub.ts:hubCaptureStructure",
  },
  {
    ...BASE,
    id: "extension.tabScan",
    host: "extension",
    reason:
      "Tab scan writes one entity per open tab, outside both Capture and the Library. A set of tabs is material you bring in: it belongs to the Library, where it is grouped and built on request.",
    replacedBy: "the Library Hub door /library/add (wave L4)",
    where:
      "synap-app/apps/extension/src/background/message-handler.ts:SCAN_TABS",
  },

  // ── cli ───────────────────────────────────────────────────────────────
  {
    ...BASE,
    id: "cli.capture.url",
    host: "cli",
    reason:
      "`synap capture --url/--file` (and Raycast) send a link or file to Capture through the Hub REST client. Your typed text stays a capture; a link or file you bring belongs to the Library." +
      AGENT_KEPT,
    replacedBy: "the Library Hub door /library/add (wave L4)",
    // The CLI source is not in this repo; its door into the pod is this
    // client's input type, which `synap capture` and Raycast send.
    where:
      "synap-backend/packages/hub-rest-client/src/types.ts:CaptureStructureInput",
  },
];

/** Rows that reached stage `removed`, with the commit that removed them. Empty today. */
export const REMOVED_INTAKE_PATHS: readonly (DeprecatedIntakePath & {
  removedIn: string;
})[] = [];

/**
 * The agent door, KEPT by founder decision 2026-10-13 — never a deprecation
 * row, never routed by {@link routeIntake}, and still open at stages
 * `refused` and `removed` (those apply to the person's doors only). An agent
 * may keep sending words, links or files here; they are processed as today.
 */
export const KEPT_AGENT_INTAKE_DOORS: readonly {
  id: string;
  where: string;
  why: string;
}[] = [
  {
    id: "mcp.synap_capture",
    where:
      "synap-backend/packages/api/src/routers/mcp/tools/index.ts:synap_capture",
    why: "The AI's capture door. Out of scope and unchanged (founder, 2026-10-13): an agent's words, links and files go there exactly as today.",
  },
  {
    id: "hub.capture.structure",
    where:
      "synap-backend/packages/api/src/routers/hub-protocol/rest/capture.ts:/capture/structure",
    why: "Hub REST capture called with an AGENT key: kept as the agent path. Only a person's use of url/file/html here is deprecated (rows capture.url, capture.file, capture.html).",
  },
  {
    id: "hub.capture.graph",
    where:
      "synap-backend/packages/api/src/routers/hub-protocol/rest/capture.ts:/capture/graph",
    why: "The structured graph door agents and bridges file into. It carries no unread material and is kept.",
  },
];

/** The row for an id, or undefined. */
export function findDeprecatedIntakePath(
  id: string
): DeprecatedIntakePath | undefined {
  return DEPRECATED_INTAKE_PATHS.find((p) => p.id === id);
}
