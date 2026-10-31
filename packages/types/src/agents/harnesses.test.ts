import { describe, expect, it } from "vitest";
import { resolveServiceName } from "../service-marks/index.js";
import {
  AGENT_HARNESSES,
  REOPENABLE_HARNESS_SLUGS,
  SURFACE_HARNESS_SLUGS,
  resolveHarness,
} from "./harnesses.js";
import { resolveAgentConversation } from "./conversation.js";

const ID = "8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

describe("the harness registry", () => {
  it("slugs are unique", () => {
    const slugs = AGENT_HARNESSES.map((h) => h.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("Claude Code has ONE slug, and it is reopenable", () => {
    expect(resolveHarness("claude-code")?.label).toBe("Claude Code");
    expect(REOPENABLE_HARNESS_SLUGS).toEqual(["claude-code"]);
    expect(resolveHarness("coder")).toBeNull();
    expect(resolveHarness(null)).toBeNull();
  });

  it("the surface allowlist keeps the order the setup door always had", () => {
    expect([...SURFACE_HARNESS_SLUGS]).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "raycast",
      "codex",
      "openwebui",
      "discord",
      "proton",
      "generic",
    ]);
  });

  it("each label is how the service registry names it (generic is a bucket)", () => {
    for (const h of AGENT_HARNESSES.filter((x) => x.slug !== "generic")) {
      expect(resolveServiceName(h.slug)).toBe(h.label);
    }
  });

  it("the reopen template builds the command, and refuses a hostile id", () => {
    const claude = resolveHarness("claude-code")!;
    expect(claude.reopen?.command(ID)).toBe(`claude --resume ${ID}`);
    expect(claude.reopen?.idPattern.test("abc; rm -rf /")).toBe(false);
    // A harness with no template is no door, even with a well-formed id.
    expect(
      resolveAgentConversation({ clientKey: `key:abc|conv:cursor:${ID}` })
    ).toBeNull();
  });
});
