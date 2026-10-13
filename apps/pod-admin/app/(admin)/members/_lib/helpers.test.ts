import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupByPrimaryRole,
  inviteExpiry,
  rolePillKind,
  type PodMember,
} from "./helpers";

const member = (id: string, primaryRole: PodMember["primaryRole"]) =>
  ({
    id,
    email: `${id}@x.test`,
    name: null,
    avatarUrl: null,
    primaryRole,
    workspaceCount: 0,
    workspaces: [],
  }) satisfies PodMember;

describe("groupByPrimaryRole", () => {
  it("buckets every member under its primary role, keeping order", () => {
    const g = groupByPrimaryRole([
      member("a", "editor"),
      member("b", "owner"),
      member("c", "editor"),
    ]);
    expect(g.owner.map((m) => m.id)).toEqual(["b"]);
    expect(g.editor.map((m) => m.id)).toEqual(["a", "c"]);
    expect(g.admin).toEqual([]);
    expect(g.viewer).toEqual([]);
  });
});

describe("rolePillKind", () => {
  it("owner is healthy, admin stands out, the rest are neutral", () => {
    expect(rolePillKind("owner")).toBe("healthy");
    expect(rolePillKind("admin")).toBe("stale");
    expect(rolePillKind("editor")).toBe("unknown");
    expect(rolePillKind("something-new")).toBe("unknown");
  });
});

describe("inviteExpiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("says when a live invite runs out", () => {
    expect(inviteExpiry(new Date("2026-10-15T12:00:00Z"))).toBe(
      "expires in 3d"
    );
    expect(inviteExpiry("2026-10-12T15:00:00Z")).toBe("expires in 3h");
  });

  it("says expired once the moment has passed", () => {
    expect(inviteExpiry(new Date("2026-10-12T11:00:00Z"))).toBe("expired");
  });

  it("never renders an unparseable date as a time", () => {
    expect(inviteExpiry("not a date")).toBe("no expiry date");
  });
});
