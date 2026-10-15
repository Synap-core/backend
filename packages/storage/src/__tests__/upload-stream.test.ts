/**
 * `uploadStream` — the streamed upload every provider implements. Driven with
 * the REAL client-s3 command classes against a fake `send` (so the commands
 * and their inputs are what an S3 endpoint would receive), and the local
 * provider against a real temp directory.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { uploadStreamToS3 } from "../s3-stream-upload.js";
import { LocalStorageProvider } from "../local-provider.js";

function fakeClient(opts: { failPart?: number } = {}) {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    sent,
    async send(command: { constructor: { name: string }; input: unknown }) {
      const input = command.input as Record<string, unknown>;
      sent.push({ name: command.constructor.name, input });
      if (command instanceof CreateMultipartUploadCommand)
        return { UploadId: "up-1" };
      if (command instanceof UploadPartCommand) {
        if (opts.failPart === input.PartNumber) throw new Error("part refused");
        return { ETag: `"etag-${input.PartNumber}"` };
      }
      return {};
    },
  };
}

async function* chunks(
  sizes: number[],
  opts: { throwAfter?: number } = {}
): AsyncGenerator<Uint8Array> {
  let i = 0;
  for (const n of sizes) {
    if (opts.throwAfter !== undefined && i === opts.throwAfter)
      throw new Error("too_large");
    yield new Uint8Array(n).fill(i % 251);
    i++;
  }
}

const sha = (buf: Buffer) =>
  `sha256:${createHash("sha256").update(buf).digest("hex")}`;

describe("uploadStreamToS3", () => {
  it("a body smaller than one part is ONE plain PUT", async () => {
    const client = fakeClient();
    const res = await uploadStreamToS3({
      client: client as never,
      bucket: "b",
      key: "k",
      body: chunks([10, 20]),
      contentType: "video/mp4",
      partBytes: 64,
    });
    expect(client.sent.map((s) => s.name)).toEqual(["PutObjectCommand"]);
    expect((client.sent[0]!.input.Body as Buffer).byteLength).toBe(30);
    expect(client.sent[0]!.input.ContentType).toBe("video/mp4");
    expect(res.size).toBe(30);
  });

  it("splits into EXACT fixed-size parts (R2's rule) + a short last part, then completes", async () => {
    const client = fakeClient();
    // 7 chunks of 30 = 210 bytes → parts 64, 64, 64, 18.
    const all = Buffer.concat(
      Array.from({ length: 7 }, (_, i) => Buffer.alloc(30, i % 251))
    );
    const res = await uploadStreamToS3({
      client: client as never,
      bucket: "b",
      key: "k",
      body: chunks([30, 30, 30, 30, 30, 30, 30]),
      partBytes: 64,
    });
    const partSizes = client.sent
      .filter((s) => s.name === "UploadPartCommand")
      .map((s) => (s.input.Body as Buffer).byteLength);
    expect(partSizes).toEqual([64, 64, 64, 18]);
    expect(client.sent[0]!.name).toBe("CreateMultipartUploadCommand");
    const complete = client.sent.at(-1)!;
    expect(complete.name).toBe("CompleteMultipartUploadCommand");
    expect(
      (complete.input.MultipartUpload as { Parts: unknown[] }).Parts
    ).toHaveLength(4);
    // The bytes that went out, in order, are the body.
    const sentBytes = Buffer.concat(
      client.sent
        .filter((s) => s.name === "UploadPartCommand")
        .map((s) => s.input.Body as Buffer)
    );
    expect(sentBytes.equals(all)).toBe(true);
    expect(res).toEqual({ size: 210, checksum: sha(all) });
    expect(new CompleteMultipartUploadCommand({} as never)).toBeTruthy();
  });

  it("a body that throws mid-stream ABORTS the multipart upload and rethrows", async () => {
    const client = fakeClient();
    await expect(
      uploadStreamToS3({
        client: client as never,
        bucket: "b",
        key: "k",
        body: chunks([64, 64, 64], { throwAfter: 2 }),
        partBytes: 64,
      })
    ).rejects.toThrow("too_large");
    const names = client.sent.map((s) => s.name);
    expect(names.at(-1)).toBe("AbortMultipartUploadCommand");
    expect(names).not.toContain("CompleteMultipartUploadCommand");
    expect(client.sent.at(-1)!.input.UploadId).toBe("up-1");
    expect(AbortMultipartUploadCommand).toBeTruthy();
  });

  it("a refused part aborts too", async () => {
    const client = fakeClient({ failPart: 2 });
    await expect(
      uploadStreamToS3({
        client: client as never,
        bucket: "b",
        key: "k",
        body: chunks([64, 64, 64]),
        partBytes: 64,
      })
    ).rejects.toThrow("part refused");
    expect(client.sent.at(-1)!.name).toBe("AbortMultipartUploadCommand");
  });

  it("a small body that throws sends nothing at all", async () => {
    const client = fakeClient();
    await expect(
      uploadStreamToS3({
        client: client as never,
        bucket: "b",
        key: "k",
        body: chunks([10, 10], { throwAfter: 1 }),
        partBytes: 64,
      })
    ).rejects.toThrow("too_large");
    expect(client.sent).toEqual([]);
    expect(PutObjectCommand).toBeTruthy();
  });
});

describe("LocalStorageProvider.uploadStream", () => {
  it("writes the streamed bytes, with size + checksum", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synap-stream-"));
    const provider = new LocalStorageProvider({ rootDir: root });
    const res = await provider.uploadStream("a/b/video.mp4", chunks([5, 7, 9]));
    const onDisk = await fs.readFile(path.join(root, "a/b/video.mp4"));
    expect(onDisk.byteLength).toBe(21);
    expect(res.size).toBe(21);
    expect(res.checksum).toBe(sha(onDisk));
    expect(await fs.readdir(path.join(root, "a/b"))).toEqual(["video.mp4"]);
  });

  it("a body that throws leaves NO file and no temp file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synap-stream-"));
    const provider = new LocalStorageProvider({ rootDir: root });
    await expect(
      provider.uploadStream("a/video.mp4", chunks([5, 7, 9], { throwAfter: 2 }))
    ).rejects.toThrow("too_large");
    expect(await fs.readdir(path.join(root, "a"))).toEqual([]);
  });
});
