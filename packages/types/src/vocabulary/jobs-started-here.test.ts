/**
 * The Work view's fold of child jobs (plan 5207fbb6, point of view 3e47abde:
 * a child job is a Job drawn as a fork, never a "branch" on screen), counted
 * with the Job word through the catalogs, in English and French.
 */
import { describe, expect, it } from "vitest";

import { vocabularySentencesEn } from "./catalog.en.js";
import { vocabularyFr } from "./catalog.fr.js";
import { resolveJobsStartedHereLabel, resolveObjectNoun } from "./index.js";

describe("resolveJobsStartedHereLabel", () => {
  it("counts the folded child jobs with the Job word", () => {
    expect(resolveJobsStartedHereLabel(1)).toBe("1 job started from here");
    expect(resolveJobsStartedHereLabel(3)).toBe("3 jobs started from here");
  });

  it("says it in French, singular at 0 and 1", () => {
    expect(resolveJobsStartedHereLabel(1, "fr")).toBe("1 travail lancé d’ici");
    expect(resolveJobsStartedHereLabel(0, "fr")).toBe("0 travail lancé d’ici");
    expect(resolveJobsStartedHereLabel(4, "fr")).toBe("4 travaux lancés d’ici");
  });

  it("is a catalog message in both locales, not a spliced sentence", () => {
    expect(vocabularySentencesEn["vocabulary.job.startedHere"]).toContain(
      "plural"
    );
    expect(vocabularyFr["vocabulary.job.startedHere"]).toContain("plural");
  });

  it("adds no Branch noun: the word stays unknown to the door", () => {
    expect(resolveObjectNoun("branch")).toBe("Branch"); // humanized fallback
    expect(Object.keys(vocabularyFr)).not.toContain("kind.branch.one");
  });
});
