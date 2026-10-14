/**
 * ONE merged request write context: every entry COMPOSES with the store it is
 * nested in. An MCP request made with a HUB_TEST key AND a derived session must
 * carry BOTH facts to the floors — a `run` that replaced the store would drop
 * the outer one silently (probe writes stop being marked, or a guessed session
 * starts placing projects again).
 *
 * Driven through the real entry functions and accessors; async boundaries
 * inside each scope, since that is how the floors actually read it.
 */
import { describe, it, expect } from "vitest";
import {
  runWithProbeWrites,
  isProbeWriteContext,
  runWithDerivedSession,
  getDerivedSessionId,
  clientKeyForApiKey,
  requestConversationId,
  runWithClientKey,
  getRequestClientKey,
  getRequestConversationCwd,
  conversationCwdPatch,
} from "./request-write-context.js";

const S = "11111111-1111-4111-8111-111111111111";
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("request write context — nested entries compose", () => {
  it("derived INSIDE probe keeps both fields", async () => {
    const seen = await runWithProbeWrites(true, () =>
      runWithDerivedSession(S, async () => {
        await tick();
        return { probe: isProbeWriteContext(), derived: getDerivedSessionId() };
      })
    );
    expect(seen).toEqual({ probe: true, derived: S });
  });

  it("probe INSIDE derived keeps both fields", async () => {
    const seen = await runWithDerivedSession(S, () =>
      runWithProbeWrites(true, async () => {
        await tick();
        return { probe: isProbeWriteContext(), derived: getDerivedSessionId() };
      })
    );
    expect(seen).toEqual({ probe: true, derived: S });
  });

  it("outside any scope nothing leaks", async () => {
    await runWithDerivedSession(S, async () => tick());
    expect(getDerivedSessionId()).toBeUndefined();
    expect(isProbeWriteContext()).toBe(false);
  });
});

// A local agent names its OWN conversation (`X-Synap-Conversation`) — the id a
// person can reopen. Rows where a looser rule disagrees: the transport id
// winning over the client's own id (writes keep the unreopenable id), a cwd
// stamped onto a client key that is not this request's (a caller passing
// someone else's key), and a control-character cwd.
describe("request write context — the client's own conversation", () => {
  const CC = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

  it("the client's own id outranks the MCP transport id", () => {
    expect(requestConversationId(CC, "pod-minted-transport-id")).toBe(CC);
    expect(requestConversationId(undefined, "pod-minted")).toBe("pod-minted");
    expect(requestConversationId("  ", "pod-minted")).toBe("pod-minted");
    expect(
      clientKeyForApiKey({ id: "k1" }, requestConversationId(CC, "t"))
    ).toBe(`key:k1|conv:${CC}`);
  });

  it("the cwd rides with the client key and stamps only that key", async () => {
    const key = clientKeyForApiKey({ id: "k1" }, CC)!;
    const seen = await runWithClientKey(
      key,
      async () => {
        await tick();
        return {
          key: getRequestClientKey(),
          cwd: getRequestConversationCwd(),
          own: conversationCwdPatch(key),
          other: conversationCwdPatch("key:k2|conv:x"),
        };
      },
      "/Users/a/code/synap"
    );
    expect(seen).toEqual({
      key,
      cwd: "/Users/a/code/synap",
      own: { conversationCwd: "/Users/a/code/synap" },
      other: {},
    });
  });

  it("an unusable cwd is dropped, never stored", () => {
    const key = "key:k1|conv:x";
    expect(
      runWithClientKey(key, () => getRequestConversationCwd(), "/a\nb")
    ).toBeUndefined();
    expect(
      runWithClientKey(undefined, () => getRequestConversationCwd(), "/a")
    ).toBeUndefined();
  });
});
