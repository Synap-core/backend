/**
 * Typesense `filter_by` is a string the search service builds from caller
 * input. Every caller-supplied value lands inside a backtick literal, so a
 * value carrying a backtick could close the literal and append its own clause:
 * `tags: ["x` || userId:!=`z"]` turned the per-user floor into "every row".
 *
 * These assertions are on the BUILT filter string (what Typesense receives),
 * through the real `buildFilter`; nothing is mocked.
 */

import { describe, it, expect } from "vitest";
import {
  SearchService,
  InvalidSearchFilterError,
  filterLiteral,
} from "./search-service.js";

const USER = "11111111-2222-3333-4444-555555555555";
const HOSTILE = "x` || userId:!=`z";

type BuildFilter = (options: Record<string, unknown>) => string;
const build = (options: Record<string, unknown>): string =>
  (new SearchService() as unknown as { buildFilter: BuildFilter }).buildFilter(
    options
  );

describe("search filter_by: caller strings cannot alter the filter", () => {
  it("a benign filter keeps the floor as its own first clause", () => {
    const f = build({
      userId: USER,
      collection: "entities",
      tags: ["urgent"],
      entityTypes: ["task", "note"],
    });
    expect(f).toBe(
      `(userId:=\`${USER}\`) && (entityType:=(\`task\`|\`note\`)) && (tags:=\`urgent\`)`
    );
  });

  it.each([
    ["tags", { tags: [HOSTILE] }],
    ["entityTypes", { collection: "entities", entityTypes: [HOSTILE] }],
    ["documentTypes", { collection: "documents", documentTypes: [HOSTILE] }],
    ["viewTypes", { collection: "views", viewTypes: [HOSTILE] }],
    ["status", { status: [HOSTILE] }],
    ["workspaceId", { workspaceId: HOSTILE }],
    ["channelId", { channelId: HOSTILE }],
  ])("a hostile %s is refused, never interpolated", (_field, extra) => {
    let built: string | undefined;
    let error: unknown;
    try {
      built = build({ userId: USER, ...extra });
    } catch (err) {
      error = err;
    }
    expect(built).toBeUndefined();
    expect(error).toBeInstanceOf(InvalidSearchFilterError);
    expect((error as InvalidSearchFilterError).statusCode).toBe(400);
  });

  it("a backslash is refused too (no escape sequence reaches Typesense)", () => {
    expect(() => filterLiteral("a\\`", "tags")).toThrow(
      InvalidSearchFilterError
    );
    expect(() => filterLiteral("a\\b", "tags")).toThrow(
      InvalidSearchFilterError
    );
  });

  it("ordinary values with spaces, dots, colons and unicode still pass", () => {
    expect(filterLiteral("Café v2.0: draft", "tags")).toBe(
      "`Café v2.0: draft`"
    );
  });
});
