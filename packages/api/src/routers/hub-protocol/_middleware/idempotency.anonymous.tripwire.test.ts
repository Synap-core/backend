/**
 * TRIPWIRE — the idempotency cache never serves one anonymous caller another's
 * response (Sites W3, B2 guard G10).
 *
 * The cache key is partitioned by `userId`. A request with NO principal used to
 * fall into one shared `"anonymous"` partition, so two strangers sending the
 * same Idempotency-Key + body (a public form, a pending-agent review POST) got
 * each other's 2xx. The fix is structural — no principal ⇒ no cache — so it is
 * tested on an ARBITRARY path that is in no skip list, plus the public-door
 * namespace, with a positive control that a real principal is still cached.
 *
 * Negative control: in `idempotency.ts`, drop the `!principal ||` condition —
 * "two anonymous callers" must go RED on the arbitrary path.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetIdempotencyStoreForTests,
  idempotencyMiddleware,
} from "./idempotency.js";

beforeEach(() => {
  __resetIdempotencyStoreForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const KEY = "shared-key-123456789";
const BODY = JSON.stringify({ email: "same@example.test" });

function buildApp(principal: string | null) {
  const app = new Hono<{ Variables: { userId: string } }>();
  if (principal) {
    app.use("*", async (c, next) => {
      c.set("userId", principal);
      await next();
    });
  }
  app.use("*", idempotencyMiddleware({ skipPaths: [] }));
  let n = 0;
  const handler = (c: { json: (v: unknown) => Response }) =>
    c.json({ caller: (n += 1) });
  app.post("/api/hub/some/unauthenticated/door", handler as never);
  app.post("/api/hub/public/forms/tok-abc/submissions", handler as never);
  return app;
}

async function post(app: ReturnType<typeof buildApp>, path: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": KEY },
    body: BODY,
  });
  return {
    replay: res.headers.get("X-Idempotent-Replay"),
    body: await res.json(),
  };
}

describe("idempotency — no principal, no shared cache", () => {
  for (const path of [
    "/api/hub/some/unauthenticated/door",
    "/api/hub/public/forms/tok-abc/submissions",
  ]) {
    it(`two anonymous callers are each served their own response (${path})`, async () => {
      const app = buildApp(null);
      const first = await post(app, path);
      const second = await post(app, path);
      expect(second.replay).toBeNull();
      expect(second.body).not.toEqual(first.body);
    });
  }

  it("positive control: an authenticated caller IS still replayed", async () => {
    const app = buildApp("user-1");
    const path = "/api/hub/some/unauthenticated/door";
    const first = await post(app, path);
    const second = await post(app, path);
    expect(second.replay).toBe("true");
    expect(second.body).toEqual(first.body);
  });

  it("a principal never reaches the public namespace's cache either", async () => {
    const app = buildApp("user-1");
    const path = "/api/hub/public/forms/tok-abc/submissions";
    await post(app, path);
    const second = await post(app, path);
    expect(second.replay).toBeNull();
  });
});
