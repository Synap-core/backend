/**
 * The HTML page door's check, as every create door runs it BEFORE governance
 * (so a refused page is never filed as a proposal): the database door's
 * refusals (`checkHtmlPage`: the size cap, the declared reads) plus its
 * advisory warnings (`diagnoseHtmlPage`: what will not run in a frame, said
 * on the receipt, never a refusal).
 *
 * Callers: the Hub `documents.createDocument` door (MCP `synap_create_document`,
 * Hub REST `POST /documents`, and the html-embed cell routes through it), the
 * surface door (`synap_create_surface` body html), the app's
 * `documents.create` / `upload` and `cellInstances.createHtmlCell`, and the
 * whiteboard place door's html resources. The write itself is
 * `createHtmlPage` (`@synap/database`), which checks again.
 */

import { TRPCError } from "@trpc/server";
import { checkHtmlPage } from "@synap/database";
import type { CellBridgeDeclaredReads } from "@synap-core/types/cell-bridge";
import { diagnoseHtmlPage } from "./document-diagnostics.js";

export type HtmlPageVerdict =
  | {
      ok: true;
      reads: CellBridgeDeclaredReads | null;
      /** One sentence (and its fix) per thing that will not run. */
      warnings: string[];
    }
  | { ok: false; error: string };

export function readHtmlPage(input: {
  content: string;
  reads?: unknown;
}): HtmlPageVerdict {
  const checked = checkHtmlPage(input);
  if (!checked.ok) return checked;
  return {
    ok: true,
    reads: checked.reads,
    warnings: diagnoseHtmlPage(input.content ?? "").map(
      (d) => `${d.message} ${d.fix}`
    ),
  };
}

/** `readHtmlPage`, a refusal thrown as BAD_REQUEST (nothing filed or written). */
export function assertHtmlPage(input: {
  content: string;
  reads?: unknown;
}): Extract<HtmlPageVerdict, { ok: true }> {
  const verdict = readHtmlPage(input);
  if (!verdict.ok) {
    throw new TRPCError({ code: "BAD_REQUEST", message: verdict.error });
  }
  return verdict;
}
