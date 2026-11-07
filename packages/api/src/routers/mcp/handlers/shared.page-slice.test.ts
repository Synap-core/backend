/**
 * `pageSlice`: the one paging shape of the in-memory list doors (workspaces,
 * goals, agents, graph neighbours). Walked to the end like `list-paging.test.ts`:
 * the union of pages is the whole list, no row twice, and only a page with
 * more behind it carries `nextOffset`.
 */
import { describe, it, expect } from "vitest";
import { pageSlice, LIST_PAGE_DEFAULT, LIST_PAGE_MAX } from "./shared.js";

const rows = Array.from({ length: 120 }, (_, i) => i);

describe("pageSlice", () => {
  it("defaults to LIST_PAGE_DEFAULT rows and reports the total", () => {
    const { page, paging } = pageSlice(
      rows,
      {},
      LIST_PAGE_DEFAULT,
      LIST_PAGE_MAX
    );
    expect(page).toHaveLength(LIST_PAGE_DEFAULT);
    expect(paging).toEqual({ total: 120, offset: 0, nextOffset: 50 });
  });

  it("walks every page: whole list once, last page has no nextOffset", () => {
    const seen: number[] = [];
    let offset: number | undefined = 0;
    let last:
      { total: number; offset: number; nextOffset?: number } | undefined;
    while (offset !== undefined) {
      const { page, paging } = pageSlice(
        rows,
        { limit: 40, offset },
        LIST_PAGE_DEFAULT,
        LIST_PAGE_MAX
      );
      seen.push(...page);
      last = paging;
      offset = paging.nextOffset;
    }
    expect(seen).toEqual(rows);
    expect(last).not.toHaveProperty("nextOffset");
  });

  it("clamps an over-large limit to the max", () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    const { page } = pageSlice(big, { limit: 9999 }, 50, LIST_PAGE_MAX);
    expect(page).toHaveLength(LIST_PAGE_MAX);
  });
});
