/**
 * The event-loop watch, against the incident it exists for (2026-11-03): one
 * request held the loop for seconds, and nothing named it.
 *
 * Pinned:
 *   - a handler that busy-loops is NAMED in ONE `event loop blocked` line,
 *     through the REAL usage middleware (the seam `index.ts` mounts), with the
 *     key id its key-auth door set, and WITHOUT its query string — even though
 *     it finished inside the stall, before the late tick could run;
 *   - a request that started after the block is not blamed; a tick on time
 *     logs nothing;
 *   - a histogram that cannot be read is `unavailable`, an empty one `empty`:
 *     never a 0;
 *   - every knob reaches a deployed pod (compose + env.schema).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { runWithCallingKey } from "@synap/database";
import {
  EVENT_LOOP_WATCH_KEYS,
  createEventLoopWatch,
  eventLoopWatchConfig,
} from "./event-loop-watch.js";

let createUsageTelemetry: typeof import("../middleware/usage-telemetry.js").createUsageTelemetry;

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  ({ createUsageTelemetry } = await import("../middleware/usage-telemetry.js"));
});

type Line = { fields: Record<string, unknown>; msg: string };

function busy(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // the 126 MB video, parsed as markdown
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a blocked event loop names the request that blocked it", () => {
  it("logs ONE line naming the busy route, its key, and no query string", async () => {
    const lines: Line[] = [];
    const watch = createEventLoopWatch({
      config: { stallMs: 200, tickMs: 50, windowMs: 60_000 },
      warn: (fields, msg) => lines.push({ fields, msg }),
    });
    const telemetry = createUsageTelemetry({
      flush: async () => {},
      inFlight: watch,
    });
    const app = new Hono();
    app.use("*", telemetry.middleware);
    app.get("/api/hub/documents/:id/content", (c) =>
      runWithCallingKey("key-video-reader", () => {
        busy(500);
        return c.json({ ok: true });
      })
    );
    app.get("/api/hub/fast", (c) => c.json({ ok: true }));

    watch.start();
    try {
      await sleep(80); // a tick on time: nothing
      expect(lines).toEqual([]);
      const res = await app.request(
        "/api/hub/documents/doc-1/content?token=hunter2&q=secret",
        { headers: { Authorization: "Bearer sk-not-logged" } }
      );
      expect(res.status).toBe(200);
      await sleep(120); // the late tick runs
    } finally {
      watch.stop();
      telemetry.stop();
    }

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.msg).toBe("event loop blocked");
    expect(line.fields.blockedMs as number).toBeGreaterThan(200);
    const requests = line.fields.requests as Array<Record<string, unknown>>;
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/api/hub/documents/doc-1/content",
      ended: true,
      apiKeyId: "key-video-reader",
    });
    expect(requests[0].runningMs as number).toBeGreaterThanOrEqual(450);
    const logged = JSON.stringify(line.fields);
    expect(logged).not.toMatch(/hunter2|secret|\?|sk-not-logged/);

    // /status/release's details carry the named requests; /health's numbers do not.
    expect(watch.snapshot({ named: true }).stalls.count).toBe(1);
    expect(
      watch.snapshot({ named: true }).stalls.last?.requests?.[0]?.path
    ).toBe("/api/hub/documents/doc-1/content");
    expect(watch.snapshot().stalls.last).not.toHaveProperty("requests");
  });

  it("with its own clock: blames what ran across the stall, not what came after", () => {
    let clock = 1_000_000;
    const lines: Line[] = [];
    const watch = createEventLoopWatch({
      config: { stallMs: 2_000, tickMs: 500, windowMs: 60_000 },
      warn: (fields, msg) => lines.push({ fields, msg }),
      now: () => clock,
      redactPath: (p) => p.replace(/\/feed\/[^/]+/, "/feed/[redacted]"),
    });
    watch.start();
    try {
      clock += 500;
      watch.tick(); // on time
      expect(lines).toEqual([]);

      const longPoll = watch.begin("GET", "/api/hub/wait", undefined, {
        get: (k) => (k === "agentUserId" ? "agent-7" : undefined),
      });
      clock += 100;
      const culprit = watch.begin("GET", "/calendar/feed/tok123.ics");
      clock += 5_000; // the loop is held
      watch.end(culprit); // it returns inside the stall
      const after = watch.begin("POST", "/api/hub/after"); // arrived after
      watch.tick();

      expect(lines).toHaveLength(1);
      const fields = lines[0].fields;
      expect(fields.blockedMs).toBe(4_600);
      expect(fields.inFlight).toBe(2);
      expect(fields.requests).toEqual([
        {
          method: "GET",
          path: "/api/hub/wait",
          runningMs: 5_100,
          ended: false,
          agentUserId: "agent-7",
        },
        {
          method: "GET",
          path: "/calendar/feed/[redacted]",
          runningMs: 5_000,
          ended: true,
        },
      ]);
      watch.end(longPoll);
      watch.end(after);
    } finally {
      watch.stop();
    }
  });

  it("an unreadable histogram is unavailable and an empty one is empty, never 0", () => {
    const broken = createEventLoopWatch({
      config: { stallMs: 2_000, tickMs: 500, windowMs: 60_000 },
      warn: () => {},
      histogram: () => {
        throw new Error("perf_hooks unavailable");
      },
      utilization: () => {
        throw new Error("no elu");
      },
    });
    expect(broken.snapshot().delay).toEqual({
      state: "unavailable",
      reason: "the watch has not started",
    });
    broken.start();
    expect(broken.snapshot().delay).toEqual({
      state: "unavailable",
      reason: "perf_hooks unavailable",
    });
    expect(broken.snapshot().utilization).toEqual({
      state: "unavailable",
      reason: "no elu",
    });
    broken.stop();

    const fresh = createEventLoopWatch({
      config: { stallMs: 2_000, tickMs: 500, windowMs: 60_000 },
      warn: () => {},
    });
    fresh.start();
    try {
      expect(fresh.snapshot().delay.state).toBe("empty");
    } finally {
      fresh.stop();
    }
  });

  it("reads its knobs with the envInt rule", () => {
    expect(eventLoopWatchConfig({})).toEqual({
      stallMs: 2_000,
      tickMs: 500,
      windowMs: 60_000,
    });
    expect(
      eventLoopWatchConfig({
        SYNAP_EVENT_LOOP_STALL_MS: "5000",
        SYNAP_EVENT_LOOP_TICK_MS: "10", // below the floor: a typo
        SYNAP_EVENT_LOOP_WINDOW_MS: "abc",
      })
    ).toEqual({ stallMs: 5_000, tickMs: 500, windowMs: 60_000 });
  });

  it("every knob reaches a deployed pod", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const compose = readFileSync(root + "deploy/docker-compose.yml", "utf8");
    const schema = new Set(
      readFileSync(root + "deploy/env.schema", "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
        .map((l) => l.trim().split(/\s+/)[0])
    );
    expect(EVENT_LOOP_WATCH_KEYS.length).toBe(3);
    for (const k of EVENT_LOOP_WATCH_KEYS) {
      expect(compose).toContain(`${k}: \${${k}:-}`);
      expect(schema.has(k)).toBe(true);
    }
  });
});
