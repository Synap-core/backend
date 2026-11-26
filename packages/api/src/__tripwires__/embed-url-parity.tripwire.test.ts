/**
 * TRIPWIRE — the server's embed rule IS the browser's.
 *
 * `classifyEmbedUrl` decides whether a URL may become a website embed (an
 * `iframe-embed` cell, rendered with scripts). The browser applies it on write
 * and on render (synap-app `packages/web/src/bento-view/components/widgets/
 * embed-url.ts`); the whiteboard place door applies it on write from
 * `@synap-core/types/embed-url` (an agent's url never passes the browser's
 * write check). Two copies until synap-app imports the shared one: this pins
 * them to the same verdict on every URL below, so a rule tightened on one
 * side and not the other fails here.
 *
 * Needs the sibling checkout `../synap-app` (CI, the devbox and the Mac all
 * lay the repos out side by side); without it the test FAILS, never skips.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as shared from "@synap-core/types/embed-url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const APP_RULE = join(
  REPO,
  "../synap-app/packages/web/src/bento-view/components/widgets/embed-url.ts"
);

const POD = "https://pod.example.test";
const CORPUS: Array<[string, string | null]> = [
  ["https://example.com/page?q=1", POD],
  ["  https://example.com/trim  ", POD],
  ["http://example.com/", POD],
  ["javascript:alert(1)", POD],
  ["data:text/html,<script>1</script>", POD],
  ["file:///etc/passwd", POD],
  ["blob:https://example.com/abc", POD],
  ["not a url", POD],
  ["", POD],
  ["https://bucket.s3.amazonaws.com/a.svg?X-Amz-Signature=abc", POD],
  ["http://minio:9000/b/a.svg?x-amz-credential=c", POD],
  ["https://cdn.example.com/x?X-Amz-Security-Token=t", POD],
  ["https://pod.example.test/api/files/abc", POD],
  ["https://other.example.com/api/pod/files/abc", POD],
  ["https://pod.example.test/open/123", POD],
  ["https://pod.example.test:443/settings", POD],
  ["https://pod.example.test/open/123", null],
  ["https://pod.example.test/open/123", "not a url"],
];

describe("embed rule parity (server = browser)", () => {
  it("the browser's rule file is where this test reads it", () => {
    expect(
      existsSync(APP_RULE),
      `${APP_RULE} is missing: synap-app moved or renamed it. Point this test at it (or at the shared module once synap-app imports @synap-core/types/embed-url).`
    ).toBe(true);
  });

  it("gives the same verdict and message on every URL", async () => {
    const app = (await import(APP_RULE)) as typeof shared;
    for (const [url, podUrl] of CORPUS) {
      const a = app.classifyEmbedUrl(url, { podUrl });
      const s = shared.classifyEmbedUrl(url, { podUrl });
      expect(s, url).toEqual(a);
      expect(shared.embedUrlRefusalMessage(s), url).toBe(
        app.embedUrlRefusalMessage(a)
      );
    }
  });

  it("the corpus covers every verdict (non-vacuity)", () => {
    const seen = new Set(
      CORPUS.map(([url, podUrl]) => {
        const v = shared.classifyEmbedUrl(url, { podUrl });
        return v.kind === "refused" ? v.reason : v.kind;
      })
    );
    expect([...seen].sort()).toEqual(
      [
        "website",
        "stored-file",
        "invalid",
        "scheme",
        "insecure",
        "own-pod",
      ].sort()
    );
  });
});
