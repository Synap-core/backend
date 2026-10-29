/**
 * `downloadStream` — the streamed read every provider implements. The S3 half
 * is driven with the REAL `GetObjectCommand` against a fake `send` (the input
 * is what an S3 endpoint would receive); the local provider against a real
 * temp directory.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { downloadStreamFromS3 } from "../s3-stream-download.js";
import { LocalStorageProvider } from "../local-provider.js";
import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
} from "../interface.js";

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const c of body) out.push(Buffer.from(c));
  return Buffer.concat(out);
}

function s3Client(reply: () => unknown) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    sent,
    async send(command: { constructor: { name: string }; input: unknown }) {
      sent.push({
        name: command.constructor.name,
        input: command.input as Record<string, unknown>,
      });
      return reply();
    },
  };
}

describe("downloadStreamFromS3", () => {
  it("streams the object's bytes with its length and type", async () => {
    const bytes = Buffer.from("hello, provider");
    const client = s3Client(() => ({
      Body: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
      ContentLength: bytes.length,
      ContentType: "image/png",
    }));
    const dl = await downloadStreamFromS3({
      client,
      bucket: "b",
      key: "users/u/files/a.png",
    });
    expect(client.sent).toEqual([
      {
        name: GetObjectCommand.name,
        input: { Bucket: "b", Key: "users/u/files/a.png" },
      },
    ]);
    expect(dl.size).toBe(bytes.length);
    expect(dl.contentType).toBe("image/png");
    expect(await readAll(dl.body)).toEqual(bytes);
  });

  it("a missing key is StorageObjectNotFoundError (NoSuchKey and a bare 404)", async () => {
    for (const err of [
      Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
      }),
      Object.assign(new Error("UnknownError"), {
        $metadata: { httpStatusCode: 404 },
      }),
    ]) {
      const client = s3Client(() => {
        throw err;
      });
      await expect(
        downloadStreamFromS3({ client, bucket: "b", key: "gone.bin" })
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    }
  });

  it("any other store error is rethrown as-is, never read as 'not found'", async () => {
    const boom = Object.assign(new Error("SlowDown"), {
      $metadata: { httpStatusCode: 503 },
    });
    const client = s3Client(() => {
      throw boom;
    });
    await expect(
      downloadStreamFromS3({ client, bucket: "b", key: "k" })
    ).rejects.toBe(boom);
  });

  it("over maxBytes by its length: refused before a byte is read, body released", async () => {
    const body = Readable.from([Buffer.alloc(11)]);
    const client = s3Client(() => ({ Body: body, ContentLength: 11 }));
    const err = await downloadStreamFromS3({
      client,
      bucket: "b",
      key: "big.bin",
      maxBytes: 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageObjectTooLargeError);
    expect(err).toMatchObject({ path: "big.bin", size: 11, maxBytes: 10 });
    expect(body.destroyed).toBe(true);
  });

  it("a length that lies cannot get more than maxBytes through", async () => {
    const client = s3Client(() => ({
      Body: Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
      ContentLength: 4,
    }));
    const dl = await downloadStreamFromS3({
      client,
      bucket: "b",
      key: "liar.bin",
      maxBytes: 10,
    });
    await expect(readAll(dl.body)).rejects.toMatchObject({
      code: "STORAGE_OBJECT_TOO_LARGE",
      size: 12,
      maxBytes: 10,
    });
  });

  it("exactly maxBytes passes", async () => {
    const client = s3Client(() => ({
      Body: Readable.from([Buffer.alloc(10, 7)]),
      ContentLength: 10,
    }));
    const dl = await downloadStreamFromS3({
      client,
      bucket: "b",
      key: "k",
      maxBytes: 10,
    });
    expect((await readAll(dl.body)).length).toBe(10);
  });
});

describe("LocalStorageProvider.downloadStream", () => {
  async function provider() {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "synap-dl-"));
    return { rootDir, p: new LocalStorageProvider({ rootDir }) };
  }

  it("streams a stored file", async () => {
    const { p } = await provider();
    await p.upload("users/u/files/a.bin", Buffer.from([1, 2, 3, 4]));
    const dl = await p.downloadStream("users/u/files/a.bin");
    expect(dl.size).toBe(4);
    expect([...(await readAll(dl.body))]).toEqual([1, 2, 3, 4]);
  });

  it("a missing file is StorageObjectNotFoundError", async () => {
    const { p } = await provider();
    await expect(p.downloadStream("nope.bin")).rejects.toBeInstanceOf(
      StorageObjectNotFoundError
    );
  });

  it("over maxBytes is refused before reading", async () => {
    const { p } = await provider();
    await p.upload("big.bin", Buffer.alloc(11));
    await expect(
      p.downloadStream("big.bin", { maxBytes: 10 })
    ).rejects.toMatchObject({ code: "STORAGE_OBJECT_TOO_LARGE", size: 11 });
  });
});
