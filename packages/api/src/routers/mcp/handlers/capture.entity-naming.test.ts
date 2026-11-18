/**
 * `synap_capture` names a malformed entity the way the CALLER knows it (ticket
 * 8215c66a): its own `ref`, else its position and title — never the
 * auto-assigned `e0` it never sent — and says when the kind was sent under a
 * name this door does not read (`type`, `kind`) or the entity was named with
 * `key` instead of `ref`.
 *
 * Driven through the real handler on the dry run; only the DB-backed reads are
 * faked (the same seam as `capture.title-contract.test.ts`).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    resolveProjectPlacement: async () => ({ projectId: null, rung: null }),
    resolveIdentity: async () => ({ crossKindCandidates: [] }),
  };
});

vi.mock("../../../services/capture-agent/submit-capture-graph.js", () => ({
  dryRunCaptureGraph: async () => {
    throw new Error("a structural problem must stop before the dry run");
  },
  submitCaptureGraph: async () => {
    throw new Error("a dry run must never submit");
  },
}));

import { captureHandlers } from "./capture.js";
import type { McpToolContext } from "./shared.js";

type Result = { content: Array<{ text?: string }> };
const capture = async (args: Record<string, unknown>) => {
  const r = (await captureHandlers.synap_capture!({
    toolName: "synap_capture",
    args,
    userId: "user-owner",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    workspaceAccessible: true,
  } as unknown as McpToolContext)) as Result;
  return JSON.parse(r.content[0]!.text!) as {
    error?: string;
    problems?: string[];
  };
};

describe("synap_capture — an entity is named the way the caller knows it", () => {
  it("names an entity with no ref by position and title, and says `type` is not the field", async () => {
    const out = await capture({
      validate: true,
      entities: [
        { key: "d1", type: "decision", title: "Keep the pod sovereign" },
      ],
    });
    const text = [out.error ?? "", ...(out.problems ?? [])].join("\n");
    expect(text).toContain('entities[0] ("Keep the pod sovereign")');
    expect(text).not.toMatch(/'e0'/);
    expect(text).toContain('you sent `type: "decision"`');
    expect(text).toContain("`profileSlug`");
    expect(text).toContain("`key` is not read");
  });

  it("keeps the caller's own ref when it sent one", async () => {
    const out = await capture({
      validate: true,
      entities: [{ ref: "k1", kind: "knowledge", title: "Grants deny" }],
    });
    const text = [out.error ?? "", ...(out.problems ?? [])].join("\n");
    expect(text).toContain("entity 'k1' needs a `profileSlug`");
    expect(text).toContain('you sent `kind: "knowledge"`');
  });
});
