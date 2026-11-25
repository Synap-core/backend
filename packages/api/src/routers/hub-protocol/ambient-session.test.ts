/**
 * Which session a document question may be filed on: the one the request
 * VERIFIABLY runs in. `getCaller` sets it from the middleware-verified
 * `X-Session-Id` only; a `sessionId` named in a REST body is provenance.
 * The real `getCaller` and `createHubProtocolCallerContext` run; only the
 * router the caller is made from is replaced by one that returns its ctx.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("./index.js", () => ({
  hubProtocolRouter: { createCaller: (ctx: unknown) => ctx },
}));

import { ambientSessionOf } from "./utils.js";
import { getCaller } from "./rest/_shared.js";

const VERIFIED = "6f1c2b0e-0a52-4c4e-9d33-2d6c0f6d9a11";
const NAMED = "0a0a0a0a-0a52-4c4e-9d33-2d6c0f6d9a11";

/** A Hono context as the auth + session middleware leave it. */
const honoContext = (verifiedSessionId?: string) => {
  const values: Record<string, unknown> = {
    userId: "user-1",
    scopes: ["hub-protocol.write"],
    ...(verifiedSessionId ? { sessionId: verifiedSessionId } : {}),
  };
  return { get: (key: string) => values[key] };
};

describe("ambientSessionOf", () => {
  it("no ambient key: the ctx's own session is the verified one (MCP callers)", () => {
    expect(ambientSessionOf({ sessionId: VERIFIED })).toBe(VERIFIED);
    expect(ambientSessionOf({})).toBeNull();
  });

  it("an ambient key that is null means NO verified session, whatever sessionId says", () => {
    expect(
      ambientSessionOf({ sessionId: NAMED, ambientSessionId: null })
    ).toBeNull();
  });

  it("an ambient key with an id is that id", () => {
    expect(
      ambientSessionOf({ sessionId: NAMED, ambientSessionId: VERIFIED })
    ).toBe(VERIFIED);
  });
});

describe("getCaller — the ambient session is the header's, never the body's", () => {
  it("a body-named sessionId and NO verified header: provenance only, ambient is null", async () => {
    const ctx = (await getCaller(honoContext(), {
      sessionId: NAMED,
    })) as unknown as { sessionId: string; ambientSessionId: string | null };
    expect(ctx.sessionId).toBe(NAMED);
    expect(ctx.ambientSessionId).toBeNull();
    expect(ambientSessionOf(ctx)).toBeNull();
  });

  it("the verified header is the ambient session, even when the body names another", async () => {
    const ctx = (await getCaller(honoContext(VERIFIED), {
      sessionId: NAMED,
    })) as unknown as { sessionId: string; ambientSessionId: string | null };
    expect(ctx.sessionId).toBe(NAMED);
    expect(ctx.ambientSessionId).toBe(VERIFIED);
    expect(ambientSessionOf(ctx)).toBe(VERIFIED);
  });
});
