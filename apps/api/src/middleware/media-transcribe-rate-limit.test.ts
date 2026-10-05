/**
 * /api/media/transcribe is a paid Whisper call per POST. It shipped mounted
 * with no AI rate limit (chat had one), so any signed-in user could loop 25MB
 * uploads at the provider. Hono runs handlers in registration order, so the
 * limiter must be registered BEFORE the route mount or it never runs.
 *
 * Source-order guard: booting the full app here is out of reach (DB, Kratos).
 * It cannot see a limiter applied inside mediaTranscribeApp itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

describe("transcription route rate limit", () => {
  it("registers the AI limiter on /api/media/transcribe before mounting the route", () => {
    const limiter = src.indexOf('app.use("/api/media/transcribe", aiRateLimitMiddleware)');
    const mount = src.indexOf('app.route("/api/media", mediaTranscribeApp)');
    expect(mount).toBeGreaterThan(-1); // the scan still sees the mount
    expect(limiter).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(mount);
  });
});
