/**
 * Streamed upload to an S3-compatible bucket (R2, MinIO) — the body is read
 * chunk by chunk and never held whole in memory; at most ONE part is.
 *
 *   • parts   → every part but the last is EXACTLY `partBytes` (R2 refuses a
 *               multipart upload whose non-trailing parts differ in size;
 *               S3/MinIO require ≥ 5 MiB). A body smaller than one part is a
 *               single plain PUT — no multipart round trips for a small file.
 *   • failure → when the body throws (a byte cap passed, a dropped source)
 *               or a part is refused, the multipart upload is ABORTED, so no
 *               object and no billable dangling parts are left; the original
 *               error is rethrown.
 *   • digest  → size and `sha256:<hex>` are computed as the bytes pass
 *               (the one encoding of `fileChecksum`).
 *
 * Uses only `@aws-sdk/client-s3` (already the storage SDK) — no
 * `@aws-sdk/lib-storage`.
 */

import { createHash } from "crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

/** 8 MiB: above S3's 5 MiB minimum, and one part is all that sits in memory. */
export const S3_STREAM_PART_BYTES = 8 * 1024 * 1024;

export interface S3StreamUploadArgs {
  client: Pick<S3Client, "send">;
  bucket: string;
  key: string;
  body: AsyncIterable<Uint8Array>;
  contentType?: string;
  metadata?: Record<string, string>;
  /** Test seam; defaults to {@link S3_STREAM_PART_BYTES}. */
  partBytes?: number;
}

export async function uploadStreamToS3(
  args: S3StreamUploadArgs
): Promise<{ size: number; checksum: string }> {
  const partBytes = args.partBytes ?? S3_STREAM_PART_BYTES;
  const contentType = args.contentType || "application/octet-stream";
  const hash = createHash("sha256");
  let size = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let uploadId: string | undefined;
  const parts: Array<{ ETag: string | undefined; PartNumber: number }> = [];

  const takePart = (n: number): Buffer => {
    const all = Buffer.concat(pending, pendingBytes);
    const part = all.subarray(0, n);
    const rest = all.subarray(n);
    pending = rest.byteLength > 0 ? [Buffer.from(rest)] : [];
    pendingBytes = rest.byteLength;
    return Buffer.from(part);
  };

  const sendPart = async (body: Buffer): Promise<void> => {
    if (!uploadId) {
      const created = await args.client.send(
        new CreateMultipartUploadCommand({
          Bucket: args.bucket,
          Key: args.key,
          ContentType: contentType,
          Metadata: args.metadata,
        })
      );
      if (!created.UploadId) {
        throw new Error(`Storage refused a multipart upload for ${args.key}`);
      }
      uploadId = created.UploadId;
    }
    const PartNumber = parts.length + 1;
    const res = await args.client.send(
      new UploadPartCommand({
        Bucket: args.bucket,
        Key: args.key,
        UploadId: uploadId,
        PartNumber,
        Body: body,
        ContentLength: body.byteLength,
      })
    );
    parts.push({ ETag: res.ETag, PartNumber });
  };

  try {
    for await (const chunk of args.body) {
      if (!chunk || chunk.byteLength === 0) continue;
      hash.update(chunk);
      size += chunk.byteLength;
      pending.push(Buffer.from(chunk));
      pendingBytes += chunk.byteLength;
      while (pendingBytes >= partBytes) {
        await sendPart(takePart(partBytes));
      }
    }

    if (!uploadId) {
      // Smaller than one part: one plain PUT.
      const body = Buffer.concat(pending, pendingBytes);
      await args.client.send(
        new PutObjectCommand({
          Bucket: args.bucket,
          Key: args.key,
          Body: body,
          ContentType: contentType,
          Metadata: args.metadata,
        })
      );
    } else {
      if (pendingBytes > 0) await sendPart(takePart(pendingBytes));
      await args.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: args.bucket,
          Key: args.key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        })
      );
    }
  } catch (err) {
    if (uploadId) {
      try {
        await args.client.send(
          new AbortMultipartUploadCommand({
            Bucket: args.bucket,
            Key: args.key,
            UploadId: uploadId,
          })
        );
      } catch {
        // The bucket's lifecycle rule reaps an upload we could not abort.
      }
    }
    throw err;
  }

  return { size, checksum: `sha256:${hash.digest("hex")}` };
}
