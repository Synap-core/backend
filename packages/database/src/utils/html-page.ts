/**
 * THE HTML PAGE DOOR (founder decision, 27 Nov 2026, session 53d7cbed): every
 * HTML page Synap stores is written here, whoever asks for it — a document
 * (`synap_create_document {type: "html"}`, Hub `POST /documents`, the app's
 * `documents.create` / `upload`), an HTML surface (`synap_create_surface`
 * body html), the approval of any of those, or an html-embed cell (Hub
 * `POST /cell-instances/html`, tRPC `cellInstances.createHtmlCell`, the
 * whiteboard place door). The html-embed cell is only a PLACEMENT that points
 * at the page this door wrote; it holds no copy of the content.
 *
 * What a page gets here, and nowhere else:
 *   - the checks (`checkHtmlPage`): at most `HTML_PAGE_MAX_BYTES` (a larger
 *     page never runs in a host's frame), and its declared `reads` inside the
 *     frame-read ceiling (`parseDeclaredReads`);
 *   - the stored shape: `documents.type = "html"`, mime `text/html`, the
 *     checked reads on `metadata.reads` (what the frame read door enforces),
 *     through the ONE create door (`createDocumentWithContent`: fresh key, row,
 *     v1 checkpoint, `document.create.completed`, which the after-save reactor
 *     hears to stamp the page's diagnostics and block manifest).
 *
 * Callers check BEFORE governance (so a refused page is never filed as a
 * proposal) and the write checks again (an approval writes only what the door
 * accepts today). The advisory warnings (network loads) are the API layer's
 * (`diagnoseHtmlPage`); they never refuse.
 *
 * `createDocumentWithContent` refuses an html body that did not come through
 * here (the door's mark, `html-page-door-token.ts`).
 */

import {
  CELL_FRAME_MAX_BYTES,
  parseDeclaredReads,
  type CellBridgeDeclaredReads,
} from "@synap-core/types/cell-bridge";
import type { EventRepository } from "../repositories/event-repository.js";
import {
  createDocumentWithContent,
  type CreateDocumentWithContentInput,
  type CreatedDocument,
} from "./claim-document-revision.js";
import {
  HTML_PAGE_DOOR_MARK,
  htmlPageSizeRefusal,
  isHtmlPageBody,
} from "./html-page-door-token.js";

export { htmlPageSizeRefusal, isHtmlPageBody };

/** The largest page the door stores: the size a host's frame runs (2 MB). */
export const HTML_PAGE_MAX_BYTES = CELL_FRAME_MAX_BYTES;

export type HtmlPageCheck =
  | {
      ok: true;
      /** The declared reads, checked; null = the page declares none. */
      reads: CellBridgeDeclaredReads | null;
    }
  | {
      ok: false;
      /** What was refused: the page itself, or its declared reads. */
      field: "content" | "reads";
      error: string;
    };

/**
 * The door's checks, pure: the size cap, then the declared reads. `reads`
 * absent or null = undeclared (the page reads nothing).
 */
export function checkHtmlPage(input: {
  content: string;
  reads?: unknown;
}): HtmlPageCheck {
  const tooLarge = htmlPageSizeRefusal(input.content ?? "");
  if (tooLarge) return { ok: false, field: "content", error: tooLarge };
  if (input.reads === undefined || input.reads === null) {
    return { ok: true, reads: null };
  }
  const parsed = parseDeclaredReads(input.reads);
  return parsed.ok
    ? { ok: true, reads: parsed.value }
    : { ok: false, field: "reads", error: parsed.error };
}

/** A page the door refused; `message` says why and what to do. */
export class HtmlPageRefusal extends Error {
  readonly code = "BAD_REQUEST" as const;
  constructor(message: string) {
    super(message);
    this.name = "HtmlPageRefusal";
  }
}

export type CreateHtmlPageInput = Omit<
  CreateDocumentWithContentInput,
  "type" | "mimeType" | "extension" | "language" | "verbatim"
> & {
  /** The page's declared reads (checked here); absent/null = undeclared. */
  reads?: unknown;
};

/**
 * Write an HTML page: check it, then create it through the ONE create door as
 * `type: "html"`, `text/html`, its checked reads on `metadata.reads`. Throws
 * `HtmlPageRefusal` (nothing written) when the page fails a check.
 */
export async function createHtmlPage(
  dbOrTx: any,
  eventRepo: EventRepository,
  input: CreateHtmlPageInput
): Promise<CreatedDocument> {
  const { reads: rawReads, ...rest } = input;
  const checked = checkHtmlPage({ content: rest.content, reads: rawReads });
  if (!checked.ok) throw new HtmlPageRefusal(checked.error);
  // A `reads` key a caller left in `metadata` is never trusted: only the
  // checked declaration is stored.
  const { reads: _ignored, ...metadata } = (rest.metadata ?? {}) as Record<
    string,
    unknown
  >;
  void _ignored;
  return createDocumentWithContent(dbOrTx, eventRepo, {
    ...rest,
    type: "html",
    mimeType: "text/html",
    extension: "html",
    metadata: {
      ...metadata,
      ...(checked.reads ? { reads: checked.reads } : {}),
    },
    [HTML_PAGE_DOOR_MARK]: true,
  } as CreateDocumentWithContentInput);
}
