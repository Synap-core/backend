import { describe, it, expect } from "vitest";
import { __readTemplateIdArgForTest as readTemplateIdArg } from "./session.js";

/**
 * The playbook a session starts from, off the MCP wire (ticket 0d4c2170).
 *
 * Observed live 2026-10-23: session 9a6a3528 stored `templateId: "null"` — a
 * client sent JSON null as the string "null", and the door took any string.
 */
describe("readTemplateIdArg — a playbook UUID, null, or refused in words", () => {
  const PLAYBOOK = "3f2c8a51-6b0e-4c1d-9e7a-2b5d4f6a8c90";

  it("a playbook UUID passes through", () => {
    expect(readTemplateIdArg(PLAYBOOK)).toBe(PLAYBOOK);
  });

  it("THE LIVE CASE: the string 'null' is the null opt-out, never stored", () => {
    expect(readTemplateIdArg("null")).toBeNull();
    expect(readTemplateIdArg(null)).toBeNull();
  });

  it("absent stays absent (match the playbooks)", () => {
    expect(readTemplateIdArg(undefined)).toBeUndefined();
    expect(readTemplateIdArg("  ")).toBeUndefined();
  });

  it("any other non-UUID string refuses and says what to pass", () => {
    expect(() => readTemplateIdArg("client-onboarding")).toThrow(
      /playbook UUID.*list_playbooks.*null/
    );
  });
});
