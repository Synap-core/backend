import { describe, it, expect, vi } from "vitest";

// @synap-core/core (the logger) validates config at import; nothing connects.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
});
import { checkAuthHealth } from "./pod-auth-status.js";
import { healthStatusFor, type DataHealth } from "./pod-data-status.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const DATA_OK: DataHealth = {
  status: "ok",
  initialized: true,
  hasUsers: true,
  checkedAt: NOW.toISOString(),
};

/** A fetch stub that records the URL and answers with `status` (or throws). */
const stub = (answer: number | Error) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  }) as unknown as typeof fetch;
  return { f, calls };
};
const base = {
  kratosPublicUrl: "http://kratos:4433/",
  now: () => NOW,
  log: () => {},
};

describe("/health authHealth (Kratos readiness)", () => {
  it("ready: Kratos /health/ready answers 200", async () => {
    const { f, calls } = stub(200);
    expect(await checkAuthHealth({ ...base, fetch: f })).toEqual({
      status: "ready",
      checkedAt: NOW.toISOString(),
    });
    expect(calls).toEqual(["http://kratos:4433/health/ready"]);
  });

  it("not_ready: Kratos answers 503 → degraded top-level, HTTP stays the route's 200", async () => {
    const { f } = stub(503);
    const a = await checkAuthHealth({ ...base, fetch: f });
    expect(a).toMatchObject({
      status: "not_ready",
      error: "Kratos is not ready",
    });
    expect(healthStatusFor(DATA_OK, a)).toBe("degraded");
  });

  it("not_ready: Kratos does not answer (crash-loop) — the raw error stays in the log", async () => {
    const logged: unknown[] = [];
    const { f } = stub(new Error("connect ECONNREFUSED 172.18.0.5:4433"));
    const a = await checkAuthHealth({
      ...base,
      fetch: f,
      log: (e) => logged.push(e),
    });
    expect(a).toEqual({
      status: "not_ready",
      checkedAt: NOW.toISOString(),
      error: "Kratos did not answer",
    });
    expect(JSON.stringify(a)).not.toContain("ECONNREFUSED");
    expect(logged).toHaveLength(1);
  });

  it("unknown: no Kratos (LOCAL_MODE) — never degraded, never 'ready'", async () => {
    const { f, calls } = stub(200);
    const a = await checkAuthHealth({
      ...base,
      kratosPublicUrl: null,
      fetch: f,
    });
    expect(a.status).toBe("unknown");
    expect(calls).toHaveLength(0);
    expect(healthStatusFor(DATA_OK, a)).toBe("ok");
  });

  it("healthStatusFor: ready or absent auth keeps the data rule", () => {
    expect(healthStatusFor(DATA_OK, { status: "ready" })).toBe("ok");
    expect(healthStatusFor(DATA_OK)).toBe("ok");
    expect(
      healthStatusFor({ ...DATA_OK, status: "empty" }, { status: "ready" })
    ).toBe("degraded");
  });
});
