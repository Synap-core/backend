/**
 * D4 seam — the pod→IS request carries the per-turn delegation, and the
 * delegation names the operator the CALLER resolved (the TurnPrincipal it
 * passed as `userId`), with `aud` = the IS it is sent to.
 *
 * Driven from the real clients with a real key file, down to the bytes handed
 * to `fetch`; the token is then verified by the real door. The tripwire
 * `is-work-carries-delegation` sees only that a file CALLS the minter — this
 * pins that the header actually leaves on the wire.
 */

import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IS_DELEGATION_HEADER,
  verifyIsDelegationToken,
} from "@synap/database/is-delegation";

import { IntelligenceHubClient } from "./intelligence-hub-client.js";
import {
  requestHeadlessChatText,
  requestTaskExecute,
} from "./is-headless-transport.js";

const IS = "http://is.local";
const dir = mkdtempSync(path.join(tmpdir(), "is-delegation-seam-"));
const saved = {
  file: process.env.SYNAP_POD_IDENTITY_KEY_FILE,
  url: process.env.PUBLIC_URL,
};

beforeEach(() => {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const file = path.join(dir, `k-${crypto.randomUUID()}.pem`);
  writeFileSync(
    file,
    privateKey.export({ format: "pem", type: "pkcs8" }) as string
  );
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = file;
  // A new file path per test: the door re-reads the key when the path changes.
  process.env.PUBLIC_URL = "https://pod.example.test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (saved.file === undefined) delete process.env.SYNAP_POD_IDENTITY_KEY_FILE;
  else process.env.SYNAP_POD_IDENTITY_KEY_FILE = saved.file;
  if (saved.url === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = saved.url;
});

/** Captures the headers of the first fetch, then stops the call. */
function captureHeaders(): () => Record<string, string> {
  let headers: Record<string, string> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        headers = init?.headers ?? {};
        throw new Error("stop after capture");
      }
    )
  );
  return () => headers;
}

async function delegationOf(headers: Record<string, string>) {
  const token = headers[IS_DELEGATION_HEADER];
  expect(token, "no delegation header on the IS request").toBeTruthy();
  return verifyIsDelegationToken(token, {
    isKnownAudience: (aud) => aud === IS,
  });
}

describe("pod→IS requests carry the turn's delegation", () => {
  it("interactive chat stream: sub = request.userId, act = agentUserId, channel = threadId", async () => {
    const sent = captureHeaders();
    const stream = new IntelligenceHubClient(IS, "key").sendMessageStream({
      query: "hi",
      threadId: "channel-1",
      userId: "summoner-1",
      agentUserId: "agent-1",
    } as never);
    await expect(stream.next()).rejects.toThrow();
    expect(await delegationOf(sent())).toMatchObject({
      operatorUserId: "summoner-1",
      agentUserId: "agent-1",
      channelId: "channel-1",
      audience: IS,
    });
  });

  it("headless chat turn (a2ai)", async () => {
    const sent = captureHeaders();
    await expect(
      requestHeadlessChatText(IS, "key", {
        query: "hi",
        threadId: "channel-2",
        userId: "owner-1",
        agentType: "meta",
        sourceMessageId: "m-1",
      })
    ).rejects.toThrow();
    expect(await delegationOf(sent())).toMatchObject({
      operatorUserId: "owner-1",
      channelId: "channel-2",
    });
  });

  it("headless task execute (automation command step)", async () => {
    const sent = captureHeaders();
    await expect(
      requestTaskExecute(IS, "key", {
        taskId: "task-1",
        action: "run",
        context: {},
        userId: "owner-2",
        workspaceId: "ws-1",
      })
    ).rejects.toThrow();
    expect(await delegationOf(sent())).toMatchObject({
      operatorUserId: "owner-2",
      runId: "task-1",
    });
  });
});
