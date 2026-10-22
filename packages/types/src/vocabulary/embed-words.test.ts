import { describe, expect, it } from "vitest";
import { describeEmbed } from "../renderables/index.js";
import { resolveEmbedWords } from "./index.js";

const words = (kind: string, attrs: Record<string, string>, props?: Record<string, unknown>) =>
  resolveEmbedWords(describeEmbed({ kind, attrs, props }));

describe("resolveEmbedWords — every embed is named, never blank, never a raw key", () => {
  it("charts: the catalog name, or the authored label", () => {
    expect(words("cell", { cellKey: "chart-bar" })).toEqual({
      noun: "Chart",
      label: "Bar Chart",
    });
    expect(
      words("cell", { cellKey: "chart-bar" }, { label: "Tasks", data: "oops" })
    ).toEqual({ noun: "Chart", label: "Tasks" });
  });

  it("a sandboxed cell is named by its key's own name, not its namespace", () => {
    expect(words("cell", { cellKey: "generated:weekly-pulse" })).toEqual({
      noun: "Card",
      label: "Weekly pulse",
    });
    expect(words("cell", { cellKey: "cell:acme.pack:deal_board" }).label).toBe(
      "Deal board"
    );
    expect(words("cell", { instanceId: "i-1" })).toEqual({
      noun: "Card",
      label: "Card",
    });
  });

  it("a view is named by its type; an entity by its authored label or noun", () => {
    expect(words("view", { viewId: "v", viewType: "kanban" })).toEqual({
      noun: "View",
      label: "Kanban view",
    });
    expect(words("view", { viewId: "v" }).label).toBe("View");
    expect(words("entity", { id: "e" })).toEqual({
      noun: "Entity",
      label: "Entity",
    });
    expect(words("entity", { id: "e", label: "Ana" }).label).toBe("Ana");
  });

  it("unknown keys and kinds humanize; broken ones say their noun", () => {
    expect(words("cell", { cellKey: "mystery-widget" })).toEqual({
      noun: "Card",
      label: "Mystery widget",
    });
    expect(words("instance", {})).toEqual({ noun: "Instance", label: "Instance" });
    expect(words("entity", {})).toEqual({ noun: "Entity", label: "Entity" });
  });
});
