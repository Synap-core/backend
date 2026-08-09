import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillRoot = new URL("../../../../skills/synap/", import.meta.url);
const sourceFiles = [
  "mental-model.md",
  "quick-reference.md",
  "cli-operations.md",
  "worked-examples.md",
];
const generatedPath = fileURLToPath(new URL("SKILL.md", skillRoot));

describe("tripwire: Knowledge skill vocabulary", () => {
  it("keeps the source skill on the canonical one-form Knowledge contract", () => {
    const body = sourceFiles
      .map((name) => readFileSync(new URL(name, skillRoot), "utf8"))
      .join("\n");
    expect(body, "source skill must name knowledgeForm").toContain(
      "knowledgeForm"
    );
    expect(body, "source skill must name insight").toContain("insight");
    expect(body, "source skill must name caution").toContain("caution");
    expect(
      body,
      "source skill must teach the canonical Markdown body door"
    ).toContain("--content");
    for (const name of sourceFiles) {
      const source = readFileSync(new URL(name, skillRoot), "utf8");
      expect(
        source,
        `${name} must not describe legacy ek_type as the active discriminator`
      ).not.toMatch(/ek_type[^\n]{0,160}(discriminates|canonical)/i);
    }
  });

  it("keeps the generated skill aligned with the source contract", () => {
    const body = readFileSync(generatedPath, "utf8");
    expect(body).toContain("knowledgeForm");
    expect(body).toContain("insight");
    expect(body).toContain("caution");
    expect(body).toContain("--content");
    expect(body).toContain(
      "Decisions and sources remain linked first-class entities"
    );
    expect(body).not.toMatch(/ek_type[^\n]{0,160}(discriminates|canonical)/i);
  });
});
