/**
 * Home's shared words (en + fr): sound catalogs, and the key list the phone
 * and the browser read, pinned (a renamed key strands both surfaces).
 */
import { describe, expect, it } from "vitest";
import { catalogProblems } from "../i18n/index.js";
import { homeCopy, homeT } from "./home-copy.js";

describe("home copy", () => {
  it("the French catalog has every key, the same arguments, no extra", () => {
    expect(catalogProblems(homeCopy)).toEqual([]);
  });

  it("the section titles and the badge read in both languages", () => {
    expect(homeT("en")("home.yours.title")).toBe("Your move");
    expect(homeT("fr")("home.yours.title")).toBe("À vous");
    expect(homeT("fr")("home.moving.title")).toBe("Ça avance sans vous");
    expect(homeT("fr")("home.moving.all")).toBe("Tout voir");
    expect(homeT("fr")("home.yours.later")).toBe("Plus tard");
    expect(homeT("en")("home.yours.frees", { n: 3 })).toBe("frees 3");
    expect(homeT("fr")("home.yours.frees", { n: 3 })).toBe("débloque 3");
  });

  it("the key list is pinned", () => {
    expect(Object.keys(homeCopy.en)).toEqual([
      "home.yours.title",
      "home.yours.routine",
      "home.yours.routine.preview",
      "home.yours.routine.preview.a11y",
      "home.yours.all",
      "home.yours.later",
      "home.yours.frees",
      "home.moving.title",
      "home.moving.all",
      "home.moving.all.a11y",
      "home.moving.what",
      "home.needsYou.what",
      "home.health.what",
      "home.projects.what",
      "home.projects.title",
      "home.projects.empty.title",
      "home.projects.empty.body",
      "home.spaces",
      "home.spaces.a11y",
      "home.todo",
      "home.todo.due",
      "home.todo.a11y",
      "home.undo",
      "home.undo.a11y",
      "home.activity",
      "home.activity.a11y",
    ]);
  });
});
