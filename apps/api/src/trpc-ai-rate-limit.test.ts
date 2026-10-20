/**
 * The AI rate limit on main `/trpc` counts every batched AI procedure (W0).
 *
 * It was mounted on the EXACT paths `/trpc/chat.sendMessage` and
 * `/trpc/channels.sendMessage`. tRPC 11 batches by default and splits a batch
 * path on ",", so `/trpc/health.check,chat.sendMessage?batch=1` (or the same
 * AI procedure repeated N times in one batch) ran paid AI turns with no AI
 * limit at all.
 *
 * Driven with the REAL `hono-rate-limiter` (same library as
 * `aiRateLimitMiddleware`, a small limit and a fixed key so the test is
 * deterministic) behind the wrapper index.ts mounts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { describe, expect, it } from "vitest";

import { trpcAiRateLimit } from "./trpc-ai-rate-limit.js";
import { stripComments } from "../../../scripts/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIMIT = 2;

function makeApp() {
  const limiter = rateLimiter({
    windowMs: 60_000,
    limit: LIMIT,
    keyGenerator: () => "one-caller",
    handler: (c) => c.json({ error: "Too many AI requests" }, 429),
  });
  let ran = 0;
  const app = new Hono();
  app.use("/trpc/*", trpcAiRateLimit(limiter));
  app.use("/trpc/*", (c) => {
    ran++;
    return c.json({ ok: true });
  });
  return { app, ran: () => ran };
}

const post = (app: Hono, url: string) => app.request(url, { method: "POST" });

describe("main /trpc AI rate limit — batch paths", () => {
  it("an AI procedure hidden in a batch is limited", async () => {
    const { app } = makeApp();
    const url = "/trpc/health.check,chat.sendMessage?batch=1";
    for (let i = 0; i < LIMIT; i++) {
      expect((await post(app, url)).status).toBe(200);
    }
    expect((await post(app, url)).status).toBe(429);
  });

  it("each batched AI procedure counts — N copies in one batch cost N", async () => {
    const { app, ran } = makeApp();
    const res = await post(
      app,
      "/trpc/chat.sendMessage,channels.sendMessage,chat.sendMessage?batch=1"
    );
    expect(res.status).toBe(429);
    expect(ran()).toBe(0);
  });

  it("a batch within the budget runs, and uses it up", async () => {
    const { app } = makeApp();
    const both = "/trpc/chat.sendMessage,channels.sendMessage?batch=1";
    expect((await post(app, both)).status).toBe(200);
    expect((await post(app, "/trpc/chat.sendMessage")).status).toBe(429);
  });

  it("CONTROL — a single AI call is limited after the budget", async () => {
    const { app } = makeApp();
    for (let i = 0; i < LIMIT; i++) {
      expect((await post(app, "/trpc/channels.sendMessage")).status).toBe(200);
    }
    expect((await post(app, "/trpc/channels.sendMessage")).status).toBe(429);
  });

  it("CONTROL — non-AI procedures never touch the AI budget", async () => {
    const { app } = makeApp();
    for (let i = 0; i < LIMIT + 3; i++) {
      expect(
        (await post(app, "/trpc/health.check,entities.list?batch=1")).status
      ).toBe(200);
    }
    expect((await post(app, "/trpc/chat.sendMessage")).status).toBe(200);
  });
});

describe("index.ts mounts the AI limit through the ONE wrapper", () => {
  const src = stripComments(
    readFileSync(path.join(HERE, "index.ts"), "utf8"),
    "ts"
  ) as string;

  it("uses trpcAiRateLimit(aiRateLimitMiddleware) on /trpc/*", () => {
    expect(src).toContain(
      'app.use("/trpc/*", trpcAiRateLimit(aiRateLimitMiddleware))'
    );
  });

  it("has no exact-path AI mount left", () => {
    expect(src).not.toMatch(
      /app\.use\(\s*["']\/trpc\/[a-zA-Z]+\.[a-zA-Z]+["']/
    );
  });
});
