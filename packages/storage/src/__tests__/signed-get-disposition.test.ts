/**
 * Every signed GET carries `Content-Disposition: attachment` (decision D10),
 * and serves a script or style blob as `text/plain` (plan D1, ticket
 * 15bc541d).
 *
 * Blobs are served on the pod origin and active types (HTML, SVG, XML) are
 * stored as-is, so a top-level navigation to a signed URL must download, never
 * render. A `<script src>` / `<link rel=stylesheet>` ignores the disposition,
 * so a stored `.js` / `.css` must not be SERVED as script or style either.
 * Driven through the REAL presigner (signing is local — no network) for each
 * S3 signer the package exports.
 */
import { describe, it, expect } from "vitest";
import { MinIOStorageProvider } from "../minio-provider.js";
import { R2StorageProvider } from "../r2-provider.js";
import { R2Storage } from "../r2.js";
import { attachmentDisposition, servedContentTypeOverride } from "../utils.js";

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

type Sign = (key: string, contentType?: string | null) => Promise<string>;
const signers: Array<[string, Sign]> = [
  [
    "MinIOStorageProvider",
    (key, contentType = "text/html") =>
      minio().getSignedUrl(key, 60, { contentType }),
  ],
  [
    "R2StorageProvider",
    (key, contentType = "text/html") =>
      new R2StorageProvider({ ...creds, accountId: "a" }).getSignedUrl(
        key,
        60,
        { contentType }
      ),
  ],
  [
    "R2Storage (legacy)",
    (key, contentType = "text/html") =>
      new R2Storage({ ...creds, accountId: "a" }).getSignedUrl(key, 60, {
        contentType,
      }),
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

describe("signed GET → a script or style blob is served as plain text", () => {
  it.each(signers)(
    "%s signs response-content-type=text/plain for JavaScript and CSS",
    async (_name, sign) => {
      for (const [key, type] of [
        ["poc/app.js", "text/javascript"],
        ["poc/app.mjs", "application/javascript"],
        ["poc/site.css", "text/css"],
      ] as const) {
        const url = new URL(await sign(key, type));
        expect(url.searchParams.get("response-content-type")).toBe(
          "text/plain; charset=utf-8"
        );
        // Still a download, whatever the type.
        expect(url.searchParams.get("response-content-disposition")).toMatch(
          /^attachment; /
        );
      }
    }
  );

  it.each(signers)(
    "%s leaves every other type as stored (no override)",
    async (_name, sign) => {
      for (const type of ["image/png", "text/html", "application/pdf", null]) {
        const url = new URL(await sign("poc/file", type));
        expect(url.searchParams.has("response-content-type")).toBe(false);
      }
    }
  );

  it("reads the type's essence: parameters and case do not hide a script", () => {
    expect(servedContentTypeOverride("Text/JavaScript; charset=utf-8")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(servedContentTypeOverride(" text/css ")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(servedContentTypeOverride("text/plain")).toBeUndefined();
    expect(servedContentTypeOverride(null)).toBeUndefined();
  });
});
