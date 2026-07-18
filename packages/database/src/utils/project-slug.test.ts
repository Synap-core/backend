import { describe, it, expect } from "vitest";
import { slugifyProjectName, uniquifyProjectSlug } from "./project-slug.js";

describe("slugifyProjectName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyProjectName("Ethical Fashion")).toBe("ethical-fashion");
    expect(slugifyProjectName("Synap")).toBe("synap");
  });

  it("collapses runs of separators/punctuation into one hyphen", () => {
    expect(slugifyProjectName("Client X — Q3 (2026)")).toBe("client-x-q3-2026");
    expect(slugifyProjectName("a  __  b")).toBe("a-b");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugifyProjectName("  !!Launch!!  ")).toBe("launch");
  });

  it("strips non-ascii letters (SQL parity: [^a-z0-9] only)", () => {
    // 'é' is not in [a-z0-9] so it becomes a separator — identical to the
    // SQL backfill regexp_replace in 0200_project_slug.sql.
    expect(slugifyProjectName("Café Robots")).toBe("caf-robots");
    expect(slugifyProjectName("Überproject")).toBe("berproject");
  });

  it("falls back to 'project' for empty / emoji-only / non-latin names", () => {
    expect(slugifyProjectName("")).toBe("project");
    expect(slugifyProjectName("🚀🚀🚀")).toBe("project");
    expect(slugifyProjectName("日本語")).toBe("project");
    expect(slugifyProjectName("---")).toBe("project");
  });

  it("keeps digits", () => {
    expect(slugifyProjectName("Q3 2026")).toBe("q3-2026");
  });
});

describe("uniquifyProjectSlug", () => {
  it("returns the base when free", () => {
    expect(uniquifyProjectSlug("synap", [])).toBe("synap");
    expect(uniquifyProjectSlug("synap", ["other"])).toBe("synap");
  });

  it("appends -2 on first collision (per-user convention)", () => {
    expect(uniquifyProjectSlug("synap", ["synap"])).toBe("synap-2");
  });

  it("finds the first free numeric suffix", () => {
    expect(uniquifyProjectSlug("synap", ["synap", "synap-2", "synap-3"])).toBe(
      "synap-4"
    );
    // Holes are reused — the first free suffix wins.
    expect(uniquifyProjectSlug("synap", ["synap", "synap-3"])).toBe("synap-2");
  });

  it("matches the migration backfill's fallback base collisions", () => {
    // Two emoji-only projects both slugify to 'project' → second gets -2.
    const first = slugifyProjectName("🚀");
    const second = uniquifyProjectSlug(slugifyProjectName("✨"), [first]);
    expect(first).toBe("project");
    expect(second).toBe("project-2");
  });
});
