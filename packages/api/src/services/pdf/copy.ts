/**
 * The words the PDF verbs write (PDF tools W1), waiting here for the catalog
 * door (i18n rule: a folder's new words live in its `copy.ts`). English is the
 * source; the strict ICU subset of `@synap-core/types/i18n` formats them.
 *
 * Two kinds of words:
 *  - the TITLE of each new file, derived from its source's title. Synap writes
 *    the suffix; the source title is the person's content and is never changed;
 *  - the REFUSAL sentences an agent (or the approval screen) reads when a verb
 *    did not run. Each names what to do next.
 *
 * Titles are formatted in English today: the verbs have no recipient locale yet
 * (agents receive the locale as a fact, i18n §8: not built).
 */
import { formatMessage, type ParamValue } from "@synap-core/types/i18n";

export const PDF_COPY_EN = {
  "pdf.title.ocr": "{source} (OCR)",
  "pdf.title.compress": "{source} (compressed)",
  "pdf.title.merge": "{source} (merged)",
  "pdf.title.split": "{source} (pages {pages})",
  "pdf.title.redact": "{source} (redacted)",
  "pdf.title.to_pdf": "{source} (PDF)",
  "pdf.title.to_markdown": "{source} (Markdown)",
  "pdf.title.protect": "{source} (protected)",
  "pdf.title.unprotect": "{source} (unprotected)",

  "pdf.untitled_source": "Untitled file",

  "pdf.note.split_zip":
    "The pages come back as one ZIP of PDF files, stored as one file.",

  "pdf.expected.pdf": "a PDF",
  "pdf.expected.pdf_or_zip": "a PDF or a ZIP of PDFs",
  "pdf.expected.markdown": "Markdown text",
  "pdf.expected.json": "a JSON report",

  "pdf.refusal.engine_off":
    "The PDF engine is off on this pod, so nothing ran. A pod admin turns it on (the stirling-pdf service, STIRLING_URL).",
  "pdf.refusal.engine_down":
    "The PDF engine is not answering right now, so nothing was made. Try again in a few minutes.",
  "pdf.refusal.engine_timeout":
    "The PDF engine took longer than {minutes} minutes, so the run was stopped and nothing was made.",
  "pdf.refusal.engine_refused": "The PDF engine refused the file: {detail}",
  "pdf.refusal.bad_output":
    "The PDF engine answered with something that is not {expected}, so nothing was stored.",
  "pdf.refusal.result_too_large":
    "The result is over {mb} MB, more than this pod keeps from the PDF engine, so nothing was stored.",
  "pdf.refusal.file_not_found": "The file {fileId} was not found.",
  "pdf.refusal.file_not_readable": "The file {fileId} is not one you can read.",
  "pdf.refusal.file_no_bytes":
    "The file {fileId} has no stored bytes to work on.",
  "pdf.refusal.file_too_large":
    "“{file}” is over {mb} MB, more than the PDF engine takes, so nothing was sent.",
  "pdf.refusal.not_a_pdf":
    "“{file}” is not a PDF ({mime}). Turn it into one first with pdf.to_pdf.",
  "pdf.refusal.unsupported_type":
    "“{file}” ({mime}) is not a file pdf.to_pdf can turn into a PDF: it takes an Office document, an image, HTML or Markdown.",
  "pdf.refusal.no_space":
    "There is no space to file the new file in: run the verb in a space (workspaceId).",
} as const;

export type PdfCopyKey = keyof typeof PDF_COPY_EN;

/** Format one message in English (the only locale the verbs speak today). */
export function pdfText(
  key: PdfCopyKey,
  params?: Readonly<Record<string, ParamValue>>
): string {
  return formatMessage(PDF_COPY_EN[key], params, "en");
}
