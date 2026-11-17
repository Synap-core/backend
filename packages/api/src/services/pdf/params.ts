/**
 * The param contract of each PDF verb (PDF tools W1) — the Zod schemas the
 * handlers parse and `BUILTIN_VERB_PARAM_SCHEMAS` registers. Pure (zod only), so
 * `builtin-verbs.ts` imports them statically without pulling in the engine
 * client.
 *
 * Files are named by plain uuids (`fileId` / `fileIds`), NOT the `file:`
 * parameter dialect: that dialect means "send the file OUTWARD" and files a
 * POD_FILE_OUTWARD proposal. These files never leave the pod: the read floor
 * runs inside the handler (`readableFileEntity`) and the bytes go only to the
 * pod's own internal engine.
 */
import { z } from "zod";

const fileId = z.string().uuid();

/**
 * A Tesseract language code: three letters, optionally a script/variant
 * (`eng`, `deu`, `chi_sim`, `srp_latn`). Checked here so nothing but a code
 * reaches the engine's command line.
 */
export const OCR_LANGUAGE_PATTERN = /^[a-z]{3}(?:_[a-z]{3,4})?$/;

/**
 * Stirling's page selection: `all`, numbers and ranges (`1,3,5-9`) or a
 * function of n (`2n+1`). Anything else is refused before the engine sees it.
 */
export const PAGE_SELECTION_PATTERN = /^(?:all|[0-9n+\-,\s]+)$/i;

export const pdfOcrParams = z
  .object({
    fileId,
    /** Tesseract codes; default ["eng"]. */
    languages: z
      .array(z.string().regex(OCR_LANGUAGE_PATTERN))
      .min(1)
      .max(10)
      .optional(),
    /** skip-text (default): OCR only pages with no text. force-ocr: every page. */
    mode: z.enum(["skip-text", "force-ocr"]).optional(),
  })
  .strict();

export const pdfCompressParams = z
  .object({
    fileId,
    /** 1 (lightest) … 9 (strongest); default 5. */
    level: z.coerce.number().int().min(1).max(9).optional(),
  })
  .strict();

export const pdfMergeParams = z
  .object({
    /** The PDFs to join, in this order. */
    fileIds: z.array(fileId).min(2).max(20),
  })
  .strict();

export const pdfSplitParams = z
  .object({
    fileId,
    /** Where to cut, e.g. "1-3,5": each listed page ends a part. */
    pages: z.string().trim().min(1).max(200).regex(PAGE_SELECTION_PATTERN),
  })
  .strict();

export const pdfRedactParams = z
  .object({
    fileId,
    /** The words (or patterns) to black out; one term per entry, no newlines. */
    terms: z
      .array(
        z
          .string()
          .min(1)
          .max(500)
          .regex(/^[^\r\n]+$/)
      )
      .min(1)
      .max(50),
    useRegex: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
  })
  .strict();

export const pdfToPdfParams = z.object({ fileId }).strict();
export const pdfToMarkdownParams = z.object({ fileId }).strict();
export const pdfInfoParams = z.object({ fileId }).strict();

export const pdfProtectParams = z
  .object({ fileId, password: z.string().min(1).max(256) })
  .strict();
export const pdfUnprotectParams = z
  .object({ fileId, password: z.string().min(1).max(256) })
  .strict();

/** Every PDF verb and its schema, in one table (the runner reads it). */
export const PDF_VERB_PARAMS = {
  "pdf.ocr": pdfOcrParams,
  "pdf.compress": pdfCompressParams,
  "pdf.merge": pdfMergeParams,
  "pdf.split": pdfSplitParams,
  "pdf.redact": pdfRedactParams,
  "pdf.to_pdf": pdfToPdfParams,
  "pdf.to_markdown": pdfToMarkdownParams,
  "pdf.info": pdfInfoParams,
  "pdf.protect": pdfProtectParams,
  "pdf.unprotect": pdfUnprotectParams,
} as const;

export type PdfVerb = keyof typeof PDF_VERB_PARAMS;

/** The verbs that MAKE a new file (everything but the read-only `pdf.info`). */
export type PdfTransformVerb = Exclude<PdfVerb, "pdf.info">;

export type PdfVerbInput<V extends PdfVerb> = z.infer<
  (typeof PDF_VERB_PARAMS)[V]
>;
