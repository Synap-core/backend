/**
 * Provider file bodies — a stored pod file's bytes sent to a provider by the
 * HOST, never through the skill isolate (plan "pod files to tools" phase 2,
 * decision 7d42be8c).
 *
 * Two encodings, for the two shapes providers take a file in:
 *   - `multipart`   → `multipart/form-data`: text fields, then each file part
 *                     STREAMED from storage (Unipile posts). At most
 *                     {@link MULTIPART_FILE_MAX_BYTES} per file; the body is
 *                     never held whole in memory.
 *   - `json-base64` → a JSON body whose named slots are filled with the file's
 *                     base64 (APIs that offer nothing else). The whole body is
 *                     built in memory, so the files' bytes together are capped at
 *                     {@link BASE64_BODY_MAX_BYTES} (founder: 20 MB).
 *
 * A file is named by a {@link ProviderFileRef} — a storage key the HOST
 * resolved after re-checking the file under the run's identity. It is never
 * read out of a request body or a skill's arguments: it rides
 * `TriggerProviderActionInput.fileBody`, which no request door forwards.
 *
 * Every refusal is a typed {@link ProviderFileBodyError}; a file that is gone
 * and a storage that failed are different facts (404 vs 502).
 */

import { randomBytes } from "node:crypto";
import type { IFileStorage } from "@synap/storage";

/** 100 MB per file part, by bytes (multipart), until streaming is measured. */
export const MULTIPART_FILE_MAX_BYTES = 100 * 1024 * 1024;
/** 20 MB of file bytes per base64 JSON body (founder decision 7d42be8c). */
export const BASE64_BODY_MAX_BYTES = 20 * 1024 * 1024;

/**
 * A pod file the host sends to a provider. Built only by host code from a file
 * it re-checked; never accepted from a caller.
 */
export interface ProviderFileRef {
  /** `documents.storage_key`. */
  storageKey: string;
  /** The name the provider sees (the file entity's name). */
  filename: string;
  /** `documents.mime_type`; the part's Content-Type. */
  contentType: string;
  /**
   * `documents.size`, as the pod recorded it: refused up front when it is
   * already over a cap. The caps themselves are enforced on the bytes storage
   * actually returns.
   */
  size: number;
}

export interface MultipartFileBody {
  encoding: "multipart";
  /** Text fields, sent first, in insertion order. */
  fields?: Record<string, string>;
  /** File parts, in order. A field name may repeat (`attachments`). */
  files: ReadonlyArray<{ field: string; file: ProviderFileRef }>;
}

export interface JsonBase64FileBody {
  encoding: "json-base64";
  /** The JSON body. Each file fills one slot that already exists in it. */
  json: Record<string, unknown>;
  /** `path` = keys/indexes from the body's root to the slot the base64 fills. */
  files: ReadonlyArray<{
    path: ReadonlyArray<string | number>;
    file: ProviderFileRef;
  }>;
}

export type ProviderFileBody = MultipartFileBody | JsonBase64FileBody;

export type ProviderFileBodyErrorCode =
  "bad_file_body" | "file_not_found" | "file_too_large" | "file_unreadable";

const STATUS_BY_CODE: Record<ProviderFileBodyErrorCode, number> = {
  bad_file_body: 400,
  file_not_found: 404,
  file_too_large: 413,
  file_unreadable: 502,
};

export class ProviderFileBodyError extends Error {
  readonly status: number;
  constructor(
    readonly code: ProviderFileBodyErrorCode,
    message: string,
    readonly filename?: string
  ) {
    super(message);
    this.name = "ProviderFileBodyError";
    this.status = STATUS_BY_CODE[code];
  }
}

/** An encoded body, ready for `fetch`. */
export interface EncodedFileBody {
  contentType: string;
  /** A string (base64 JSON) or a lazily read byte stream (multipart). */
  body: string | AsyncIterable<Uint8Array>;
  /**
   * The typed failure that ended a streamed body, if one did. `fetch` reports
   * a failed request body as its own error; this is how the caller tells "the
   * file was gone" from "the provider was unreachable".
   */
  failure(): ProviderFileBodyError | null;
}

type StreamStorage = Pick<IFileStorage, "downloadStream">;

