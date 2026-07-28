import { describe, it, expect } from "vitest";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import {
  countCreateEntityByProfile,
  minCountForSlug,
  chooseViewHint,
  resolveViewWorkspaceId,
  MAX_VIEW_PROPOSALS_PER_IMPORT,
} from "./suggest-views.js";

function ent(
  profileSlug: string,
  opts?: { targetWorkspaceId?: string; existingEntityId?: string }
): CompositeProposalOperation {
  return {
    op: "create_entity",
    profileSlug,
    ...opts,
  };
}

describe("countCreateEntityByProfile", () => {
  it("counts by slug and skips relations + existingEntityId links", () => {
    const ops: CompositeProposalOperation[] = [
      ent("person", { targetWorkspaceId: "ws-a" }),
      ent("person", { targetWorkspaceId: "ws-a" }),
      ent("note"),
      ent("person", { existingEntityId: "already-there" }),
      { op: "create_relation", type: "knows", sourceRef: "a", targetRef: "b" },
    ];
    const counts = countCreateEntityByProfile(ops);
    expect(counts).toEqual([
      { profileSlug: "person", count: 2, workspaceHomes: ["ws-a"] },
      { profileSlug: "note", count: 1, workspaceHomes: [] },
    ]);
  });
});

describe("minCountForSlug", () => {
  it("is 1 for task/todo and 2 otherwise", () => {
    expect(minCountForSlug("task")).toBe(1);
    expect(minCountForSlug("todo")).toBe(1);
    expect(minCountForSlug("person")).toBe(2);
    expect(minCountForSlug("note")).toBe(2);
  });
});

describe("chooseViewHint", () => {
  it("maps slug keywords to list/table without product-domain names", () => {
    expect(chooseViewHint("task", "Task")).toEqual({
      type: "list",
      name: "To-dos",
    });
    expect(chooseViewHint("person", "Person")).toEqual({
      type: "table",
      name: "Person",
    });
    expect(chooseViewHint("note", "Note")).toEqual({
      type: "list",
      name: "Note list",
    });
    expect(chooseViewHint("knowledge", "Knowledge")).toEqual({
      type: "table",
      name: "Knowledge",
    });
  });
});

describe("resolveViewWorkspaceId", () => {
  it("prefers a single shared home, else ctx, else null", () => {
    expect(resolveViewWorkspaceId(["ws-1"], "ctx-ws")).toBe("ws-1");
    expect(resolveViewWorkspaceId(["ws-1", "ws-2"], "ctx-ws")).toBe("ctx-ws");
    expect(resolveViewWorkspaceId([], null)).toBe(null);
  });
});

describe("MAX_VIEW_PROPOSALS_PER_IMPORT", () => {
  it("caps at 5", () => {
    expect(MAX_VIEW_PROPOSALS_PER_IMPORT).toBe(5);
  });
});
