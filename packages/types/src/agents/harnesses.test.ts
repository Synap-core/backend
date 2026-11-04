import { describe, expect, it } from "vitest";
import { resolveServiceName } from "../service-marks/index.js";
import {
  AGENT_HARNESSES,
  HARNESS_DOORS,
  LAUNCHABLE_HARNESS_SLUGS,
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

  it("every row names at least one door, each a known door, once", () => {
    for (const h of AGENT_HARNESSES) {
      const doors: readonly string[] = h.doors;
      expect(doors.length, h.slug).toBeGreaterThan(0);
      expect(new Set(doors).size, h.slug).toBe(doors.length);
      for (const d of doors) expect(HARNESS_DOORS, h.slug).toContain(d);
    }
  });

  it("only the clients confirmed to finish OAuth have the account door", () => {
    // Widen this only with W5's test matrix as evidence (see the registry).
    expect(
      AGENT_HARNESSES.filter((h) =>
        (h.doors as readonly string[]).includes("account")
      ).map((h) => h.slug)
    ).toEqual(["claude-code", "cursor", "chatgpt"]);
  });

  it("every CLI writer key is unique, and is one of synap-cli's TARGETS", () => {
    const keys = AGENT_HARNESSES.map((h) => h.cliTarget).filter(
      (k): k is NonNullable<typeof k> => k !== null
    );
    expect(new Set(keys).size).toBe(keys.length);
    // synap-cli `TARGETS` keys (src/lib/targets.ts at a72d06b). `aider`
    // gets the Intelligence Service, not a pod key; `chatgpt-oauth` is
    // ChatGPT's account door, not another client.
    const CLI_TARGETS = [
      "claude-code",
      "claude-desktop",
      "cursor",
      "raycast",
      "openwebui",
      "codex",
      "chatgpt",
      "chatgpt-oauth",
      "opencode",
      "aider",
      "windsurf",
      "goose",
      "zed",
      "vscode",
      "grok",
      "generic",
    ];
    for (const k of keys) expect(CLI_TARGETS).toContain(k);
  });

  it("Claude Code has ONE slug, and it is reopenable", () => {
    expect(resolveHarness("claude-code")?.label).toBe("Claude Code");
    expect(REOPENABLE_HARNESS_SLUGS).toEqual(["claude-code"]);
    expect(resolveHarness("coder")).toBeNull();
    expect(resolveHarness(null)).toBeNull();
  });

  it("Claude Code and Codex are the harnesses a person starts with a command", () => {
    expect(LAUNCHABLE_HARNESS_SLUGS).toEqual(["claude-code", "codex"]);
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
      "chatgpt",
      "opencode",
      "windsurf",
      "goose",
      "zed",
      "vscode",
      "grok",
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
