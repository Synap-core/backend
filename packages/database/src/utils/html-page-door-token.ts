/**
 * The mark the HTML page door (`html-page.ts`) puts on the input it hands to
 * `createDocumentWithContent`. That create door refuses an html body without
 * it, so an HTML page is written ONLY through `createHtmlPage`, with its
 * checks (size cap, declared reads).
 *
 * Not exported from the package (`index.ts` does not re-export this module,
 * and `package.json` `exports` opens no deep path): only modules of
 * `@synap/database` can import it. Tripwire `html-page-one-door` pins which
 * ones do (the door and the create door, nothing else).
 */
import {
  CELL_FRAME_MAX_BYTES,
  htmlByteLength,
} from "@synap-core/types/cell-bridge";

export const HTML_PAGE_DOOR_MARK: unique symbol = Symbol("html-page-door");

/**
 * The size refusal of an HTML page, or null when it fits: the ONE sentence
 * the create door (`checkHtmlPage`) and every edit (`claimDocumentRevision`)
 * refuse with. At most `CELL_FRAME_MAX_BYTES` (2 MB), the size a host runs.
 */
export function htmlPageSizeRefusal(content: string | Buffer): string | null {
  const bytes = Buffer.isBuffer(content)
    ? content.byteLength
    : htmlByteLength(content);
  return bytes > CELL_FRAME_MAX_BYTES
    ? `This HTML page is ${bytes} bytes; a page is at most ${CELL_FRAME_MAX_BYTES} bytes (2 MB), the size a host runs. Make it smaller (inline less, or split it into several pages).`
    : null;
}

/** Is this create input an HTML page body (the shape only the door writes)? */
export function isHtmlPageBody(input: {
  type?: string | null;
  mimeType?: string | null;
}): boolean {
  return (
    input.type === "html" ||
    (typeof input.mimeType === "string" &&
      input.mimeType.toLowerCase().startsWith("text/html"))
  );
}
