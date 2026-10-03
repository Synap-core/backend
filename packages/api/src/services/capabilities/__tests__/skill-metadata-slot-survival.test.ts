/**
 * The `SkillDefSchema.metadata` slot must SURVIVE parsing.
 *
 * Zod's `z.object` STRIPS unknown keys without an error. So a field a capability
 * definition declares but the schema does not list parses "successfully" and
 * silently disappears — the declared-but-dropped defect. For `metadata` that
 * failure is not cosmetic:
 *   - `readOnly` dropped    → a read verb stops auto-approving, proposes on every call
 *   - `allowedHosts` dropped → a code verb loses its egress allow-list, fails at run
 *
 * This test parses through the SAME `CapabilityDefinitionSchema` the apply door uses
 * (imported, never re-declared, so the two can't drift) and asserts the VALUE ARRIVES
 * in the parsed skill's `metadata`, not merely that parsing succeeded.
 *
 * WHAT IT DOES NOT COVER, measured: this tests the schema INPUT door. The projection
 * (`projectSkillMetadata`), drift comparator (`capabilityDefinitionDrift`), and gate
 * consumption (`declaredReadOnly` / `declaredAllowedHosts`) are pinned separately in
 * `declared-read-only.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { CapabilityDefinitionSchema } from "../../../routers/hub-protocol/rest/capabilities.js";

describe("SkillDefSchema.metadata survives CapabilityDefinitionSchema.parse", () => {
  it("a skill declaring metadata.readOnly keeps it after parsing", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "test-readonly",
      name: "Test ReadOnly",
      tools: [],
      skills: [
        {
          name: "search_web",
          kind: "declarative",
          metadata: { readOnly: true },
        },
      ],
    });

    const skill = parsed.skills.find((s) => s.name === "search_web");
    expect(skill, "skill should exist").toBeDefined();
    expect(skill!.metadata).toBeDefined();
    expect(skill!.metadata!.readOnly).toBe(true);
  });

  it("a skill declaring metadata.allowedHosts keeps it after parsing", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "test-allowed-hosts",
      name: "Test AllowedHosts",
      tools: [],
      skills: [
        {
          name: "fetch_page",
          kind: "code",
          metadata: { allowedHosts: ["api.example.com", "cdn.example.com"] },
        },
      ],
    });

    const skill = parsed.skills.find((s) => s.name === "fetch_page");
    expect(skill, "skill should exist").toBeDefined();
    expect(skill!.metadata).toBeDefined();
    expect(skill!.metadata!.allowedHosts).toEqual(["api.example.com", "cdn.example.com"]);
  });

  it("a skill declaring BOTH readOnly and allowedHosts keeps BOTH after parsing", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "test-both",
      name: "Test Both",
      tools: [],
      skills: [
        {
          name: "search_and_fetch",
          kind: "declarative",
          metadata: { readOnly: true, allowedHosts: ["api.vendor.com"] },
        },
      ],
    });

    const skill = parsed.skills.find((s) => s.name === "search_and_fetch");
    expect(skill, "skill should exist").toBeDefined();
    expect(skill!.metadata).toBeDefined();
    expect(skill!.metadata!.readOnly).toBe(true);
    expect(skill!.metadata!.allowedHosts).toEqual(["api.vendor.com"]);
  });

  it("a skill WITHOUT metadata still parses fine (no crash, no invented defaults)", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "test-no-metadata",
      name: "Test No Metadata",
      tools: [],
      skills: [
        {
          name: "write_note",
          kind: "instruction",
          // no metadata key at all
        },
      ],
    });

    const skill = parsed.skills.find((s) => s.name === "write_note");
    expect(skill, "skill should exist").toBeDefined();
    expect(skill!.metadata).toBeUndefined();
  });

  it("multiple skills: some with metadata, some without — all survive correctly", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "test-mixed",
      name: "Test Mixed",
      tools: [],
      skills: [
        {
          name: "read_skill",
          kind: "declarative",
          metadata: { readOnly: true },
        },
        {
          name: "write_skill",
          kind: "instruction",
          // no metadata
        },
        {
          name: "code_skill",
          kind: "code",
          metadata: { allowedHosts: ["api.example.com"] },
        },
      ],
    });

    const readSkill = parsed.skills.find((s) => s.name === "read_skill");
    const writeSkill = parsed.skills.find((s) => s.name === "write_skill");
    const codeSkill = parsed.skills.find((s) => s.name === "code_skill");

    expect(readSkill!.metadata!.readOnly).toBe(true);
    expect(writeSkill!.metadata).toBeUndefined();
    expect(codeSkill!.metadata!.allowedHosts).toEqual(["api.example.com"]);
  });

  it("metadata slot accepts arbitrary extra keys (future-proofing) — they survive too", () => {
    const parsed = CapabilityDefinitionSchema.parse({
      key: "test-arbitrary",
      name: "Test Arbitrary",
      tools: [],
      skills: [
        {
          name: "future_skill",
          kind: "declarative",
          metadata: { readOnly: true, customKey: "customValue", another: 123 },
        },
      ],
    });

    const skill = parsed.skills.find((s) => s.name === "future_skill");
    expect(skill!.metadata).toEqual({
      readOnly: true,
      customKey: "customValue",
      another: 123,
    });
  });
});