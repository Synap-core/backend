/**
 * The frame's size cap and how a page is measured against it: pure, imports
 * nothing, so the renderables leaf can read it (`renderables.test.ts`).
 */

/** The largest page a host runs: 2 MB (the desktop's `SANDBOXED_PREVIEW_MAX_BYTES`). */
export const CELL_FRAME_MAX_BYTES = 2 * 1024 * 1024;

/** The page's size in bytes, as the cap measures it (UTF-8). */
export function htmlByteLength(html: string): number {
  let bytes = 0;
  for (let i = 0; i < html.length; i += 1) {
    const code = html.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
