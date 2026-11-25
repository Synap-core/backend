import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tools } from "./tools/index.js";
import {
  BUILDER_REF,
  SKILL_PACKAGES_THAT_UNLOCK,
  SKILL_STEMS_THAT_UNLOCK,
  ENTRY_TOOLS,
  TOOL_GROUPS,
  TOOL_GROUP_NAMES,
  filterToolsForAccess,
  groupsForLoadSkillRef,
  isToolGroupRef,
  parseToolGroupRef,
  toolGroupRef,
  visibleToolNames,
} from "./tool-profiles.js";
import { BUILD_SKILLS } from "./tool-guidance.js";

/**
 * Every seeded skill STEM on disk (`skills/<package>/*.md`) — what a bare
 * `load_skill` ref resolves to. Globbed, never hand-listed, so a skill added
 * tomorrow joins the collision check by existing.
 */
const SKILLS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../skills"
);
/** Every seeded skill as `system/<package>/<stem>`, the slug `ensureSystemSkills` gives it. */
const SKILL_SLUGS: string[] = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(join(SKILLS_ROOT, d.name))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `system/${d.name}/${f.slice(0, -3).toLowerCase()}`)
  );
const SKILL_STEMS: string[] = SKILL_SLUGS.map((s) => s.split("/")[2]!);
const packageOfSlug = (slug: string) => slug.split("/")[1]!;

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

  it("the entry surface is the 9 tools of D4 + the goal and pick-up tools of plan v5 T1 + the relay door + the ask-the-person door + the dispatcher", () => {
    expect([...ENTRY_TOOLS].sort()).toEqual(
      [
        "synap_orient",
        "synap_ask",
        "synap_capture",
        "synap_list_tracks",
        "synap_start_track",
        "synap_get_session",
        "synap_start_session",
        "synap_update_session",
        "synap_wait_for_answer",
        "synap_post_message",
        "synap_relay_answer",
        "synap_ask_person",
        "synap_complete_session",
        "synap_load_skill",
        "synap_call_tool",
      ].sort()
    );
  });

  it("legacy (NULL) and builder keys list every tool; an entry key lists 15 + its unlocked groups", () => {
    expect(visibleToolNames({ profile: null, groups: [] })).toBeNull();
    expect(visibleToolNames({ profile: "builder", groups: [] })).toBeNull();

    const entryOnly = visibleToolNames({ profile: "entry", groups: [] })!;
    expect(entryOnly.size).toBe(15);

    const withSchema = visibleToolNames({
      profile: "entry",
      groups: ["schema", "not-a-group"],
    })!;
    expect(withSchema.size).toBe(15 + TOOL_GROUPS.schema.length);
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

  it("load_skill refs resolve to groups: tools:builder = all, tools:<group> = itself, a teaching skill = what it teaches", () => {
    expect(BUILDER_REF).toBe("tools:builder");
    expect(groupsForLoadSkillRef(BUILDER_REF)).toEqual(TOOL_GROUP_NAMES);
    expect(groupsForLoadSkillRef(" tools:Schema ")).toEqual(["schema"]);
    expect(groupsForLoadSkillRef("system/synap/from-intent")).toEqual([
      "schema",
      "spaces",
    ]);
    expect(groupsForLoadSkillRef("writes.md")).toEqual(["data"]);
    expect(groupsForLoadSkillRef("catalog")).toEqual([]);
    expect(isToolGroupRef("tools:builder")).toBe(true);
    expect(isToolGroupRef("tools:tracks")).toBe(true);
    expect(isToolGroupRef("focus-sessions")).toBe(false);
    // A bare group name is NOT a group ref — it is a skill ref.
    expect(isToolGroupRef("tracks")).toBe(false);
    expect(isToolGroupRef("builder")).toBe(false);
    // An unknown name in the group namespace is reported, never widened.
    expect(parseToolGroupRef("tools:everything")).toBeNull();
  });

  it("group refs and skill stems never collide (skills globbed from skills/*/*.md)", () => {
    // Non-vacuity: the glob sees the real skills, including the two stems
    // that ARE also group names — the collision this namespace exists for.
    expect(SKILL_STEMS.length).toBeGreaterThan(40);
    expect(SKILL_STEMS).toContain("governance");
    expect(SKILL_STEMS).toContain("capabilities");

    // Every skill stem resolves as a SKILL, never as a group ref…
    expect(SKILL_STEMS.filter((stem) => isToolGroupRef(stem))).toEqual([]);
    // …and no group ref is itself a skill stem.
    const refs = [
      BUILDER_REF,
      ...TOOL_GROUP_NAMES.map((g) => toolGroupRef(g)),
    ].map((r) => r.toLowerCase());
    expect(refs.filter((r) => SKILL_STEMS.includes(r))).toEqual([]);
  });

  it("every skill that unlocks a group is a real skill file", () => {
    expect(SKILL_STEMS_THAT_UNLOCK.length).toBeGreaterThan(10);
    expect(
      SKILL_STEMS_THAT_UNLOCK.filter((stem) => !SKILL_STEMS.includes(stem))
    ).toEqual([]);
  });

  it("every package that unlocks a group is a real skill package", () => {
    const packages = new Set(SKILL_SLUGS.map(packageOfSlug));
    // Non-vacuity: the glob sees the packages the family rule exists for.
    expect(SKILL_PACKAGES_THAT_UNLOCK).toContain("synap-ui");
    expect(SKILL_PACKAGES_THAT_UNLOCK).toContain("synap-app");
    expect(SKILL_PACKAGES_THAT_UNLOCK.filter((p) => !packages.has(p))).toEqual(
      []
    );
  });

  it("every chapter of synap-ui and synap-app unlocks build, by full slug and by package/stem (derived from disk)", () => {
    const chapters = SKILL_SLUGS.filter((s) =>
      ["synap-ui", "synap-app"].includes(packageOfSlug(s))
    );
    // Non-vacuity: both packages' chapters, including their SKILL.md bundles.
    expect(chapters.length).toBeGreaterThan(20);
    expect(chapters).toContain("system/synap-ui/skill");
    expect(chapters).toContain("system/synap-app/overview");
    const missing = chapters.filter(
      (slug) =>
        !groupsForLoadSkillRef(slug).includes("build") ||
        !groupsForLoadSkillRef(slug.slice("system/".length)).includes("build")
    );
    expect(missing).toEqual([]);
    // `.md` and case are forgiven, as for a stem.
    expect(groupsForLoadSkillRef("System/Synap-UI/Views.md")).toContain(
      "build"
    );
  });

  it("the same stem in ANOTHER package does not borrow the family's groups (no stem-only over-unlock)", () => {
    const familyStems = new Set(
      SKILL_SLUGS.filter((s) =>
        SKILL_PACKAGES_THAT_UNLOCK.includes(packageOfSlug(s))
      ).map((s) => s.split("/")[2]!)
    );
    // The collisions this rule exists for: the same stem in another package.
    const twins = SKILL_SLUGS.filter(
      (s) =>
        !SKILL_PACKAGES_THAT_UNLOCK.includes(packageOfSlug(s)) &&
        familyStems.has(s.split("/")[2]!)
    );
    // Topic files only: a package's SKILL.md is generated (gitignored for
    // synap-design), so a `*/skill` twin may be absent from a fresh checkout.
    expect(twins).toContain("system/synap/governance");
    expect(twins).toContain("system/synap-market/overview");
    // A twin unlocks only what its OWN stem maps to, never `build` by family.
    const borrowed = twins.filter(
      (slug) =>
        groupsForLoadSkillRef(slug).includes("build") &&
        !groupsForLoadSkillRef(slug.split("/")[2]!).includes("build")
    );
    expect(borrowed).toEqual([]);
    // A bare stem carries no package: only the stem map applies.
    expect(groupsForLoadSkillRef("skill")).toEqual([]);
    expect(groupsForLoadSkillRef("overview")).toEqual([]);
    // Agent input never reaches Object.prototype.
    expect(groupsForLoadSkillRef("constructor")).toEqual([]);
    expect(groupsForLoadSkillRef("constructor/x")).toEqual([]);
  });

  it("the build path orient teaches (yourTools.build) names real skills that unlock build", () => {
    for (const ref of Object.values(BUILD_SKILLS)) {
      expect(SKILL_SLUGS).toContain(ref);
      expect(groupsForLoadSkillRef(ref)).toContain("build");
    }
  });
});
