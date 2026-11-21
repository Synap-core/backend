import { describe, it, expect } from "vitest";
import { cellTypeKeyFor, cellTypeKeysFor } from "./define-cell.js";

/**
 * Tickets 6c15da33 / 253b7408: "Page cédant" became `generated:page-c-dant`,
 * a key nobody could guess, so binding the cell by its readable name failed.
 */
describe("cell type key", () => {
  it("folds accents instead of cutting the word", () => {
    expect(cellTypeKeyFor("Page cédant")).toBe("generated:page-cedant");
    expect(cellTypeKeyFor("Pipeline Étudiants")).toBe(
      "generated:pipeline-etudiants"
    );
  });

  it("an explicit typeKey wins and has no legacy twin", () => {
    expect(cellTypeKeysFor("Page cédant", "mine:key")).toEqual(["mine:key"]);
  });

  it("an accented name also answers to its legacy key, so stored cells still resolve", () => {
    expect(cellTypeKeysFor("Page cédant")).toEqual([
      "generated:page-cedant",
      "generated:page-c-dant",
    ]);
  });

  it("a plain name has one key", () => {
    expect(cellTypeKeysFor("Deal board")).toEqual(["generated:deal-board"]);
  });
});
