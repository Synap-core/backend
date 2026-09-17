/**
 * Firewalls for the from-intent conductor: the topic files exist, catalog
 * teaching points at them, and agent-os is NOT the schema/intent conductor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../skills"
);

describe("from-intent conductor firewalls", () => {
  it("conductor + extend-first topics exist", () => {
    expect(existsSync(join(ROOT, "synap/from-intent.md"))).toBe(true);
    expect(existsSync(join(ROOT, "synap-schema/extend-first.md"))).toBe(true);
  });

  it("from-intent says hats are any kind and defers domain install to agent-os", () => {
    const src = readFileSync(join(ROOT, "synap/from-intent.md"), "utf8");
    expect(src).toMatch(/any kind/i);
    expect(src).toMatch(/agent-os/);
    expect(src).toMatch(/extend-first/);
    expect(src).toMatch(/one next write/i);
    expect(src).toMatch(/twin/);
    expect(src).toMatch(/7-step/);
    expect(src.length).toBeGreaterThan(400);
  });

  it("agent-os When NOT points at from-intent", () => {
    const src = readFileSync(join(ROOT, "agent-os/SKILL.md"), "utf8");
    expect(src).toMatch(/from-intent/);
    expect(src).toMatch(/When NOT to use this skill/);
  });

  it("_teaching.json lists both topics", () => {
    const json = JSON.parse(
      readFileSync(join(ROOT, "_teaching.json"), "utf8")
    ) as Record<string, unknown>;
    expect(json["synap/from-intent"]).toBeTruthy();
    expect(json["synap-schema/extend-first"]).toBeTruthy();
  });
});
