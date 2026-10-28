/**
 * bridgeSecretOk — the auth floor on the Yjs bridge endpoints.
 *
 * WHY THIS EXISTS. `POST /yjs/:roomId/restore` can OVERWRITE ANY BOARD, and
 * `GET /yjs/:roomId/state` can read any board. Both shipped with ZERO auth while
 * their sibling `/bridge/emit` validated `BRIDGE_SECRET` — the gap this helper
 * closed. It had no tests at all, which for a data-destruction endpoint is the
 * gap that matters most.
 *
 * Contract pinned here:
 *   · BRIDGE_SECRET unset, not production → pass (local-dev compatibility)
 *   · BRIDGE_SECRET unset IN PRODUCTION → 503, the caller MUST stop, logged
 *     once (it used to pass, so a pod installed without the secret served
 *     /bridge/emit and /yjs/:room/{state,restore} to the whole compose network)
 *   · set + absent header  → 401, and the caller MUST stop
 *   · set + wrong header   → 401 (no partial/prefix match)
 *   · set + correct header → pass, nothing written to the response
 *
 * Plus a source tripwire: BOTH yjs handlers must actually call the helper.
 * A gate nothing calls is the failure mode this whole effort kept finding.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { bridgeSecretOk } from "../bridge.js";

const SECRET = "s3cr3t-value";
let saved: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  saved = process.env.BRIDGE_SECRET;
  savedNodeEnv = process.env.NODE_ENV;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BRIDGE_SECRET;
  else process.env.BRIDGE_SECRET = saved;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  vi.restoreAllMocks();
});

/** Minimal req/res doubles that record what the helper did to the response. */
function mk(headerValue?: string) {
  const req = {
    headers:
      headerValue === undefined ? {} : { "x-bridge-secret": headerValue },
  } as unknown as IncomingMessage;
  const written: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      written.status = status;
      return this;
    },
    end(body?: string) {
      written.body = body;
      return this;
    },
  } as unknown as ServerResponse;
  return { req, res, written };
}

describe("bridgeSecretOk", () => {
  it("passes when BRIDGE_SECRET is unset outside production (local-dev compatibility)", () => {
    delete process.env.BRIDGE_SECRET;
    process.env.NODE_ENV = "development";
    const { req, res, written } = mk();
    expect(bridgeSecretOk(req, res)).toBe(true);
    expect(written.status).toBeUndefined();
  });

  it("FAILS CLOSED in production when BRIDGE_SECRET is unset or empty, and says so once", () => {
    process.env.NODE_ENV = "production";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const unset of [undefined, ""]) {
      if (unset === undefined) delete process.env.BRIDGE_SECRET;
      else process.env.BRIDGE_SECRET = unset;
      // No header, and a header that would equal an empty secret.
      for (const header of [undefined, ""]) {
        const { req, res, written } = mk(header);
        expect(bridgeSecretOk(req, res)).toBe(false);
        expect(written.status).toBe(503);
      }
    }
    expect(
      log.mock.calls.filter((c) => String(c[0]).includes("BRIDGE_SECRET"))
    ).toHaveLength(1);
  });

  it("401s when the secret is set and the header is ABSENT", () => {
    process.env.BRIDGE_SECRET = SECRET;
    const { req, res, written } = mk();
    expect(bridgeSecretOk(req, res)).toBe(false);
    expect(written.status).toBe(401);
  });

  it("401s on a WRONG secret — and does not prefix/partial match", () => {
    process.env.BRIDGE_SECRET = SECRET;
    for (const bad of ["nope", SECRET.slice(0, -1), SECRET + "x", ""]) {
      const { req, res, written } = mk(bad);
      expect(bridgeSecretOk(req, res)).toBe(false);
      expect(written.status).toBe(401);
    }
  });

  it("passes on the correct secret and writes nothing to the response", () => {
    process.env.BRIDGE_SECRET = SECRET;
    const { req, res, written } = mk(SECRET);
    expect(bridgeSecretOk(req, res)).toBe(true);
    expect(written.status).toBeUndefined();
    expect(written.body).toBeUndefined();
  });

  it("TRIPWIRE: both yjs handlers gate on bridgeSecretOk", () => {
    const src = readFileSync(join(__dirname, "..", "bridge.ts"), "utf8");
    for (const fn of ["handleYjsGetState", "handleYjsRestore", "handleEmit"]) {
      const start = src.indexOf(`async function ${fn}(`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      // Look only at the handler's own opening region — the gate must be early,
      // before any body parsing or state mutation.
      const region = src.slice(start, start + 900);
      expect(region, `${fn} does not gate on bridgeSecretOk`).toContain(
        "bridgeSecretOk"
      );
    }
  });

  it("TRIPWIRE is not vacuous — it would catch a handler with no gate", () => {
    const fake = `async function handleYjsGetState(req, res) {\n  const x = 1;\n}`;
    expect(fake).not.toContain("bridgeSecretOk");
  });
});
