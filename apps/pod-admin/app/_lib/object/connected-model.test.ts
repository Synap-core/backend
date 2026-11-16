import { describe, expect, it } from "vitest";
import { connectedGroups, hasConnected } from "./connected-model";

const SELF = "8d6d5a59-16b8-4d33-a4de-8499487e104c";
const png = {
  id: "a",
  title: "quote-card-169.png",
  type: "file",
  documentId: "d1",
  properties: { mimeType: "image/png" },
};
const html = {
  id: "b",
  title: "quote-card.html",
  type: "file",
  documentId: "d2",
  properties: { mimeType: "text/html" },
};

describe("connectedGroups", () => {
  it("sorts a brand asset's neighbours by how they read", () => {
    const g = connectedGroups(
      [png, html, { id: "c", title: "Brand", type: "brand-reference" }],
      SELF
    );
    expect(g.images.map((i) => i.id)).toEqual(["a"]);
    expect(g.pages.map((i) => i.id)).toEqual(["b"]);
    expect(g.others.map((i) => [i.id, i.kind])).toEqual([
      ["c", "brand-reference"],
    ]);
  });

  it("never lists the object itself, a deleted neighbour, a repeat or an idless row", () => {
    const g = connectedGroups(
      [
        { id: SELF, title: "me" },
        { ...png, deletedAt: "2026-11-01" },
        { ...html },
        { ...html },
        { title: "no id" },
      ],
      SELF
    );
    expect(g.images).toEqual([]);
    expect(g.pages.map((i) => i.id)).toEqual(["b"]);
    expect(g.others).toEqual([]);
  });

  it("only draws an image or a page it can load: no document, it stays a door", () => {
    const g = connectedGroups(
      [
        { ...png, documentId: null },
        { ...html, documentId: null },
      ],
      SELF
    );
    expect(g.images).toEqual([]);
    expect(g.pages).toEqual([]);
    expect(g.others).toHaveLength(2);
  });

  it("is empty for no neighbours", () => {
    expect(hasConnected(connectedGroups([], SELF))).toBe(false);
    expect(hasConnected(connectedGroups([png], SELF))).toBe(true);
  });
});
