/**
 * The light read's production deps hand the reader door the PERSON's context:
 * every space they can see (`allSpaces`), the item's own space as the lens.
 * A pod-wide kept post must reach a reader installed in a space (the door then
 * runs that verb in its own space — `url-readers.spaces.pglite.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  read: [] as unknown[],
  list: [] as unknown[],
}));

vi.mock("../../capabilities/url-readers.js", () => ({
  readUrl: async (ctx: unknown) => {
    calls.read.push(ctx);
    return { read: { status: "ok" }, offers: [] };
  },
  listReadersForUrl: async (ctx: unknown) => {
    calls.list.push(ctx);
    return [];
  },
}));

import { defaultLightReadDeps } from "../light-read-deps.js";

describe("defaultLightReadDeps — the reader door context", () => {
  it("reads and lists with every space the person can see", async () => {
    const deps = defaultLightReadDeps({
      database: {} as never,
      userId: "u1",
      workspaceId: "ws-kept",
    });
    await deps.readUrl("https://www.instagram.com/p/a", { allowBilled: false });
    await deps.readers("https://www.instagram.com/p/a");
    const want = { userId: "u1", workspaceId: "ws-kept", allSpaces: true };
    expect(calls.read).toEqual([want]);
    expect(calls.list).toEqual([want]);
  });
});
