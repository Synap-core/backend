/**
 * The pod's client for its internal PDF engine, Stirling PDF (PDF tools W1).
 *
 * WHAT IT TALKS TO: Stirling's MIT core build, run by the pod in a Compose
 * profile and reached only by the backend at `STIRLING_URL`
 * (`engine-config.ts`). That build has no auth, so no key header is sent.
 * Endpoints and form fields were read from Stirling-PDF's source on
 * 2026-11-17 (`app/core/.../controller/api/**`, `model/api/**`); the pinned
 * image must expose the same ones.
 *
 * WHY PLAIN `fetch`, NOT `safePublicFetch`: the pinned public-fetch door
 * refuses private addresses by design, and the engine IS a private address on
 * the Compose network. The base URL comes ONLY from the operator's env; a
 * verb's params pick an endpoint from the fixed table below, never a URL. The
 * request body is the streamed multipart body of `encodeProviderFileBody`
 * (`duplex: "half"`), so a 100 MB input is never held whole in memory; the
 * timeout is an `AbortSignal`, and `fetch` is the test seam.
 *
 * THE RESULT IS BUFFERED, capped at {@link STIRLING_RESPONSE_MAX_BYTES}: the
 * governed file door (`createGovernedFileEntityFromBuffer`) takes a Buffer. A
 * streaming adopt path (engine → storage without holding the bytes) is out of
 * scope for W1.
 *
 * Every failure is a typed `VerbRefusal` (nothing ran, here is why): engine
 * off, engine down or slow (transient), the engine refused the file
 * (provider), a file gone from storage (target_missing), too large
 * (validation).
 */
import type { IFileStorage } from "@synap/storage";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  encodeProviderFileBody,
  MULTIPART_FILE_MAX_BYTES,
  ProviderFileBodyError,
  type ProviderFileRef,
} from "../../connectors/provider-file-body.js";
import { VerbRefusal } from "../capabilities/verb-refusal.js";
import { pdfText, type PdfCopyKey } from "./copy.js";
import { stirlingBaseUrl } from "./engine-config.js";
import type { PdfVerb, PdfVerbInput } from "./params.js";

const MB = 1024 * 1024;

/** The largest input file the engine is sent (the multipart part cap). */
export const PDF_INPUT_MAX_BYTES = MULTIPART_FILE_MAX_BYTES;
/** The largest result the pod buffers from the engine. */
export const STIRLING_RESPONSE_MAX_BYTES = 50 * MB;
/** OCR rasterises and reads every page: minutes on a long scan. */
export const OCR_TIMEOUT_MS = 10 * 60_000;
/** Every other call. */
export const DEFAULT_TIMEOUT_MS = 3 * 60_000;
/** The health probe. */
export const PROBE_TIMEOUT_MS = 3_000;

/** Refusal codes (also in each sentence, as `[CODE]`: see `refuse`). */
export const PDF_REFUSAL_CODES = {
  engineOff: "PDF_ENGINE_OFF",
  engineDown: "PDF_ENGINE_DOWN",
  engineTimeout: "PDF_ENGINE_TIMEOUT",
  engineRefused: "PDF_ENGINE_REFUSED",
  badOutput: "PDF_ENGINE_BAD_OUTPUT",
  resultTooLarge: "RESULT_TOO_LARGE",
  fileNotFound: "FILE_NOT_FOUND",
  fileNotReadable: "FILE_NOT_READABLE",
  fileNoBytes: "FILE_NO_BYTES",
  fileTooLarge: "FILE_TOO_LARGE",
  storageUnreadable: "STORAGE_UNREADABLE",
  notAPdf: "NOT_A_PDF",
  unsupportedType: "UNSUPPORTED_TYPE",
  noSpace: "PDF_NO_SPACE",
} as const;

/**
 * A refusal whose sentence also carries its code. The capability result drops
 * `VerbRefusal.code` today (only `message` + `errorClass` cross
 * `execute-capability.ts`), so the code rides in the words where an agent can
 * read it; `.code` stays set for any caller that does read it.
 */
