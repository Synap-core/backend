/**
 * The shared IS reachability probe.
 *
 * This is the only MEASURED input to intelligence status — every other field
 * in `/api/provision/status` is a cached DB row. It runs inside request
 * handlers that must still return a status, so its contract is: never throw,
 * always resolve, and never claim more than "the service answered".
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  probeIntelligenceService,
  clearIntelligenceProbeCache,
} from "./provision-intelligence-probe.js";

beforeEach(() => clearIntelligenceProbeCache());

const ok = () =>
  vi.fn().mockResolvedValue({ ok: true, status: 200 } as unknown as Response);

describe("probeIntelligenceService", () => {
  it("reports reachable with status and latency when the service answers", async () => {
    const res = await probeIntelligenceService("http://is:3001", {
      fetchImpl: ok(),
    });

    expect(res.reachable).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("probes /health on the resolved base URL", async () => {
    const fetchImpl = ok();
    await probeIntelligenceService("http://is:3001", { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://is:3001/health");
  });

  it("a NON-OK response is not reachable, but still reports its status", async () => {
    // A 503 means something is listening but not serving. Callers need both
    // facts: do not collapse them.
    const res = await probeIntelligenceService("http://is:3001", {
      fetchImpl: vi
        .fn()
        .mockResolvedValue({ ok: false, status: 503 } as unknown as Response),
    });

    expect(res.reachable).toBe(false);
    expect(res.httpStatus).toBe(503);
  });

  it("NEVER throws when the network fails — unreachable is a result", async () => {
    // This runs inside `/api/provision/status`. A throw here would turn a
    // degraded IS into a 500 on the endpoint that exists to report it.
    const res = await probeIntelligenceService("http://is:3001", {
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    expect(res.reachable).toBe(false);
    expect(res.error).toBe("unreachable");
  });

  it("distinguishes a timeout from a refusal", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const res = await probeIntelligenceService("http://is:3001", {
      fetchImpl: vi.fn().mockRejectedValue(abortErr),
    });

    expect(res.reachable).toBe(false);
    expect(res.error).toBe("timeout");
  });

  it("a null URL is 'no_url', not a fabricated failure", async () => {
    const fetchImpl = ok();
    const res = await probeIntelligenceService(null, { fetchImpl });

    expect(res).toEqual({ reachable: false, error: "no_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("memoises so a polled /status cannot hammer the service", async () => {
    const fetchImpl = ok();
    await probeIntelligenceService("http://is:3001", { fetchImpl });
    await probeIntelligenceService("http://is:3001", { fetchImpl });
    await probeIntelligenceService("http://is:3001", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("noCache forces a fresh probe — diagnostics must reflect NOW", async () => {
    const fetchImpl = ok();
    await probeIntelligenceService("http://is:3001", { fetchImpl });
    await probeIntelligenceService("http://is:3001", {
      fetchImpl,
      noCache: true,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caches per URL, so two services never share a verdict", async () => {
    const fetchImpl = ok();
    await probeIntelligenceService("http://a:3001", { fetchImpl });
    await probeIntelligenceService("http://b:3001", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