export interface EncodeDeps {
  /** Defaults to the pod's storage (`@synap/storage`). */
  storage?: StreamStorage;
  /** Test seam: a fixed multipart boundary. */
  boundary?: string;
}

/** Name, type and size of each file a body sends (dry-runs and the audit row). */
export function describeFileBody(fileBody: ProviderFileBody): Array<{
  filename: string;
  contentType: string;
  size: number;
  encoding: ProviderFileBody["encoding"];
}> {
  return fileBody.files.map(({ file }) => ({
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    encoding: fileBody.encoding,
  }));
}

export async function encodeProviderFileBody(
  fileBody: ProviderFileBody,
  deps: EncodeDeps = {}
): Promise<EncodedFileBody> {
  const files = Array.isArray(fileBody?.files) ? fileBody.files : null;
  if (!files || files.length === 0) {
    throw new ProviderFileBodyError(
      "bad_file_body",
      "A file body must name at least one file."
    );
  }
  for (const { file } of files) assertFileRef(file);
  const storage = deps.storage ?? (await import("@synap/storage")).storage;

  if (fileBody.encoding === "multipart") {
    return encodeMultipart(fileBody, storage, deps.boundary);
  }
  if (fileBody.encoding === "json-base64") {
    return encodeJsonBase64(fileBody, storage);
  }
  throw new ProviderFileBodyError(
    "bad_file_body",
    `Unknown file body encoding "${String((fileBody as { encoding?: unknown }).encoding)}" (expected "multipart" or "json-base64").`
  );
}

function assertFileRef(file: ProviderFileRef | undefined): void {
  if (
    !file ||
    typeof file.storageKey !== "string" ||
    !file.storageKey ||
    typeof file.filename !== "string" ||
    !file.filename ||
    typeof file.contentType !== "string" ||
    !file.contentType ||
    /[\r\n]/.test(file.contentType) ||
    typeof file.size !== "number" ||
    !Number.isFinite(file.size) ||
    file.size < 0
  ) {
    throw new ProviderFileBodyError(
      "bad_file_body",
      "Each file needs a storageKey, a filename, a contentType and a size."
    );
  }
}

const MB = 1024 * 1024;
const mb = (n: number) => `${Math.round((n / MB) * 10) / 10} MB`;

/**
 * Map a storage refusal onto the file it was about. Any other storage error is
 * `file_unreadable` (502): the file may well exist, the read failed.
 */
function storageFailure(
  err: unknown,
  file: ProviderFileRef,
  tooLargeMessage: string
): ProviderFileBodyError {
  if (err instanceof ProviderFileBodyError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "STORAGE_OBJECT_NOT_FOUND") {
    return new ProviderFileBodyError(
      "file_not_found",
      `"${file.filename}" is no longer in this pod's storage, so it was not sent.`,
      file.filename
    );
  }
  if (code === "STORAGE_OBJECT_TOO_LARGE") {
    return new ProviderFileBodyError(
      "file_too_large",
      tooLargeMessage,
      file.filename
    );
  }
  return new ProviderFileBodyError(
    "file_unreadable",
    `Reading "${file.filename}" from storage failed: ${err instanceof Error ? err.message : String(err)}`,
    file.filename
  );
}

// ── multipart/form-data ──────────────────────────────────────────────────────

