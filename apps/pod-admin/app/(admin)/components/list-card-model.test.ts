import { describe, expect, it } from "vitest";
import { listCardState, pageWindow } from "./list-card-model";

describe("listCardState", () => {
  it("a failed read is an error, never the empty state", () => {
    expect(listCardState({ loading: false, isError: true, rowCount: 0 })).toBe(
      "error"
    );
  });
  it("first load shows the skeleton; a refetch keeps the rows", () => {
    expect(listCardState({ loading: true, isError: false, rowCount: 0 })).toBe(
      "loading"
    );
    expect(listCardState({ loading: true, isError: false, rowCount: 3 })).toBe(
      "rows"
    );
  });
  it("no rows and no error is empty", () => {
    expect(listCardState({ loading: false, isError: false, rowCount: 0 })).toBe(
      "empty"
    );
  });
});

describe("pageWindow", () => {
  it("walks an offset-paged list", () => {
    expect(pageWindow(0, 50, 120)).toMatchObject({
      page: 1,
      pageCount: 3,
      hasPrev: false,
      hasNext: true,
      nextOffset: 50,
    });
    expect(pageWindow(100, 50, 120)).toMatchObject({
      page: 3,
      hasNext: false,
      prevOffset: 50,
    });
    expect(pageWindow(0, 50, 0).pageCount).toBe(1);
  });
});
