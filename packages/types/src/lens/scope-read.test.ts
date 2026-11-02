import { describe, expect, it } from "vitest";
import { lensScopeIds, readLensScope, type LensScope } from "./scope.js";

const W = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";
const S = "44444444-4444-4444-8444-444444444444";

describe("readLensScope — the stored scope object", () => {
  const valid: LensScope[] = [
    { kind: "pod" },
    { kind: "workspace", workspaceId: W },
    { kind: "workspace", workspaceId: W, projectId: P },
    { kind: "project", projectId: P },
    { kind: "track", trackId: T, projectId: P },
    { kind: "session", sessionId: S, trackId: T },
    { kind: "pipeline", profileSlug: "lead", workspaceId: W },
  ];
  it.each(valid)("reads back exactly what was written: %j", (scope) => {
    expect(readLensScope(scope)).toEqual({ ok: true, scope });
  });

  it("drops a null container (same meaning as absent)", () => {
    expect(
      readLensScope({ kind: "workspace", workspaceId: W, projectId: null })
    ).toEqual({ ok: true, scope: { kind: "workspace", workspaceId: W } });
  });

  it.each([
    [null, /object/],
    ["project:" + P, /object/],
    [{ kind: "space", workspaceId: W }, /kind/],
    [{ kind: "project" }, /needs `projectId`/],
    [{ kind: "project", projectId: "my-project" }, /UUID/],
    [{ kind: "pod", workspaceId: W }, /no `workspaceId`/],
    [{ kind: "workspace", workspaceId: W, sessionId: S }, /no `sessionId`/],
    [{ kind: "pipeline", profileSlug: "Not A Slug" }, /slug/],
  ])("refuses %j with the reason", (value, reason) => {
    const read = readLensScope(value);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.reason).toMatch(reason);
  });
});

describe("lensScopeIds", () => {
  it("names the scope's own id and every container it carries", () => {
    expect(
      lensScopeIds({ kind: "session", sessionId: S, trackId: T, projectId: P })
    ).toEqual({
      workspaceIds: [],
      projectIds: [P],
      trackIds: [T],
      sessionIds: [S],
    });
    expect(lensScopeIds({ kind: "pod" })).toEqual({
      workspaceIds: [],
      projectIds: [],
      trackIds: [],
      sessionIds: [],
    });
  });
});
