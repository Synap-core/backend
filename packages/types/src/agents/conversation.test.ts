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
  resolveAgentLaunch,
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

/**
 * The OPEN door (review M5): the command is rendered from the registry's
 * template and a validated model only. Rows where a looser rule would
 * disagree: a hostile model (must never reach the shell), a model with glob
 * characters (quoted, or zsh expands it), a harness with no template (no
 * door, not a guess), and a model a harness cannot take (no door, never a
 * command that starts another model).
 */
describe("resolveAgentLaunch", () => {
  it("Claude Code and Codex open with their program", () => {
    expect(resolveAgentLaunch({ agentType: "claude-code" })).toEqual({
      harness: "claude-code",
      command: "claude",
    });
    expect(resolveAgentLaunch({ agentType: "codex" })?.command).toBe("codex");
  });

  it("a default model becomes the harness's model flag", () => {
    expect(
      resolveAgentLaunch({ agentType: "claude-code", model: "claude-opus-5-5" })
        ?.command
    ).toBe("claude --model claude-opus-5-5");
    expect(
      resolveAgentLaunch({ agentType: "codex", model: "gpt-5" })?.command
    ).toBe("codex --model gpt-5");
  });

  it("a model with glob characters is one quoted word", () => {
    expect(
      resolveAgentLaunch({
        agentType: "claude-code",
        model: "claude-opus-4-6[1m]",
      })?.command
    ).toBe("claude --model 'claude-opus-4-6[1m]'");
  });

  it("a hostile model gives no door, never a command", () => {
    for (const model of [
      "opus; rm -rf ~",
      "$(curl evil)",
      "`id`",
      "a b",
      "https://gateway.example/v1",
    ]) {
      expect(
        resolveAgentLaunch({ agentType: "claude-code", model })
      ).toBeNull();
    }
  });

  it("a harness with no launch template is no door", () => {
    for (const agentType of ["cursor", "claude-desktop", "machine", "", null]) {
      expect(resolveAgentLaunch({ agentType })).toBeNull();
    }
  });

  it("an empty or absent model opens the harness's own default", () => {
    expect(
      resolveAgentLaunch({ agentType: "claude-code", model: "" })?.command
    ).toBe("claude");
    expect(
      resolveAgentLaunch({ agentType: "claude-code", model: null })?.command
    ).toBe("claude");
  });
});
