/**
 * Streamed download from an S3-compatible bucket (R2, MinIO), and the byte cap
 * every provider's `downloadStream` shares.
 *
 *   • not found → `StorageObjectNotFoundError` (S3 `NoSuchKey` / a 404), never a
 *                 generic error a caller would read as "storage is down".
 *   • too large → refused from `ContentLength` before any byte is read, and
 *                 again as the bytes pass ({@link capBytes}).
 */

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type DownloadStream,
} from "./interface.js";

/**
 * Pass `source` through, throwing {@link StorageObjectTooLargeError} once more
 * than `maxBytes` went by. Throwing ends the `for await`, which destroys a Node
 * stream source.
 */
export async function* capBytes(
  source: AsyncIterable<Uint8Array>,
  path: string,
  maxBytes: number | undefined
): AsyncGenerator<Uint8Array> {
  let seen = 0;
  for await (const chunk of source) {
    seen += chunk.byteLength;
    if (maxBytes !== undefined && seen > maxBytes) {
      throw new StorageObjectTooLargeError(path, seen, maxBytes);
    }
    yield chunk;
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  );
}

export interface S3StreamDownloadArgs {
  client: Pick<S3Client, "send">;
  bucket: string;
  key: string;
  maxBytes?: number;
}

export async function downloadStreamFromS3(
  args: S3StreamDownloadArgs
): Promise<DownloadStream> {
  const { client, bucket, key, maxBytes } = args;
  let response;
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
  } catch (err) {
    if (isNotFound(err)) throw new StorageObjectNotFoundError(key);
    throw err;
  }
  const raw = response.Body as
    (AsyncIterable<Uint8Array> & Partial<Readable>) | undefined;
  if (!raw) throw new StorageObjectNotFoundError(key);
  const cancel = () => {
    raw.destroy?.();
  };
  const size =
    typeof response.ContentLength === "number" ? response.ContentLength : null;
  if (maxBytes !== undefined && size !== null && size > maxBytes) {
    cancel();
    throw new StorageObjectTooLargeError(key, size, maxBytes);
  }
  return {
    body: capBytes(raw, key, maxBytes),
    size,
    contentType: response.ContentType || "application/octet-stream",
    cancel,
  };
}
