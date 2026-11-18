/**
 * TRIPWIRE — an ACTIVE upload type is allowed only while every signed GET is
 * `attachment` (decision D10).
 *
 * Stored blobs are served on the POD origin (`/synap-storage/*`), the origin of
 * the session cookie. An HTML / SVG / XML blob opened there by URL would run
 * its script with the person's pod session — a stored XSS. The pod stores those
 * types as-is ONLY because every signed GET carries
 * `ResponseContentDisposition: attachment; …` (top-level navigation downloads,
 * never renders) and Caddy adds `CSP: sandbox` on `/synap-storage/*`.
 *
 * So: if `isAllowedMimeType` admits any active type, every S3 signer in
 * `@synap/storage` must set that disposition on its signed GET.
 *
 * A SCRIPT or STYLE type (JavaScript, CSS — plan D1, ticket 15bc541d) is not
 * made safe by `attachment`: `<script src>` / `<link rel=stylesheet>` ignore
 * the disposition, and a blob on the pod origin passes `script-src 'self'`.
 * So if `isAllowedMimeType` admits one, every signer must ALSO serve it as
 * `text/plain` (`ResponseContentType: servedContentTypeOverride(...)`), which
 * with `nosniff` the browser refuses to run or apply.
 *
 * - The ALLOWED active set is derived from the REAL `isAllowedMimeType`.
 * - The SIGNER set is derived: every `packages/storage/src/*.ts` that imports
 *   the S3 presigner and builds a `GetObjectCommand` — a new signer joins by
 *   existing. Each one's `getSignedUrl` method must pass
 *   `ResponseContentDisposition: attachmentDisposition(...)`.
 * - Behaviourally, the MinIO + R2 providers' signed URLs (real presigner,
 *   local signing) carry `response-content-disposition=attachment…`, and
 *   `response-content-type=text/plain…` for every admitted script/style type.
 * - Every signer caller passes the stored type: `getSignedUrl`'s third
 *   argument is REQUIRED by `IFileStorage`, so the typecheck refuses a call
 *   that does not say it.
 *
 * Does NOT cover: the Caddy headers (deploy config: the `/synap-storage/*` CSP,
 * commit 80972aed, and `nosniff` from `security_headers` on every site block,
 * both pinned by `deploy/__tests__/caddy-routes.test.sh`), a signer outside
 * `packages/storage/src`, a signer that names its method something other than
 * `getSignedUrl` (the per-file assertion then fails on the missing method,
 * which is the intended loud failure), or a caller that passes
 * `contentType: null` for an object stored with a script type.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isAllowedMimeType } from "../routers/file-upload.js";

/** Types a browser executes as a document when navigated to. */
const ACTIVE_MIME_TYPES = [
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
];

/** Types a page RUNS or APPLIES when it includes them as a subresource. */
const SCRIPT_OR_STYLE_MIME_TYPES = [
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "text/css",
];

const STORAGE_SRC = resolve(__dirname, "../../../storage/src");

/**
 * The provider SOURCE, not `@synap/storage`'s built `dist` (a stale dist would
 * pass). Imported by path at runtime: a static cross-package import would sit
 * outside api's `rootDir`.
 */
type Signer = {
  getSignedUrl(
    path: string,
    expiresIn: number,
    object: { contentType: string | null }
  ): Promise<string>;
};
async function providerFromSource(
  file: string,
  exportName: string,
  config: Record<string, unknown>
): Promise<Signer> {
  const mod = (await import(join(STORAGE_SRC, file))) as Record<
    string,
    new (c: Record<string, unknown>) => Signer
  >;
  const p = new mod[exportName]!(config);
  // MinIO: skip the HeadBucket round-trip — signing never talks to the store.
  (p as unknown as { bucketInitialized: boolean }).bucketInitialized = true;
  return p;
}

function signerFiles(): Array<{ file: string; src: string }> {
  return readdirSync(STORAGE_SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, src: readFileSync(join(STORAGE_SRC, f), "utf8") }))
    .filter(
      ({ src }) =>
        src.includes("@aws-sdk/s3-request-presigner") &&
        src.includes("GetObjectCommand")
    );
}

