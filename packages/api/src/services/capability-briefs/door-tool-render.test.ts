/**
 * Render-time door naming over the REAL escalation-ladder / read-before-write
 * skill files (the ones the XP report hit) and the REAL generated door table.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  renderSkillForDoor,
  resolveTaughtToolToken,
  skillDoorFor,
} from "./door-tool-render.js";

const SKILLS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../skills"
);
const ladder = readFileSync(
  resolve(SKILLS, "synap/escalation-ladder.md"),
  "utf8"
);
const readBeforeWrite = readFileSync(
  resolve(SKILLS, "synap-schema/read-before-write.md"),
  "utf8"
);

describe("resolveTaughtToolToken", () => {
  it("resolves pod names, bare stems and IS aliases through the one alias map", () => {
    expect(resolveTaughtToolToken("synap_define_kind")).toBe(
      "synap_define_kind"
    );
    expect(resolveTaughtToolToken("define_kind")).toBe("synap_define_kind");
    expect(resolveTaughtToolToken("search_unified")).toBe("synap_ask");
    expect(resolveTaughtToolToken("generate_widget")).toBe("synap_create_cell");
    expect(resolveTaughtToolToken("list_entities")).toBe("synap_get_entities");
    expect(resolveTaughtToolToken("depends_on")).toBeNull();
    expect(resolveTaughtToolToken("create_property_def")).toBeNull();
  });
});

describe("renderSkillForDoor", () => {
  it("Raycast: L3 tools render with Raycast names; tools Raycast lacks are marked and noted", () => {
    const out = renderSkillForDoor(ladder, "raycast");
    for (const name of [
      "`define-role`",
      "`define-kind`",
      "`list-profiles`",
      "`create-view`",
      "`create-workspace`",
      "`create-playbook`",
      "`load-skill`",
    ]) {
      expect(out).toContain(name);
    }
    expect(out).not.toMatch(
      /`(define_role|define_kind|list_profiles|create_workspace)`/
    );
    expect(out).toContain("`synap_promote_session_to_playbook†`");
    expect(out).toContain("**Door note (Raycast):**");
    expect(out).toMatch(/- `synap_promote_cell_to_renderer` — not on Raycast/);
    expect(out).toMatch(/- `discover_tools` — in-app assistant only/);
  });

  it("claude.ai connector: pod__ names", () => {
    const out = renderSkillForDoor(ladder, "cp-connector");
    expect(out).toContain("`pod__define_role`");
    expect(out).toContain("`pod__create_workspace`");
    expect(out).toContain("`synap_create_view†`");
    expect(out).toContain("**Door note (claude.ai Synap connector):**");
  });

  it("pod MCP: bare stems gain the synap_ prefix", () => {
    const out = renderSkillForDoor(ladder, "pod-mcp");
    expect(out).toContain("`synap_define_role`");
    expect(out).toContain("`synap_promote_session_to_playbook`");
    expect(out).not.toMatch(/- `synap_/); // every pod tool is on pod MCP
  });

  it("IS-only tokens get a note whose own advice is rendered for the door", () => {
    const out = renderSkillForDoor(readBeforeWrite, "raycast");
    expect(out).toContain("`create_property_def†`");
    expect(out).toMatch(
      /- `create_property_def` — in-app assistant only; from an agent door add the field through define-kind/
    );
  });

  it("leaves non-tool snake_case untouched and adds nothing when nothing is missing", () => {
    const src =
      "Link with `depends_on`; the table `synap_packages`; then `synap_ask`.";
    expect(renderSkillForDoor(src, "raycast")).toBe(
      "Link with `depends_on`; the table `synap_packages`; then `ask`."
    );
  });
});

describe("skillDoorFor", () => {
  it("derives the door from transport + agentType", () => {
    expect(skillDoorFor("mcp", "claude-web")).toBe("cp-connector");
    expect(skillDoorFor("mcp", "raycast")).toBe("pod-mcp"); // raycast --with-mcp speaks pod names
    expect(skillDoorFor("mcp", null)).toBe("pod-mcp");
    expect(skillDoorFor("hub", "raycast")).toBe("raycast");
    expect(skillDoorFor("hub", "claude-code")).toBeNull();
    expect(skillDoorFor("hub", null)).toBeNull();
  });
});
