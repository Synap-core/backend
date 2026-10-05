/**
 * The global `requestSizeLimit` must let dictation audio reach its route.
 *
 * `/api/media/transcribe` accepts up to 25MB of audio and owns a tighter,
 * named refusal (`413 { code: "audio_too_large" }`). Mounted behind the
 * global 10MB default, every clip between 10MB and 25MB was refused FIRST by
 * this middleware with an un-coded 413 — the route's cap was unreachable.
 *
 * Driven through the real middleware with a declared Content-Length (the only
 * thing it reads). Negative control: drop the `/api/media/transcribe` clause
 * from `isBulkMedia` in `security.ts` — the 20MB case goes RED. Verified when
 * this was written.
 *
 * NOT covered: the route's own ceiling (see `media-transcribe.test.ts` in
 * packages/api), and a body sent without Content-Length (this middleware does
 * not see those at all).
 */

import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

// Same prime-then-import shape as `security.calendar-feed-ceiling.test.ts`:
// `security.ts` pulls the config package, which needs a database URL to load.
let requestSizeLimit: (typeof import("./security.js"))["requestSizeLimit"];

const MB = 1024 * 1024;

function makeApp() {
  const app = new Hono();
  app.use("*", requestSizeLimit);
  app.post("*", (c) => c.text("reached"));
  return app;
}

function post(app: Hono, path: string, bytes: number) {
  return app.request(path, {
    method: "POST",
    headers: { "content-length": String(bytes) },
    body: "x",
  });
}

describe("requestSizeLimit — dictation audio reaches its route", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ requestSizeLimit } = await import("./security.js"));
    // `security.ts` imports most of the API surface; under vitest that takes
    // ~10s — the default hook timeout, which skips every test silently.
  }, 120_000);

  it("a 20MB transcription upload passes the global ceiling", async () => {
    const res = await post(makeApp(), "/api/media/transcribe", 20 * MB);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("reached");
  });

  it("the same size elsewhere is still refused at 10MB (non-vacuity)", async () => {
    const res = await post(makeApp(), "/api/files/upload", 20 * MB);
    expect(res.status).toBe(413);
  });

  it("the exemption is still bounded", async () => {
    const res = await post(makeApp(), "/api/media/transcribe", 40 * MB);
    expect(res.status).toBe(413);
  });
});
