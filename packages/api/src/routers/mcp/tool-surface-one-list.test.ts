/**
 * ONE list of MCP tool groups and profiles (`@synap-core/types/agents`): the
 * pod's groups (`TOOL_GROUPS`, typed over it, so a mismatch does not compile)
 * and key profiles are that list, in the same order, at runtime too. The
 * catalog mirrors it for an agent template's `toolGroups` (finding d812debd).
 */
import { describe, it, expect } from "vitest";
import {
  MCP_TOOL_GROUP_NAMES,
  MCP_TOOL_PROFILES,
} from "@synap-core/types/agents";
import { API_KEY_TOOL_PROFILES } from "@synap/database/schema";
import { TOOL_GROUP_NAMES } from "./tool-profiles.js";

describe("one list of tool groups and profiles", () => {
  it("the pod's groups are the shared list", () => {
    expect(TOOL_GROUP_NAMES).toEqual([...MCP_TOOL_GROUP_NAMES]);
  });
  it("a key's profiles are the shared list", () => {
    expect([...API_KEY_TOOL_PROFILES]).toEqual([...MCP_TOOL_PROFILES]);
  });
});
