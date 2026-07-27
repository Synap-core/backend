/**
 * shouldRejectUnattributedWrite — Phase 0 attribution hard-reject
 * (GOVERNANCE-CONVERGENCE-PLAN.md §Phase 0).
 *
 * A `user_pat`/`hub_inbound` key with no `linkedUserId` is a bare human key
 * used directly against MCP. Today that produces an anonymous write that
 * falls to the human governance path and, for DEFAULT_AUTO_APPROVE verbs,
 * executes with no proposal at all — the silent bypass this closes. Pins:
 *   - write tool + bare key (linkedUserId null)  -> reject
 *   - read tool  + bare key                       -> allow
 *   - write tool + attributed key (linkedUserId set) -> allow
 *   - non-`tools/call` methods (initialize, tools/list, ...) -> never reject
 */

import { describe, it, expect } from "vitest";
import { shouldRejectUnattributedWrite } from "../http-handler.js";

const READ_TOOL = { name: "synap_ask", annotations: { readOnlyHint: true } };
const WRITE_TOOL = {
  name: "synap_create_entity",
  annotations: { readOnlyHint: false },
};
const TOOL_DEFS = [READ_TOOL, WRITE_TOOL];

function callBody(toolName: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName },
  };
}

describe("shouldRejectUnattributedWrite", () => {
  it("rejects a write tool call from a bare user_pat key (linkedUserId null)", () => {
    expect(
      shouldRejectUnattributedWrite(
        callBody("synap_create_entity"),
        TOOL_DEFS,
        "user_pat",
        null
      )
    ).toBe(true);
  });

  it("rejects a write tool call from a bare hub_inbound key", () => {
    expect(
      shouldRejectUnattributedWrite(
        callBody("synap_create_entity"),
        TOOL_DEFS,
        "hub_inbound",
        null
      )
    ).toBe(true);
  });

  it("allows a read tool call from the same bare key", () => {
    expect(
      shouldRejectUnattributedWrite(
        callBody("synap_ask"),
        TOOL_DEFS,
        "user_pat",
        null
      )
    ).toBe(false);
  });

  it("allows a write tool call once the key has a linkedUserId (real agent key)", () => {
    expect(
      shouldRejectUnattributedWrite(
        callBody("synap_create_entity"),
        TOOL_DEFS,
        "user_pat",
        "user-123"
      )
    ).toBe(false);
  });

  it("allows a service key with no linkedUserId (deliberately owner-attributed, not an agent)", () => {
    expect(
      shouldRejectUnattributedWrite(
        callBody("synap_create_entity"),
        TOOL_DEFS,
        "service",
        null
      )
    ).toBe(false);
  });

  it("never rejects non-tools/call methods (e.g. initialize, tools/list)", () => {
    expect(
      shouldRejectUnattributedWrite(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        TOOL_DEFS,
        "user_pat",
        null
      )
    ).toBe(false);
  });

  it("does not reject an unknown tool name (lets the SDK's own error surface it)", () => {
    expect(
      shouldRejectUnattributedWrite(
        callBody("not_a_real_tool"),
        TOOL_DEFS,
        "user_pat",
        null
      )
    ).toBe(false);
  });
});