export function refuse(
  message: string,
  errorClass: ConstructorParameters<typeof VerbRefusal>[1],
  code: string
): VerbRefusal {
  return new VerbRefusal(`${message} [${code}]`, errorClass, code);
}

/**
 * Engine off. Class `provider` ("the other service did not do it"), never
 * `no_connection`: that class makes `execute-capability` attach a CONNECT link
 * to an account card, and there is no account to connect — a pod admin turns
 * the engine on. `transient` would invite a retry that cannot succeed.
 */
export function engineOffRefusal(): VerbRefusal {
  return refuse(
    pdfText("pdf.refusal.engine_off"),
    "provider",
    PDF_REFUSAL_CODES.engineOff
  );
}

export function engineDownRefusal(): VerbRefusal {
  return refuse(
    pdfText("pdf.refusal.engine_down"),
    "transient",
    PDF_REFUSAL_CODES.engineDown
  );
}

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export interface StirlingDeps {
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Defaults to the pod's storage (`@synap/storage`). */
  storage?: Pick<IFileStorage, "downloadStream">;
}

export type PdfEngineState = "off" | "ok" | "down";

/**
 * Is the engine there? `off` = not configured (not a fault); `ok` = its status
 * endpoint says UP; `down` = configured but not answering UP within
 * {@link PROBE_TIMEOUT_MS}. A failed probe IS the answer `down`.
 */
