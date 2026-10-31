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
  clientKeyScope,
  isPerCallClientKey,
  requestConversationId,
  runWithClientKey,
  getRequestClientKey,
  getRequestConversationCwd,
  conversationCwdPatch,
  parseProcessIdentity,
  getRequestProcess,
  parseRunnerState,
  getRequestRunnerState,
  RUNNER_STATES,
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
    expect(
      requestConversationId(CC, undefined, "pod-minted-transport-id")
    ).toBe(CC);
    expect(requestConversationId(undefined, undefined, "pod-minted")).toBe(
      "pod-minted"
    );
    expect(requestConversationId("  ", undefined, "pod-minted")).toBe(
      "pod-minted"
    );
    expect(
      clientKeyForApiKey({ id: "k1" }, requestConversationId(CC, "m", "t"))
    ).toBe(`key:k1|conv:${CC}`);
  });

  // C.8 Q2: the header is set by our own transport code, `_meta` by anything
  // that builds the request body — the header wins when both are sent.
  it("rungs: header › _meta live.synap/conversation › Mcp-Session-Id", () => {
    expect(requestConversationId("hdr", "meta", "transport")).toBe("hdr");
    expect(requestConversationId(undefined, "meta", "transport")).toBe("meta");
    expect(requestConversationId(null, "bad id", "transport")).toBe(
      "transport"
    );
    expect(requestConversationId(undefined, undefined, undefined)).toBe(
      undefined
    );
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

// D1 (founder 2026-10-23): a request that names no conversation is its OWN
// run — `key:<id>|call:<uuid>`, fresh per request. It used to be `key:<id>`,
// one client for every routine on the key (two ran in the same minute live).
describe("request write context — the per-call run", () => {
  const CC = "claude-code:8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

  it("no conversation ⇒ a fresh per-call run, distinct per request", () => {
    const a = clientKeyForApiKey({ id: "k1" })!;
    const b = clientKeyForApiKey({ id: "k1" }, "bad id")!;
    expect(a).toMatch(/^key:k1\|call:[0-9a-f-]{36}$/);
    expect(b).toMatch(/^key:k1\|call:[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
    expect(isPerCallClientKey(a)).toBe(true);
    expect(isPerCallClientKey(`key:k1|conv:${CC}`)).toBe(false);
  });

  it("a per-call run scopes as ONE run (conversation), never as the key", () => {
    expect(clientKeyScope(clientKeyForApiKey({ id: "k1" })!)).toBe(
      "conversation"
    );
    expect(clientKeyScope(`agent:a1|call:${CC}`)).toBe("conversation");
  });

  // TRIPWIRE: KEY scope (option A) is reachable only from the `agent:<id>`
  // fallback (jobs, no request) and from legacy `key:<id>` rows — never from a
  // value a key-auth door mints today, whatever the request carried.
  it("no input to the key-auth door yields KEY scope", () => {
    for (const conv of [
      undefined,
      null,
      "",
      "  ",
      "bad id",
      "x".repeat(200),
      "c",
    ]) {
      const key = clientKeyForApiKey(
        { id: "k1", keyType: "hub_inbound" },
        conv
      );
      expect(key && clientKeyScope(key)).toBe("conversation");
    }
    expect(clientKeyScope("agent:a1")).toBe("key");
    expect(clientKeyScope("key:k1")).toBe("key");
  });
});

// W-A4: the IS is one client for every channel, so its key alone is never a
// client (a channel turn groups by `channel:<id>`). A NON-channel IS run names
// itself (`X-Synap-Conversation: is:<runId>`) and is then its own client — not
// the `agent:<id>` fallback that pooled every keyless IS write of an agent.
describe("request write context — an IS run names itself", () => {
  const RUN = "is:5b0f1e2a-9c4d-4e8f-8a1b-2c3d4e5f6a7b";

  it("a named IS run ⇒ `is:<id>|conv:<run>`, ONE run (conversation scope)", () => {
    const key = clientKeyForApiKey(
      { id: "is-key", keyType: "is_internal" },
      RUN
    );
    expect(key).toBe(`is:is-key|conv:${RUN}`);
    expect(clientKeyScope(key!)).toBe("conversation");
    // Never a per-call run, never an external `key:` client.
    expect(isPerCallClientKey(key!)).toBe(false);
    expect(key!.startsWith("key:")).toBe(false);
  });

  it("two IS runs are two clients; the header wins as for any client", () => {
    const other = "is:0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a";
    expect(
      clientKeyForApiKey(
        { id: "is-key", keyType: "is_internal" },
        requestConversationId(RUN, "meta-run", "transport")
      )
    ).toBe(`is:is-key|conv:${RUN}`);
    expect(
      clientKeyForApiKey({ id: "is-key", keyType: "is_internal" }, other)
    ).not.toBe(
      clientKeyForApiKey({ id: "is-key", keyType: "is_internal" }, RUN)
    );
  });

  it("an unnamed IS request stays unscoped (it groups by its channel)", () => {
    for (const conv of [undefined, null, "", "bad id"])
      expect(
        clientKeyForApiKey({ id: "is-key", keyType: "is_internal" }, conv)
      ).toBeUndefined();
  });
});

describe("the calling process (0373)", () => {
  it("parses <host>:<pid>:<startedAtMs>, host lower-cased; anything else is unusable", () => {
    expect(parseProcessIdentity("Mac-A.local:4242:1761600000000")).toEqual({
      key: "mac-a.local:4242:1761600000000",
      host: "mac-a.local",
      pid: 4242,
      startedAt: new Date(1761600000000),
    });
    for (const bad of [
      "",
      undefined,
      "mac:4242",
      "mac:x:1761600000000",
      "mac:1:12",
      "a b:1:1761600000000",
      "x".repeat(300) + ":1:1761600000000",
    ])
      expect(parseProcessIdentity(bad)).toBeUndefined();
  });

  it("rides with a client key, composes with the cwd, and enters no scope without a key", async () => {
    const seen = await runWithClientKey(
      "key:k|conv:claude-code:c",
      async () => {
        await tick();
        return {
          p: getRequestProcess()?.host,
          cwd: getRequestConversationCwd(),
        };
      },
      "/work",
      "devbox:7:1761650000000"
    );
    expect(seen).toEqual({ p: "devbox", cwd: "/work" });
    expect(
      runWithClientKey(
        undefined,
        () => getRequestProcess(),
        "/w",
        "d:7:1761650000000"
      )
    ).toBeUndefined();
  });
});

describe("the runner state (0384)", () => {
  it("knows exactly busy, idle, needs_permission and ended, case and spaces folded; anything else is none", () => {
    expect([...RUNNER_STATES]).toEqual([
      "busy",
      "idle",
      "needs_permission",
      "ended",
    ]);
    for (const s of RUNNER_STATES) expect(parseRunnerState(s)).toBe(s);
    expect(parseRunnerState(" Needs_Permission ")).toBe("needs_permission");
    for (const bad of [
      undefined,
      null,
      "",
      "working",
      "needs-permission",
      "busy,idle",
    ])
      expect(parseRunnerState(bad)).toBeUndefined();
  });

  it("rides with a client key, stamped with when the pod heard it; no key or no known state enters nothing", async () => {
    const before = Date.now();
    const seen = await runWithClientKey(
      "key:k|conv:claude-code:c",
      async () => {
        await tick();
        return { rs: getRequestRunnerState(), p: getRequestProcess()?.host };
      },
      "/work",
      "devbox:7:1761650000000",
      "needs_permission"
    );
    expect(seen.p).toBe("devbox");
    expect(seen.rs?.state).toBe("needs_permission");
    expect(seen.rs!.reportedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(
      runWithClientKey(
        undefined,
        () => getRequestRunnerState(),
        null,
        null,
        "busy"
      )
    ).toBeUndefined();
    expect(
      runWithClientKey(
        "key:k|conv:claude-code:c",
        () => getRequestRunnerState(),
        null,
        null,
        "asleep"
      )
    ).toBeUndefined();
  });
});
