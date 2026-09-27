/**
 * One checksum format for every provider, and a comparator that still reads the
 * legacy MinIO/R2 `sha256:<base64>` rows already persisted in
 * `document_versions.checksum`.
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checksumMatchesContent, fileChecksum } from "../checksum.js";
import { LocalStorageProvider } from "../local-provider.js";
import { MinIOStorageProvider } from "../minio-provider.js";
import { R2StorageProvider } from "../r2-provider.js";

const BODY = "# Probe\n\nSame words, opened again.\n";
const hex = createHash("sha256").update(BODY).digest("hex");
const base64 = createHash("sha256").update(BODY).digest("base64");

function stubClient(provider: object) {
  (provider as { client: unknown }).client = { send: vi.fn(async () => ({})) };
  return provider;
}

describe("fileChecksum", () => {
  it("is sha256:<hex> for strings and buffers alike", () => {
    expect(fileChecksum(BODY)).toBe(`sha256:${hex}`);
    expect(fileChecksum(Buffer.from(BODY))).toBe(`sha256:${hex}`);
  });

  it("every provider stamps the same checksum for the same bytes", async () => {
    const minio = stubClient(
      new MinIOStorageProvider({
        endpoint: "http://minio.test",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucketName: "b",
      })
    ) as MinIOStorageProvider;
    const r2 = stubClient(
      new R2StorageProvider({
        accountId: "a",
        accessKeyId: "k",
        secretAccessKey: "s",
        bucketName: "b",
      })
    ) as R2StorageProvider;
    const local = new LocalStorageProvider({
      rootDir: mkdtempSync(join(tmpdir(), "synap-checksum-")),
    });
    const stamped = await Promise.all([
      minio.upload("u/doc/x.md", BODY),
      r2.upload("u/doc/x.md", BODY),
      local.upload("u/doc/x.md", BODY),
    ]);
    expect(stamped.map((m) => m.checksum)).toEqual([
      `sha256:${hex}`,
      `sha256:${hex}`,
      `sha256:${hex}`,
    ]);
  });
});

describe("checksumMatchesContent", () => {
  it("matches the current hex form and the legacy base64 form", () => {
    expect(checksumMatchesContent(`sha256:${hex}`, BODY)).toBe(true);
    expect(checksumMatchesContent(`sha256:${base64}`, BODY)).toBe(true);
    expect(checksumMatchesContent(`sha256:${base64}`, Buffer.from(BODY))).toBe(
      true
    );
  });

  it("never matches other content, a missing checksum or another algorithm", () => {
    expect(checksumMatchesContent(`sha256:${hex}`, BODY + " ")).toBe(false);
    expect(checksumMatchesContent(`sha256:${base64}`, BODY + " ")).toBe(false);
    expect(checksumMatchesContent(null, BODY)).toBe(false);
    expect(checksumMatchesContent("", BODY)).toBe(false);
    expect(checksumMatchesContent(hex, BODY)).toBe(false);
  });
});