/** WHATWG form-data escaping for a quoted name or filename. */
function escapeQuoted(value: string): string {
  return value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

function encodeMultipart(
  fileBody: MultipartFileBody,
  storage: StreamStorage,
  fixedBoundary: string | undefined
): EncodedFileBody {
  const fields = fileBody.fields ?? {};
  for (const [name, value] of Object.entries(fields)) {
    if (!name || typeof value !== "string") {
      throw new ProviderFileBodyError(
        "bad_file_body",
        "Multipart text fields need a name and a string value."
      );
    }
  }
  for (const { field, file } of fileBody.files) {
    if (typeof field !== "string" || !field) {
      throw new ProviderFileBodyError(
        "bad_file_body",
        `"${file.filename}" needs the form field name it is sent under.`,
        file.filename
      );
    }
    if (file.size > MULTIPART_FILE_MAX_BYTES) {
      throw new ProviderFileBodyError(
        "file_too_large",
        tooLargeForMultipart(file),
        file.filename
      );
    }
  }

  const boundary =
    fixedBoundary ?? `----SynapFormBoundary${randomBytes(16).toString("hex")}`;
  let failure: ProviderFileBodyError | null = null;
  const enc = new TextEncoder();

  async function* parts(): AsyncGenerator<Uint8Array> {
    for (const [name, value] of Object.entries(fields)) {
      yield enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(name)}"\r\n\r\n${value}\r\n`
      );
    }
    for (const { field, file } of fileBody.files) {
      // Opened only when the request reaches this part: an idle storage
      // connection is never held open while an earlier part uploads.
      let dl;
      try {
        dl = await storage.downloadStream(file.storageKey, {
          maxBytes: MULTIPART_FILE_MAX_BYTES,
        });
      } catch (err) {
        throw (failure = storageFailure(err, file, tooLargeForMultipart(file)));
      }
      yield enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(field)}"; filename="${escapeQuoted(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      );
      try {
        for await (const chunk of dl.body) yield chunk;
      } catch (err) {
        dl.cancel();
        throw (failure = storageFailure(err, file, tooLargeForMultipart(file)));
      }
      yield enc.encode("\r\n");
    }
    yield enc.encode(`--${boundary}--\r\n`);
  }

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: parts(),
    failure: () => failure,
  };
}

function tooLargeForMultipart(file: ProviderFileRef): string {
  return `"${file.filename}" is over the ${mb(MULTIPART_FILE_MAX_BYTES)} a file part may carry, so it was not sent.`;
}

// ── JSON with base64 slots ───────────────────────────────────────────────────

async function encodeJsonBase64(
  fileBody: JsonBase64FileBody,
  storage: StreamStorage
): Promise<EncodedFileBody> {
  const { json } = fileBody;
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ProviderFileBodyError(
      "bad_file_body",
      "A base64 file body needs a JSON object to fill."
    );
  }
  const declared = fileBody.files.reduce((n, { file }) => n + file.size, 0);
  if (declared > BASE64_BODY_MAX_BYTES) {
    throw new ProviderFileBodyError(
      "file_too_large",
      `These files come to ${mb(declared)}, over the ${mb(BASE64_BODY_MAX_BYTES)} a base64 body may carry, so nothing was sent.`
    );
  }

  const out = structuredClone(json);
  const slots = fileBody.files.map(({ path, file }) => ({
    file,
    ...slotOf(out, path, file),
  }));

  let remaining = BASE64_BODY_MAX_BYTES;
  for (const { file, parent, key } of slots) {
    const tooLarge = `"${file.filename}" would take the base64 body over ${mb(BASE64_BODY_MAX_BYTES)}, so nothing was sent.`;
    const chunks: Uint8Array[] = [];
    try {
      const dl = await storage.downloadStream(file.storageKey, {
        maxBytes: remaining,
      });
      for await (const chunk of dl.body) chunks.push(chunk);
    } catch (err) {
      throw storageFailure(err, file, tooLarge);
    }
    const bytes = Buffer.concat(chunks);
    remaining -= bytes.length;
    (parent as Record<string | number, unknown>)[key] =
      bytes.toString("base64");
  }

  return {
    contentType: "application/json",
    body: JSON.stringify(out),
    failure: () => null,
  };
}

/** The container and key a slot path names. The slot must already exist. */
function slotOf(
  root: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  file: ProviderFileRef
): { parent: object; key: string | number } {
  const where = Array.isArray(path) ? path.join(".") : String(path);
  const missing = () =>
    new ProviderFileBodyError(
      "bad_file_body",
      `The body has no slot at "${where}" for "${file.filename}".`,
      file.filename
    );
  if (!Array.isArray(path) || path.length === 0) throw missing();
  let parent: unknown = root;
  for (let i = 0; i < path.length - 1; i++) {
    parent = has(parent, path[i]!)
      ? (parent as Record<string | number, unknown>)[path[i]!]
      : undefined;
  }
  const key = path[path.length - 1]!;
  if (!has(parent, key)) throw missing();
  return { parent: parent as object, key };
}

function has(container: unknown, key: string | number): boolean {
  if (Array.isArray(container)) {
    return typeof key === "number" && key >= 0 && key < container.length;
  }
  return (
    !!container &&
    typeof container === "object" &&
    typeof key === "string" &&
    Object.prototype.hasOwnProperty.call(container, key)
  );
}
