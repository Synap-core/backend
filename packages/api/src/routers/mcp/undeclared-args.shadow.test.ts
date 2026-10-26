/**
 * W-C1 SHADOW: every MCP tool call's undeclared argument keys are COUNTED (a
 * log line per call, key names only) and the call is NOT refused. W-C3 turns
 * the same check into a refusal after seven days of these numbers.
 *
 * Real: the tool list (`tools.list()`, the declared set) and the pure
 * comparison. The dispatch half is a source scan: the call must sit in the
 * `CallToolRequestSchema` handler, before `tools.execute` — the one point
 * every tool call passes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripComments } from "../../../../../scripts/strip-comments.mjs";
import { shadowUndeclaredArgs } from "./undeclared-args.js";

describe("undeclared tool arguments — shadow (W-C1)", () => {
  it("names the undeclared keys of a READ tool, never the declared or door-injected ones", async () => {
    // a4e6977d: a filter a tool lacks used to be ignored silently.
    expect(
      await shadowUndeclaredArgs("synap_list_sessions", {
        trackId: "t",
        workspaceId: "w",
        projectId: "p",
        bogusFilter: 1,
      })
    ).toEqual(["bogusFilter"]);
  });

  it("a write tool's derived sessionId is declared, so it is never counted", async () => {
    expect(
      await shadowUndeclaredArgs("synap_link_entities", {
        sessionId: "s",
        addOutputs: [],
      })
    ).toEqual(["addOutputs"]);
  });

  it("an unknown tool counts nothing (the SDK reports the tool itself)", async () => {
    expect(await shadowUndeclaredArgs("synap_no_such_tool", { x: 1 })).toEqual(
      []
    );
  });

  it("the dispatch runs it on EVERY call, before the tool executes", () => {
    const src = stripComments(
      readFileSync(resolve(__dirname, "index.ts"), "utf8")
    ) as string;
    const handler = src.slice(src.indexOf("CallToolRequestSchema, async"));
    const shadow = handler.indexOf("shadowUndeclaredArgs(request.params.name");
    expect(shadow).toBeGreaterThan(-1);
    expect(shadow).toBeLessThan(handler.indexOf("tools.execute("));
  });
});
