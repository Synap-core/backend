/**
 * synap_match_playbooks — a SIGNAL-LESS call is refused, loudly.
 *
 * Measured on the live pod (2026-09-20): a caller that passed `intent`
 * instead of `intentText` got 15 candidates, every one tied at the ranker's
 * floor score. Nothing in the MCP layer rejects an unknown key, so the
 * mistyped argument simply vanished and the tool answered a question nobody
 * asked — a plausible, ranked, meaningless list.
 *
 * The refusal is the house error door (`toolError` → `isError: true` TEXT the
 * model can read and retry from), and it names the argument.
 *
 * WHAT THIS DOES NOT COVER, measured: a mistyped argument ALONGSIDE a real
 * signal (e.g. `intent` + `profileSlug`) still ranks on what was understood.
 * The last case below pins that boundary rather than implying coverage.
 */

import { describe, it, expect, vi } from "vitest";

const { matchForEntity } = vi.hoisted(() => ({ matchForEntity: vi.fn() }));

vi.mock("../../playbooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../playbooks.js")>()),
  playbooksRouter: { createCaller: () => ({ matchForEntity }) },
}));
vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds: vi.fn(async () => ["ws-1"]),
}));

import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

const ctx = (args: Record<string, unknown>): McpToolContext =>
  ({
    toolName: "synap_match_playbooks",
    args,
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  }) as McpToolContext;

const run = (args: Record<string, unknown>) =>
  buildHandlers.synap_match_playbooks!(ctx(args));

describe("synap_match_playbooks — no signal, no match", () => {
  it("refuses a call with NO signal and names the argument", async () => {
    const result = await run({});
    expect(result.isError).toBe(true);
    const block = result.content?.[0];
    if (!block || block.type !== "text") throw new Error("expected text");
    // The message must be actionable: the right spelling, and the other door.
    expect(block.text).toContain("intentText");
    expect(block.text).toContain("synap_list_playbooks");
    // Nothing was ranked — the refusal happens before any lookup.
    expect(matchForEntity).not.toHaveBeenCalled();
  });

  it("refuses the MEASURED mistype — `intent` instead of `intentText`", async () => {
    const result = await run({ intent: "plan next content" });
    expect(result.isError).toBe(true);
    expect(matchForEntity).not.toHaveBeenCalled();
  });

  it("refuses a BLANK intentText — whitespace is not a signal", async () => {
    const result = await run({ intentText: "   " });
    expect(result.isError).toBe(true);
    expect(matchForEntity).not.toHaveBeenCalled();
  });

  it("a real signal still ranks — profileSlug alone is enough", async () => {
    matchForEntity.mockResolvedValue([]);
    const result = await run({ profileSlug: "post", workspaceId: "ws-1" });
    expect(result.isError).toBeUndefined();
    expect(matchForEntity).toHaveBeenCalledWith(
      expect.objectContaining({ profileSlug: "post" })
    );
  });

  it("BOUNDARY: a mistype beside a real signal is still silently dropped", async () => {
    // Not an endorsement — a measurement. The MCP layer has no unknown-key
    // rejection, so `intent` is ignored and the call ranks on profileSlug.
    matchForEntity.mockResolvedValue([]);
    const result = await run({
      intent: "plan next content",
      profileSlug: "post",
      workspaceId: "ws-1",
    });
    expect(result.isError).toBeUndefined();
    expect(matchForEntity).toHaveBeenCalledWith(
      expect.not.objectContaining({ intentText: expect.anything() })
    );
  });
});
