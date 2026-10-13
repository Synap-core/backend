import { describe, it, expect } from "vitest";
import {
  importBuildEstimate,
  importContentStatusFor,
  importCounts,
  importGroupKey,
  importHostOf,
  importItemInstructions,
  importItemsInGroup,
  importPlatformOf,
  isImportSession,
  readImportCuration,
  type ImportGroup,
  type ImportItemView,
} from "./curate.js";

function item(over: Partial<ImportItemView> & { id: string }): ImportItemView {
  return {
    title: over.id,
    source: { kind: "url", url: "https://example.com" },
    contentStatus: "readable",
    decision: "keep",
    groupKeys: [],
    stagedAt: "2026-10-12T00:00:00.000Z",
    ...over,
  };
}

const group = (key: string, over: Partial<ImportGroup> = {}): ImportGroup => ({
  key,
  name: key,
  origin: "ai",
  outputs: ["things"],
  ...over,
});

describe("importPlatformOf / importHostOf — platform from the host only", () => {
  it("recognises the platforms, subdomains included", () => {
    expect(importPlatformOf("https://www.youtube.com/watch?v=x")).toBe(
      "youtube"
    );
    expect(importPlatformOf("https://youtu.be/x")).toBe("youtube");
    expect(importPlatformOf("https://m.youtube.com/watch?v=x")).toBe("youtube");
    expect(importPlatformOf("https://www.instagram.com/reel/abc")).toBe(
      "instagram"
    );
    expect(importPlatformOf("https://vm.tiktok.com/x")).toBe("tiktok");
    expect(importPlatformOf("https://twitter.com/a/status/1")).toBe("x");
    expect(importPlatformOf("https://github.com/a/b")).toBe("github");
  });

  it("an unknown host is web; a non-URL is null", () => {
    expect(importPlatformOf("https://blog.example.org/post")).toBe("web");
    expect(importPlatformOf("not a url")).toBeNull();
    expect(importHostOf("https://www.Example.com/a")).toBe("example.com");
  });

  it("does not match a host that merely ends with the same letters", () => {
    expect(importPlatformOf("https://notyoutube.com/x")).toBe("web");
  });
});

describe("importContentStatusFor — what Build may read, from metadata alone", () => {
  it("never plans to scrape Instagram or TikTok", () => {
    expect(importContentStatusFor({ kind: "url", platform: "instagram" })).toBe(
      "needs_file"
    );
    expect(importContentStatusFor({ kind: "url", platform: "tiktok" })).toBe(
      "needs_file"
    );
  });
  it("YouTube is captions, X/LinkedIn title only, the web readable", () => {
    expect(importContentStatusFor({ kind: "url", platform: "youtube" })).toBe(
      "captions"
    );
    expect(importContentStatusFor({ kind: "url", platform: "x" })).toBe(
      "title_only"
    );
    expect(importContentStatusFor({ kind: "url", platform: "linkedin" })).toBe(
      "title_only"
    );
    expect(importContentStatusFor({ kind: "url", platform: "web" })).toBe(
      "readable"
    );
  });
  it("a file is a file, typed text is readable", () => {
    expect(importContentStatusFor({ kind: "file" })).toBe("file");
    expect(importContentStatusFor({ kind: "text" })).toBe("readable");
  });
});

describe("readImportCuration / isImportSession", () => {
  it("reads a valid curation and defaults its groups", () => {
    const c = readImportCuration({
      importCuration: { version: 1, phase: "curating", updatedAt: "t" },
    });
    expect(c).toMatchObject({ phase: "curating", groups: [] });
    expect(
      isImportSession({ importCuration: { version: 1, phase: "collecting" } })
    ).toBe(true);
  });
  it("refuses a missing, wrong-version or unknown-phase curation", () => {
    expect(readImportCuration(null)).toBeNull();
    expect(readImportCuration({ intake: {} })).toBeNull();
    expect(
      readImportCuration({ importCuration: { version: 2, phase: "curating" } })
    ).toBeNull();
    expect(
      readImportCuration({ importCuration: { version: 1, phase: "sorting" } })
    ).toBeNull();
    expect(isImportSession({})).toBe(false);
  });
});

describe("importBuildEstimate — the same rule Build applies", () => {
  it("counts reads, needs-file, title-only and skipped per group", () => {
    const items = [
      item({ id: "a", groupKeys: ["g"] }),
      item({ id: "b", groupKeys: ["g"], contentStatus: "needs_file" }),
      item({ id: "c", groupKeys: ["g"], contentStatus: "title_only" }),
      item({ id: "d", groupKeys: ["g"], decision: "later" }),
      item({ id: "e", groupKeys: ["g"], decision: "exclude" }),
      item({ id: "f", groupKeys: ["other"] }),
      item({ id: "h", groupKeys: ["g"], contentStatus: "file" }),
    ];
    expect(importBuildEstimate(items, "g")).toEqual({
      willRead: 2,
      needsFile: 1,
      titleOnly: 1,
      skipped: 2,
    });
    expect(importItemsInGroup(items, "g").map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "h",
    ]);
  });
});

describe("importCounts", () => {
  it("counts decisions, notes and items with no LIVE group", () => {
    const groups = [
      group("g", { note: "Make a watch list" }),
      group("h", { note: "  " }),
    ];
    const items = [
      item({ id: "a", groupKeys: ["g", "h"] }),
      item({ id: "b", groupKeys: ["gone"], decision: "later" }),
      item({ id: "c", groupKeys: [], decision: "exclude" }),
    ];
    expect(importCounts(items, groups)).toEqual({
      items: 3,
      keep: 1,
      later: 1,
      excluded: 1,
      groups: 2,
      groupsWithNote: 1,
      ungrouped: 2,
    });
  });
});

describe("importItemInstructions — only the person's words steer", () => {
  it("joins every group note the item is in, then its own note", () => {
    const groups = [
      group("films", { name: "Films", note: "A list to watch, with year" }),
      group("other", { name: "Other", note: "ignored" }),
      group("talks", { name: "Talks", note: "  " }),
    ];
    expect(
      importItemInstructions(
        { groupKeys: ["films", "talks"], note: "Rewatch" },
        groups
      )
    ).toBe('Group "Films": A list to watch, with year\nThis item: Rewatch');
  });
  it("is empty when nobody wrote anything", () => {
    expect(
      importItemInstructions({ groupKeys: ["films"] }, [group("films")])
    ).toBe("");
  });
});

describe("importGroupKey", () => {
  it("slugs a name and avoids taken keys", () => {
    expect(importGroupKey("Films to watch")).toBe("films-to-watch");
    expect(importGroupKey("Café recipes")).toBe("cafe-recipes");
    expect(importGroupKey("Films to watch", ["films-to-watch"])).toBe(
      "films-to-watch-2"
    );
    expect(importGroupKey("!!!")).toBe("group");
  });
});