/** The body of `async getSignedUrl(...) { ... }` — a class method at 2-space indent. */
function signedGetBody(src: string): string | null {
  const m = /\n {2}async getSignedUrl\([\s\S]*?\{\n([\s\S]*?)\n {2}\}\n/.exec(
    src
  );
  return m ? m[1]! : null;
}

const allowedActive = ACTIVE_MIME_TYPES.filter(isAllowedMimeType);
const allowedScript = SCRIPT_OR_STYLE_MIME_TYPES.filter(isAllowedMimeType);

/** The storage package's own override, from SOURCE (like the providers). */
async function overrideFromSource(): Promise<
  (contentType: string | null) => string | undefined
> {
  const mod = (await import(join(STORAGE_SRC, "utils.ts"))) as {
    servedContentTypeOverride: (c: string | null) => string | undefined;
  };
  return mod.servedContentTypeOverride;
}

describe("active upload types require attachment-disposition signed GETs", () => {
  it("the scan sees the real classifier and the real signers (non-vacuity)", () => {
    // The classifier is live: an inert type passes, an executable does not.
    expect(isAllowedMimeType("application/pdf")).toBe(true);
    expect(isAllowedMimeType("application/x-msdownload")).toBe(false);
    const files = signerFiles().map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining(["minio-provider.ts", "r2-provider.ts"])
    );
    // The method extractor can still see a literal sample.
    expect(
      signedGetBody(
        "\n  async getSignedUrl(path: string): Promise<string> {\n    return x;\n  }\n"
      )
    ).toBe("    return x;");
  });

  it("every S3 signer's getSignedUrl sets ResponseContentDisposition: attachment", () => {
    if (allowedActive.length === 0) return; // nothing active is stored
    for (const { file, src } of signerFiles()) {
      const body = signedGetBody(src);
      expect(body, `${file}: getSignedUrl method not found`).not.toBeNull();
      expect(
        body,
        `${file} signs GETs without an attachment disposition while ${allowedActive.join(", ")} can be uploaded`
      ).toMatch(/ResponseContentDisposition:\s*attachmentDisposition\(/);
    }
  });

  const creds = { accessKeyId: "k", secretAccessKey: "s", bucketName: "b" };
  it.each([
    [
      "minio-provider.ts",
      "MinIOStorageProvider",
      {
        ...creds,
        endpoint: "http://minio:9000",
        publicUrl: "https://pod.example.com",
      },
    ],
    ["r2-provider.ts", "R2StorageProvider", { ...creds, accountId: "a" }],
  ])("%s: a signed GET URL is attachment", async (file, name, config) => {
    if (allowedActive.length === 0) return;
    const signer = await providerFromSource(file, name, config);
    const url = new URL(
      await signer.getSignedUrl("u/x/deck.html", 60, {
        contentType: "text/html",
      })
    );
    expect(url.searchParams.get("response-content-disposition")).toMatch(
      /^attachment; filename\*=UTF-8''deck\.html$/
    );
  });
});

describe("script and style upload types require a text/plain signed GET", () => {
  it("the pod stores source code (ticket 15bc541d): JavaScript and CSS are admitted (non-vacuity)", () => {
    expect(allowedScript).toEqual(
      expect.arrayContaining([
        "text/javascript",
        "application/javascript",
        "text/css",
      ])
    );
  });

  it("the storage override serves every admitted script/style type as text/plain", async () => {
    const override = await overrideFromSource();
    for (const type of allowedScript) {
      expect(override(type), type).toBe("text/plain; charset=utf-8");
    }
    // An inert type keeps its stored type.
    expect(override("image/png")).toBeUndefined();
  });

  it("every S3 signer's getSignedUrl sets ResponseContentType from the override", () => {
    if (allowedScript.length === 0) return; // no script or style is stored
    for (const { file, src } of signerFiles()) {
      const body = signedGetBody(src);
      expect(body, `${file}: getSignedUrl method not found`).not.toBeNull();
      expect(
        body,
        `${file} signs GETs that serve ${allowedScript.join(", ")} as stored (a same-origin script)`
      ).toMatch(/ResponseContentType:\s*servedContentTypeOverride\(/);
    }
  });

  const creds = { accessKeyId: "k", secretAccessKey: "s", bucketName: "b" };
  it.each([
    [
      "minio-provider.ts",
      "MinIOStorageProvider",
      {
        ...creds,
        endpoint: "http://minio:9000",
        publicUrl: "https://pod.example.com",
      },
    ],
    ["r2-provider.ts", "R2StorageProvider", { ...creds, accountId: "a" }],
  ])(
    "%s: a signed GET of a stored script or style is text/plain and attachment",
    async (file, name, config) => {
      const signer = await providerFromSource(file, name, config);
      for (const type of allowedScript) {
        const url = new URL(
          await signer.getSignedUrl("u/x/app.js", 60, { contentType: type })
        );
        expect(url.searchParams.get("response-content-type"), type).toBe(
          "text/plain; charset=utf-8"
        );
        expect(url.searchParams.get("response-content-disposition")).toMatch(
          /^attachment; /
        );
      }
    }
  );
});
