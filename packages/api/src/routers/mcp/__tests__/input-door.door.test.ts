/**
 * What the input check does to a caller's arguments (review B2 F2), through
 * the REAL dispatch path: `tools.execute` (the uuid door, the input parse
 * against the tool's zod `input`, the error door). Only the hub edge is
 * stubbed: the adapter that runs the handler (`executeMCPToolViaHubProtocol`)
 * records the arguments it is handed, which are exactly what the handler gets.
 *
 * 1. `params` sent JSON-ENCODED AS A STRING (live 2026-09-21: a client lost a
 *    session's params this way) reaches the handler as the object.
 * 2. `""` for an optional enum reads as absent, as the handlers always read it.
 * 3. A page size over its advertised bound is CLAMPED and said
 *    (`limitClamped`), never refused.
 *
 * Negative controls: drop `jsonObjectInput` from `synap_start_session.params`
 * (1 goes red: refused as "expected record"); drop the `""` rule from
 * `withoutAbsentValues` (2 goes red: invalid option); give `list_projects.limit`
 * back a plain `.max(1000)` (3 goes red: refused, adapter never called).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("../adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapter.js")>()),
  executeMCPToolViaHubProtocol: vi.fn(),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
}));

import { tools } from "../tools/index.js";
import { executeMCPToolViaHubProtocol } from "../adapter.js";
import { runWithCallNotices } from "../call-notices.js";

const handler = executeMCPToolViaHubProtocol as unknown as ReturnType<
  typeof vi.fn
>;

const call = (name: string, args: Record<string, unknown>) =>
  runWithCallNotices(() =>
    tools.execute(name, args, "user-1", ["mcp.read", "mcp.write"])
  );

/** The arguments the handler received (the call must have reached it). */
function handed(): Record<string, unknown> {
  expect(handler).toHaveBeenCalledTimes(1);
  return handler.mock.calls[0]![1] as Record<string, unknown>;
}

const text = (r: CallToolResult) =>
  (r.content[0] as { type: "text"; text: string }).text;

beforeEach(() => {
  handler
    .mockReset()
    .mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
});

describe("the input door through tools.execute", () => {
  it("params JSON-encoded as a string reaches the handler as the object", async () => {
    const { result } = await call("synap_start_session", {
      goal: "Onboard Acme",
      params: '{"clientName":"Acme"}',
    });
    expect(result.isError).toBeFalsy();
    expect(handed().params).toEqual({ clientName: "Acme" });
  });

  it("a params string that is not a JSON object is refused saying so, never read as absent", async () => {
    for (const [params, said] of [
      ["clientName=Acme", /not JSON/],
      ["[1,2]", /not an array/],
    ] as const) {
      handler.mockClear();
      const { result } = await call("synap_start_session", {
        goal: "Onboard Acme",
        params,
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(said);
      expect(handler).not.toHaveBeenCalled();
    }
    // An empty string is "nothing supplied", not a refusal.
    handler.mockClear();
    await call("synap_start_session", { goal: "Onboard Acme", params: "" });
    expect(handed().params).toBeUndefined();
  });

  it('"" for an optional enum reads as absent; a wrong value is still refused', async () => {
    const { result } = await call("synap_get_entities", {
      profileSlug: "task",
      detail: "",
    });
    expect(result.isError).toBeFalsy();
    expect(handed()).not.toHaveProperty("detail");

    handler.mockClear();
    const wrong = await call("synap_get_entities", {
      profileSlug: "task",
      detail: "everything",
    });
    expect(wrong.result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a page size over its advertised bound is clamped and said, not refused", async () => {
    const { result, notices } = await call("synap_list_projects", {
      limit: 5000,
    });
    expect(result.isError).toBeFalsy();
    expect(handed().limit).toBe(1000);
    expect(notices.limitClamped).toEqual({ asked: 5000, used: 1000 });

    // In bounds: untouched and unsaid.
    handler.mockClear();
    const inBounds = await call("synap_list_projects", { limit: 20 });
    expect(handed().limit).toBe(20);
    expect(inBounds.notices.limitClamped).toBeUndefined();
  });
});
