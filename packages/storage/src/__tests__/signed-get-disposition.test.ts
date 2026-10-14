/**
 * Every signed GET carries `Content-Disposition: attachment` (decision D10).
 *
 * Blobs are served on the pod origin and active types (HTML, SVG, XML) are
 * stored as-is, so a top-level navigation to a signed URL must download, never
 * render. Driven through the REAL presigner (signing is local — no network)
 * for each S3 signer the package exports.
 */
import { describe, it, expect } from "vitest";
import { MinIOStorageProvider } from "../minio-provider.js";
import { R2StorageProvider } from "../r2-provider.js";
import { R2Storage } from "../r2.js";
import { attachmentDisposition } from "../utils.js";

const creds = { accessKeyId: "k", secretAccessKey: "s", bucketName: "b" };

function minio(): MinIOStorageProvider {
  const p = new MinIOStorageProvider({
    ...creds,
    endpoint: "http://minio:9000",
    publicUrl: "https://pod.example.com",
  });
  // Skip the HeadBucket round-trip — signing never talks to MinIO.
  (p as unknown as { bucketInitialized: boolean }).bucketInitialized = true;
  return p;
}

const signers: Array<[string, (key: string) => Promise<string>]> = [
  ["MinIOStorageProvider", (key) => minio().getSignedUrl(key, 60)],
  [
    "R2StorageProvider",
    (key) =>
      new R2StorageProvider({ ...creds, accountId: "a" }).getSignedUrl(key, 60),
  ],
  [
    "R2Storage (legacy)",
    (key) => new R2Storage({ ...creds, accountId: "a" }).getSignedUrl(key, 60),
  ],
];

describe("signed GET → attachment disposition", () => {
  it.each(signers)(
    "%s signs response-content-disposition=attachment with the key's basename",
    async (_name, sign) => {
      const url = new URL(
        await sign("files/ws/uploads/u/x/Q3 deck (final).html")
      );
      expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
      expect(url.searchParams.get("response-content-disposition")).toBe(
        "attachment; filename*=UTF-8''Q3%20deck%20%28final%29.html"
      );
    }
  );

  it("encodes non-ASCII names per RFC 5987 and never emits a raw quote", () => {
    expect(attachmentDisposition("a/b/résumé'1.pdf")).toBe(
      "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%271.pdf"
    );
    expect(attachmentDisposition("")).toBe("attachment; filename*=UTF-8''file");
  });
});
