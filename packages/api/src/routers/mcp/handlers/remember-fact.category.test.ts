/**
 * `synap_remember_fact` REFUSES a category outside the user_observation enum
 * (decision fa6c8833). It used to fall back silently to the default, so the
 * agent never learned it sent a wrong value; the same value filed through
 * `synap_create_entity` failed only at the founder's Approve (`preference`
 * for `preferences`, five founder preferences, 2026-10-27).
 *
 * The refusal is the input's enum, at the door (`parseToolArgs`); a valid
 * category drives the REAL handler, the service mocked only to see it ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rememberFactSpy } = vi.hoisted(() => ({
  rememberFactSpy: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "applied",
    factId: "f1",
  })),
}));
vi.mock("../../../services/knowledge/remember-fact.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  rememberFact: rememberFactSpy,
}));

import { parseToolArgs } from "../define-tool.js";
import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const call = (args: Record<string, unknown>) =>
  entityHandlers.synap_remember_fact!({
    toolName: "synap_remember_fact",
    args: { fact: "Prefers flat lists", ...args },
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    lensCaller: {},
  } as unknown as McpToolContext);

const textOf = (r: { content?: Array<{ text?: string }> }) =>
  r.content?.[0]?.text ?? "";

beforeEach(() => rememberFactSpy.mockClear());

describe("synap_remember_fact category", () => {
  it("refuses an unknown category at the door, names the allowed ones, saves nothing", () => {
    // The category is the tool's input enum: `parseToolArgs` refuses it
    // before any handler runs, as on the live call path (`tools.execute`).
    const res = parseToolArgs("synap_remember_fact", {
      fact: "Prefers flat lists",
      category: "preference",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const refusal = res.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(refusal.isError).toBe(true);
    expect(textOf(refusal)).toMatch(/category/);
    expect(textOf(refusal)).toMatch(/working_style/);
    expect(rememberFactSpy).not.toHaveBeenCalled();
  });

  it("passes a valid category through, and no category stays the service's default", async () => {
    await call({ category: "preferences" });
    await call({});
    expect(rememberFactSpy).toHaveBeenCalledTimes(2);
    expect(rememberFactSpy.mock.calls[0]![0]).toMatchObject({
      category: "preferences",
    });
    expect(rememberFactSpy.mock.calls[1]![0].category).toBeUndefined();
  });
});
