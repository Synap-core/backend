import { describe, expect, it } from "vitest";
import { documentRailPinKey } from "./index.js";
import { goalRailPinKey } from "../units/index.js";

describe("documentRailPinKey", () => {
  it("pins a document under the doc: key, apart from a goal's", () => {
    expect(documentRailPinKey("d1")).toBe("doc:d1");
    // One id, two surfaces: the keys never collide.
    expect(documentRailPinKey("x")).not.toBe(goalRailPinKey("x"));
  });
});
