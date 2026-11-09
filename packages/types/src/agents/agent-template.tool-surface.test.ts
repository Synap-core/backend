/**
 * An agent template's starting MCP tool surface (finding d812debd): the pod
 * reads `toolProfile` and `toolGroups` off `definition.agent` instead of
 * dropping them, and refuses what it would have to guess about.
 */
import { describe, it, expect } from "vitest";
import { parseAgentTemplateSpec } from "./agent-template.js";
import { MCP_TOOL_GROUP_NAMES } from "./tool-surface.js";

const base = { harness: "hermes", worker: false, tried: true };
const parse = (extra: Record<string, unknown>) =>
  parseAgentTemplateSpec({ ...base, ...extra });
const spec = (extra: Record<string, unknown>) => {
  const r = parse(extra);
  if (!r.ok) throw new Error(r.reason);
  return r.spec;
};
const refusal = (extra: Record<string, unknown>) => {
  const r = parse(extra);
  if (r.ok) throw new Error("expected a refusal");
  return r.reason;
};

describe("agent template tool surface", () => {
  it("absent: no profile, no groups (the pod's default applies)", () => {
    expect(spec({})).toMatchObject({ toolProfile: null, toolGroups: [] });
    expect(spec({ toolProfile: null, toolGroups: null })).toMatchObject({
      toolProfile: null,
      toolGroups: [],
    });
  });

  it("Hermes: entry + read is kept", () => {
    expect(spec({ toolProfile: "entry", toolGroups: ["read"] })).toMatchObject({
      toolProfile: "entry",
      toolGroups: ["read"],
    });
  });

  it("builder alone is kept; every listed group is accepted on entry, once each", () => {
    expect(spec({ toolProfile: "builder" }).toolProfile).toBe("builder");
    expect(
      spec({
        toolProfile: "entry",
        toolGroups: [...MCP_TOOL_GROUP_NAMES, "read"],
      }).toolGroups
    ).toEqual([...MCP_TOOL_GROUP_NAMES]);
  });

  it("an unknown profile or group is refused, naming the real ones", () => {
    expect(refusal({ toolProfile: "read" })).toMatch(/entry, builder/);
    expect(
      refusal({ toolProfile: "entry", toolGroups: ["everything"] })
    ).toMatch(/read, data/);
    expect(refusal({ toolProfile: "entry", toolGroups: "read" })).toMatch(
      /toolGroups/
    );
  });

  it("groups without entry are refused (builder lists every tool; none = entry by default, so say it)", () => {
    expect(refusal({ toolGroups: ["read"] })).toMatch(/toolProfile: entry/);
    expect(refusal({ toolProfile: "builder", toolGroups: ["read"] })).toMatch(
      /toolProfile: entry/
    );
    expect(spec({ toolProfile: "builder", toolGroups: [] }).toolGroups).toEqual(
      []
    );
  });
});
