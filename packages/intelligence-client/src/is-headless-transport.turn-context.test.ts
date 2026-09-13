/**
 * The headless body carries `turnContext` — the seam between the a2ai worker
 * (which receives a comment's resolved anchor) and the IS `/api/chat/stream`.
 * The worker test mocks this transport, so without this pin the field could be
 * dropped here while every worker assertion stays green.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHeadlessChatText } from "./is-headless-transport.js";

const base = {
  query: "this is a transition",
  threadId: "channel-1",
  userId: "user-1",
  agentType: "meta",
  sourceMessageId: "message-1",
};

async function capturedBody(payload: Record<string, unknown>) {
  let body: string | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: string }) => {
      body = init?.body;
      throw new Error("stop after capture");
    })
  );
  await expect(
    requestHeadlessChatText("http://is.local", "key", { ...base, ...payload })
  ).rejects.toThrow();
  return JSON.parse(body ?? "{}") as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("requestHeadlessChatText turnContext", () => {
  it("forwards turnContext verbatim in the IS body", async () => {
    const turnContext = {
      anchor: { version: 1, proposalId: "p-1", stale: false },
    };
    expect((await capturedBody({ turnContext })).turnContext).toEqual(
      turnContext
    );
  });

  it("omits the key when there is no turn context", async () => {
    expect(await capturedBody({})).not.toHaveProperty("turnContext");
  });
});