export async function probePdfEngine(
  deps: Pick<StirlingDeps, "fetch"> = {}
): Promise<PdfEngineState> {
  const base = stirlingBaseUrl();
  if (!base) return "off";
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${base}/api/v1/info/status`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return "down";
    const text = await res.text();
    return text.includes("UP") ? "ok" : "down";
  } catch {
    return "down";
  }
}

/** What the engine is expected to answer with. */
export type PdfOutputKind = "pdf" | "pdf-or-zip" | "markdown" | "json";

export interface StirlingCallSpec {
  /** The engine path, from the fixed table below. */
  path: string;
  fields: Record<string, string | readonly string[]>;
  timeoutMs: number;
  output: PdfOutputKind;
}

// ── pdf.to_pdf: which endpoint takes which file ─────────────────────────────
//
// Stirling picks its converter by the uploaded FILENAME's extension (it refuses
// `/html/pdf` for a name not ending in .html, `/markdown/pdf` for one not
// ending in .md, and LibreOffice reads the extension), so the route also names
// the extension the part is sent with. Anything not listed is a typed refusal.

const OFFICE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/csv": "csv",
  "text/plain": "txt",
};

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

export interface ToPdfRoute {
  path: string;
  /** The extension the file part is named with. */
  extension: string;
  fields: Record<string, string>;
}

/** The engine route that turns a file of this type into a PDF, or null. */
export function toPdfRouteFor(mimeType: string | null): ToPdfRoute | null {
  const mime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (OFFICE_EXTENSIONS[mime]) {
    return {
      path: "/api/v1/convert/file/pdf",
      extension: OFFICE_EXTENSIONS[mime]!,
      fields: {},
    };
  }
  if (IMAGE_EXTENSIONS[mime]) {
    return {
      path: "/api/v1/convert/img/pdf",
      extension: IMAGE_EXTENSIONS[mime]!,
      // One page per image, the page fitted to it; colour kept.
      fields: {
        fitOption: "fitDocumentToImage",
        colorType: "color",
        autoRotate: "false",
      },
    };
  }
  if (mime === "text/html") {
    return { path: "/api/v1/convert/html/pdf", extension: "html", fields: {} };
  }
  if (mime === "text/markdown" || mime === "text/x-markdown") {
    return {
      path: "/api/v1/convert/markdown/pdf",
      extension: "md",
      fields: {},
    };
  }
  return null;
}

/**
 * The engine call for a verb. `toPdf` is the route `toPdfRouteFor` chose (the
 * runner refuses before this when there is none).
 */
export function stirlingCallFor<V extends PdfVerb>(
  verb: V,
  input: PdfVerbInput<V>,
  toPdf?: ToPdfRoute
): StirlingCallSpec {
  const std = (
    path: string,
    fields: StirlingCallSpec["fields"] = {},
    output: PdfOutputKind = "pdf"
  ): StirlingCallSpec => ({
    path,
    fields,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output,
  });
  switch (verb) {
    case "pdf.ocr": {
      const i = input as PdfVerbInput<"pdf.ocr">;
      return {
        path: "/api/v1/misc/ocr-pdf",
        fields: {
          languages: i.languages ?? ["eng"],
          ocrType: i.mode ?? "skip-text",
          // sandwich = the original page image with an invisible text layer.
          ocrRenderType: "sandwich",
        },
        timeoutMs: OCR_TIMEOUT_MS,
        output: "pdf",
      };
    }
    case "pdf.compress": {
      const i = input as PdfVerbInput<"pdf.compress">;
      return std("/api/v1/misc/compress-pdf", {
        optimizeLevel: String(i.level ?? 5),
      });
    }
    case "pdf.merge":
      return std("/api/v1/general/merge-pdfs", { sortType: "orderProvided" });
    case "pdf.split": {
      const i = input as PdfVerbInput<"pdf.split">;
      return std(
        "/api/v1/general/split-pages",
        { pageNumbers: i.pages },
        "pdf-or-zip"
      );
    }
    case "pdf.redact": {
      const i = input as PdfVerbInput<"pdf.redact">;
      return std("/api/v1/security/auto-redact", {
        listOfText: i.terms.join("\n"),
        useRegex: String(i.useRegex ?? false),
        wholeWordSearch: String(i.wholeWord ?? false),
        // Rasterise the pages: a black box over text that is still in the
        // file is not a redaction.
        convertPDFToImage: "true",
      });
    }
    case "pdf.to_pdf":
      if (!toPdf) throw new Error("pdf.to_pdf needs its route");
      return std(toPdf.path, toPdf.fields);
    case "pdf.to_markdown":
      return std("/api/v1/convert/pdf/markdown", {}, "markdown");
    case "pdf.info":
      return std("/api/v1/security/get-info-on-pdf", {}, "json");
  }
  throw new Error(`No engine call for ${String(verb)}`);
}

export interface StirlingResult {
  bytes: Buffer;
  /** The type the bytes ARE (sniffed), not what a header claimed. */
  mimeType: string;
}

/**
 * POST the files (each under `fileInput`, in order) and the fields to one
 * engine endpoint; return the result bytes, or throw a `VerbRefusal`.
 */
export async function callStirling(
  spec: StirlingCallSpec,
  files: readonly ProviderFileRef[],
  deps: StirlingDeps = {}
): Promise<StirlingResult> {
  const base = stirlingBaseUrl();
  if (!base) throw engineOffRefusal();

  let encoded;
  try {
    encoded = await encodeProviderFileBody(
      {
        encoding: "multipart",
        fields: spec.fields,
        files: files.map((file) => ({ field: "fileInput", file })),
      },
      deps.storage ? { storage: deps.storage } : {}
    );
  } catch (err) {
    throw fileBodyRefusal(err);
  }

  const doFetch = deps.fetch ?? fetch;
  const signal = AbortSignal.timeout(spec.timeoutMs);
  let res: Response;
  try {
    res = await doFetch(`${base}${spec.path}`, {
      method: "POST",
      headers: { "content-type": encoded.contentType },
      body: (typeof encoded.body === "string"
        ? encoded.body
        : NodeReadableStream.from(encoded.body)) as unknown as BodyInit,
      // A streamed request body needs half-duplex (undici); DOM's RequestInit
      // does not declare it.
      duplex: "half",
      signal,
      redirect: "error",
    } as RequestInit);
  } catch (err) {
    // A streamed file part that failed (gone, over its cap) aborted the
    // request: name the file, not "the engine was unreachable".
    const failed = encoded.failure();
    if (failed) throw fileBodyRefusal(failed);
    throw transportRefusal(err, spec.timeoutMs);
  }

  if (res.status >= 500) {
    await res.body?.cancel().catch(() => undefined);
    throw engineDownRefusal();
  }
  if (!res.ok) {
    throw refuse(
      pdfText("pdf.refusal.engine_refused", {
        detail: await engineErrorDetail(res),
      }),
      "provider",
      PDF_REFUSAL_CODES.engineRefused
    );
  }

  const bytes = await readCapped(res, spec.timeoutMs);
  return { bytes, mimeType: sniffOutput(bytes, spec.output) };
}

function transportRefusal(err: unknown, timeoutMs: number): VerbRefusal {
  if ((err as { name?: unknown } | null)?.name === "TimeoutError") {
    return refuse(
      pdfText("pdf.refusal.engine_timeout", {
        minutes: Math.round(timeoutMs / 60_000),
      }),
      "transient",
      PDF_REFUSAL_CODES.engineTimeout
    );
  }
  return engineDownRefusal();
}

/** Map the encoder's typed file failures; anything else is our bug: rethrow. */
function fileBodyRefusal(err: unknown): unknown {
  if (!(err instanceof ProviderFileBodyError)) return err;
  switch (err.code) {
    case "file_not_found":
      return refuse(
        err.message,
        "target_missing",
        PDF_REFUSAL_CODES.fileNotFound
      );
    case "file_too_large":
      return refuse(err.message, "validation", PDF_REFUSAL_CODES.fileTooLarge);
    case "file_unreadable":
      return refuse(
        err.message,
        "transient",
        PDF_REFUSAL_CODES.storageUnreadable
      );
    default:
      return err;
  }
}

/** A short reason out of the engine's error body (Spring problem JSON or text). */
async function engineErrorDetail(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 2000);
  } catch {
    return `HTTP ${res.status}`;
  }
  let detail = text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pick = [
      parsed.detail,
      parsed.message,
      parsed.error,
      parsed.title,
    ].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (pick) detail = pick;
  } catch {
    // Not JSON: the text itself.
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return detail ? `${detail} (HTTP ${res.status})` : `HTTP ${res.status}`;
}

function tooLargeRefusal(): VerbRefusal {
  return refuse(
    pdfText("pdf.refusal.result_too_large", {
      mb: STIRLING_RESPONSE_MAX_BYTES / MB,
    }),
    "validation",
    PDF_REFUSAL_CODES.resultTooLarge
  );
}

/** Read the body, refusing (and cancelling) past the cap. */
async function readCapped(res: Response, timeoutMs: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > STIRLING_RESPONSE_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLargeRefusal();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > STIRLING_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeRefusal();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof VerbRefusal) throw err;
    throw transportRefusal(err, timeoutMs);
  }
  return Buffer.concat(chunks);
}

const PDF_MAGIC = Buffer.from("%PDF-");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * The type the bytes really are, checked against what the verb expects. An
 * engine answering 200 with an HTML error page must not be stored as a PDF.
 */
function sniffOutput(bytes: Buffer, expected: PdfOutputKind): string {
  const isPdf = bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  const isZip = bytes.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
  switch (expected) {
    case "pdf":
      if (isPdf) return "application/pdf";
      break;
    case "pdf-or-zip":
      if (isPdf) return "application/pdf";
      if (isZip) return "application/zip";
      break;
    case "markdown":
      if (bytes.length > 0 && !isPdf && !isZip) return "text/markdown";
      break;
    case "json":
      if (bytes.length > 0) return "application/json";
      break;
  }
  throw refuse(
    pdfText("pdf.refusal.bad_output", {
      expected: pdfText(EXPECTED_WORDS[expected]),
    }),
    "provider",
    PDF_REFUSAL_CODES.badOutput
  );
}

const EXPECTED_WORDS = {
  pdf: "pdf.expected.pdf",
  "pdf-or-zip": "pdf.expected.pdf_or_zip",
  markdown: "pdf.expected.markdown",
  json: "pdf.expected.json",
} as const satisfies Record<PdfOutputKind, PdfCopyKey>;
