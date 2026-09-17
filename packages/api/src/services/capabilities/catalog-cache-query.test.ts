/**
 * Catalog-cache ranking fixture: a package whose displayName does NOT contain
 * the query still ranks above zero when derived tags (from a playbook / dep
 * slug) do. Non-vacuity: the scan finds `derivePackageSearchTokens`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankByTerms } from "../../utils/term-match.js";
import {
  derivePackageSearchTokens,
  mergePackageSearchTags,
} from "../../../../jobs/src/workers/package-search-tokens.js";

const DERIVATION_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../jobs/src/workers/package-search-tokens.ts"
);

describe("catalog cache — derived tags are what rankByTerms reads", () => {
  it("non-vacuity: scan finds the derivation function", () => {
    const src = readFileSync(DERIVATION_SRC, "utf8");
    expect(src.length).toBeGreaterThan(500);
    expect(src).toMatch(/export function derivePackageSearchTokens/);
    expect(src).toMatch(/dependencies/);
    expect(src).toMatch(/playbooks/);
    expect(src).toMatch(/templateKey/);
  });

  it("a silent displayName still ranks above zero for 'content creation' via playbook/dep tokens", () => {
    const definition = {
      dependencies: [{ slug: "content-os" }],
      playbooks: [
        {
          name: "Studio pipeline",
          goalTemplate:
            "Run the content creation pipeline from idea to render.",
        },
      ],
    };
    // Display name deliberately does NOT contain "content" or "creation".
    const pkg = {
      name: "Enterprise OS",
      description: "Company operating core.",
      tags: mergePackageSearchTags([], definition),
    };
    expect(pkg.name.toLowerCase()).not.toContain("content");
    expect(pkg.name.toLowerCase()).not.toContain("creation");
    expect(
      derivePackageSearchTokens(definition).some((t) => t.includes("content"))
    ).toBe(true);

    const ranked = rankByTerms("content creation", [pkg], (entry) => ({
      primary: entry.name,
      secondary: entry.tags,
      tertiary: entry.description,
    }));
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.item.name).toBe("Enterprise OS");
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });
});
