/**
 * Socket.IO origin policy: the compose default FRONTEND_URL is not trusted in
 * production.
 *
 * The defect this pins: deploy/docker-compose.yml passes
 * `FRONTEND_URL: ${FRONTEND_URL:-http://localhost:3000}`, so on a pod nobody
 * configured the variable is SET, and the old check ("trust FRONTEND_URL when
 * set") trusted http://localhost:3000 on a credentialed socket in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock factories are hoisted above every top-level const: the mock fn must
// be hoisted with them, or the module fails to load.
const { findFirst } = vi.hoisted(() => ({
  findFirst: vi.fn(async () => null as null | { id: string }),
}));
vi.mock("@synap/database", () => ({
  db: { query: { federatedApplicationConnections: { findFirst } } },
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  arrayContains: (...a: unknown[]) => a,
  federatedApplicationConnections: { status: "status", allowedOrigins: "o" },
}));

import { isAllowedRealtimeOrigin } from "../realtime-origin.js";

beforeEach(() => {
  vi.stubEnv("SYNAP_BASE_DOMAIN", "");
  vi.stubEnv("ALLOWED_ORIGINS", "");
  vi.stubEnv("PUBLIC_URL", "");
  vi.stubEnv("POD_ADMIN_URL", "");
  findFirst.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("isAllowedRealtimeOrigin — FRONTEND_URL", () => {
  it("does NOT trust the compose default localhost:3000 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
    expect(await isAllowedRealtimeOrigin("http://localhost:3000")).toBe(false);
  });

  it("trusts the default outside production (local dev)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FRONTEND_URL", "http://localhost:3000");
    expect(await isAllowedRealtimeOrigin("http://localhost:3000")).toBe(true);
  });

  it("trusts a FRONTEND_URL that was really configured, in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FRONTEND_URL", "https://app.example.org");
    expect(await isAllowedRealtimeOrigin("https://app.example.org")).toBe(true);
    expect(await isAllowedRealtimeOrigin("http://localhost:3000")).toBe(false);
  });

  it("an unknown origin falls through to the approved-application lookup and is refused", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await isAllowedRealtimeOrigin("https://evil.example")).toBe(false);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("an opaque origin (the Desktop app's file:// renderer) and a native client still connect", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await isAllowedRealtimeOrigin("null")).toBe(true);
    expect(await isAllowedRealtimeOrigin(undefined)).toBe(true);
  });
});
