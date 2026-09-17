/**
 * Unit tests for cache-sync search-token derivation. Pure — no DB.
 * Keep assertions aligned with the CP copy
 * (`synap-control-plane-api/src/seeds/package-search-tokens.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  derivePackageSearchTokens,
  mergePackageSearchTags,
} from "../package-search-tokens.js";

const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package-search-tokens.ts"
);

describe("derivePackageSearchTokens", () => {
  it("non-vacuity: this module is the derivation function", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/export function derivePackageSearchTokens/);
    expect(src).toMatch(/dependencies/);
    expect(src).toMatch(/playbooks/);
    expect(src).toMatch(/templateKey/);
    expect(src).toMatch(/goalTemplate/);
    expect(src).toMatch(/meta\.tags/);
  });

  it("extracts dep slugs, playbook names/goals, capability keys, and domain", () => {
    const tokens = derivePackageSearchTokens(
      {
        domain: "content",
        meta: { tags: ["suite"], domain: "content" },
        dependencies: [{ slug: "content-os", name: "Content OS" }],
        playbooks: [
          {
            name: "Produce Content",
            goalTemplate: "Shape the idea into a creation draft.",
          },
        ],
        capabilities: [{ templateKey: "content.editorial" }],
      },
      { domain: "content" }
    );
    expect(tokens).toContain("suite");
    expect(tokens).toContain("content");
    expect(tokens).toContain("content-os");
    expect(tokens).toContain("produce content");
    expect(tokens).toContain("creation");
    expect(tokens).toContain("content.editorial");
    expect(tokens).toContain("editorial");
  });
});

describe("mergePackageSearchTags", () => {
  it("keeps authored tags first, then derived, deduped", () => {
    const merged = mergePackageSearchTags(["Suite", "content"], {
      dependencies: [{ slug: "content-os" }],
      playbooks: [{ name: "Produce Content" }],
    });
    expect(merged[0]).toBe("suite");
    expect(merged[1]).toBe("content");
    expect(merged).toContain("content-os");
    expect(merged.filter((t) => t === "content").length).toBe(1);
  });

  it("passes authored tags through when definition is absent (list cache)", () => {
    expect(mergePackageSearchTags(["suite", "content"], null)).toEqual([
      "suite",
      "content",
    ]);
  });
});
