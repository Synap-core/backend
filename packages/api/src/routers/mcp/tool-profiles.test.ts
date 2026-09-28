import { describe, it, expect } from "vitest";
import { tools } from "./tools/index.js";
import {
  BUILDER_REF,
  ENTRY_TOOLS,
  TOOL_GROUPS,
  TOOL_GROUP_NAMES,
  filterToolsForAccess,
  groupsForLoadSkillRef,
  isToolGroupRef,
  visibleToolNames,
} from "./tool-profiles.js";

/**
 * MCP tool profiles (V1 D4). The coverage half is DERIVED from the live
 * `tools.list()` — the set a client is actually advertised — so a tool added
 * tomorrow joins the check by existing: it must be entry or in exactly one
 * group, or an entry key could never reach it (not even via `builder`).
 */
describe("tool profiles", () => {
  it("every advertised tool is entry or in exactly ONE group (derived from tools.list())", async () => {
    const advertised = (await tools.list()).map((t) => t.name);
    // Non-vacuity: the scan sees the real surface, including the new tool.
    expect(advertised.length).toBeGreaterThan(60);
    expect(advertised).toContain("synap_wait_for_answer");

    const entry = new Set<string>(ENTRY_TOOLS);
    const unplaced: string[] = [];
    const doubled: string[] = [];
    for (const name of advertised) {
      const homes =
        TOOL_GROUP_NAMES.filter((g) =>
          (TOOL_GROUPS[g] as readonly string[]).includes(name)
        ).length + (entry.has(name) ? 1 : 0);
      if (homes === 0) unplaced.push(name);
      if (homes > 1) doubled.push(name);
    }
    expect(unplaced).toEqual([]);
    expect(doubled).toEqual([]);
  });

  it("names no tool that is not advertised (a rename cannot leave a dead entry)", async () => {
    const advertised = new Set((await tools.list()).map((t) => t.name));
    const named = [
      ...ENTRY_TOOLS,
      ...Object.values(TOOL_GROUPS).flat(),
    ] as string[];
    expect(named.filter((n) => !advertised.has(n))).toEqual([]);
  });

  it("the entry surface is the 9 tools of D4", () => {
    expect([...ENTRY_TOOLS].sort()).toEqual(
      [
        "synap_orient",
        "synap_ask",
        "synap_capture",
        "synap_start_session",
        "synap_update_session",
        "synap_wait_for_answer",
        "synap_post_message",
        "synap_complete_session",
        "synap_load_skill",
      ].sort()
    );
  });

  it("legacy (NULL) and builder keys list every tool; an entry key lists 9 + its unlocked groups", () => {
    expect(visibleToolNames({ profile: null, groups: [] })).toBeNull();
    expect(visibleToolNames({ profile: "builder", groups: [] })).toBeNull();

    const entryOnly = visibleToolNames({ profile: "entry", groups: [] })!;
    expect(entryOnly.size).toBe(9);

    const withSchema = visibleToolNames({
      profile: "entry",
      groups: ["schema", "not-a-group"],
    })!;
    expect(withSchema.size).toBe(9 + TOOL_GROUPS.schema.length);
    expect(withSchema.has("synap_define_kind")).toBe(true);
    // An unknown stored group is ignored, never widened.
    expect(withSchema.has("synap_create_view")).toBe(false);
  });

  it("filterToolsForAccess narrows an entry key and passes everything else through", () => {
    const defs = [
      { name: "synap_ask" },
      { name: "synap_define_kind" },
      { name: "synap_create_view" },
    ];
    expect(
      filterToolsForAccess(defs, { profile: "entry", groups: [] }).map(
        (t) => t.name
      )
    ).toEqual(["synap_ask"]);
    expect(filterToolsForAccess(defs, { profile: null, groups: [] })).toBe(
      defs
    );
  });

  it("load_skill refs resolve to groups: builder = all, a group = itself, a teaching skill = what it teaches", () => {
    expect(groupsForLoadSkillRef(BUILDER_REF)).toEqual(TOOL_GROUP_NAMES);
    expect(groupsForLoadSkillRef(" Schema ")).toEqual(["schema"]);
    expect(groupsForLoadSkillRef("system/synap/from-intent")).toEqual([
      "schema",
      "spaces",
    ]);
    expect(groupsForLoadSkillRef("writes.md")).toEqual(["data"]);
    expect(groupsForLoadSkillRef("catalog")).toEqual([]);
    expect(isToolGroupRef("builder")).toBe(true);
    expect(isToolGroupRef("tracks")).toBe(true);
    expect(isToolGroupRef("focus-sessions")).toBe(false);
  });
});
