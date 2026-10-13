/**
 * Rows are the inputs where a looser rule would DISAGREE: a pod-minted MCP
 * transport id (hosted chat app — must NOT become a door), a key-scoped client
 * (no conversation), a harness prefix with a non-UUID id (a hostile value must
 * never reach a copyable shell command), and upper-case UUIDs (normalized).
 */
import { describe, expect, it } from "vitest";
import {
  conversationOfClientKey,
  resolveAgentConversation,
} from "./conversation.js";

const ID = "8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

describe("resolveAgentConversation", () => {
  it("a Claude Code conversation is a door: resume command + cwd", () => {
    expect(
      resolveAgentConversation({
        clientKey: `key:abc|conv:claude-code:${ID}`,
        conversationCwd: "/Users/a/code/synap",
      })
    ).toEqual({
      harness: "claude-code",
      conversationId: ID,
      cwd: "/Users/a/code/synap",
      resumeCommand: `claude --resume ${ID}`,
    });
  });

  it("a pod-minted MCP transport id (hosted chat app) is not a door", () => {
    expect(
      resolveAgentConversation({ clientKey: `key:abc|conv:${ID}` })
    ).toBeNull();
  });

  it("a key-scoped client has no conversation", () => {
    expect(resolveAgentConversation({ clientKey: "key:abc" })).toBeNull();
    expect(conversationOfClientKey("key:abc")).toBeNull();
  });

  it("a non-UUID id never reaches the shell command", () => {
    expect(
      resolveAgentConversation({
        clientKey: "key:abc|conv:claude-code:x;rm -rf ~",
      })
    ).toBeNull();
  });

  it("upper-case ids normalize; a missing cwd is null, never empty", () => {
    const r = resolveAgentConversation({
      clientKey: `key:abc|conv:claude-code:${ID.toUpperCase()}`,
      conversationCwd: "",
    });
    expect(r?.conversationId).toBe(ID);
    expect(r?.cwd).toBeNull();
  });

  it("no metadata, no door", () => {
    expect(resolveAgentConversation(null)).toBeNull();
    expect(resolveAgentConversation({ clientKey: 42 })).toBeNull();
  });
});
