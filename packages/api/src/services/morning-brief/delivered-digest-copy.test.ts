/**
 * The delivered digest counts through plural messages (review 459d5e5b):
 * English byte-identical to the hand-written text it replaced, French by its
 * own plural rules (0 and 1 are singular: "0 commit intégré" never reads
 * "0 commits"), the session noun from the vocabulary door in both.
 *
 * Negative control: the hand-written `n === 1 ? one : many` ignores the
 * locale, so every French expectation below turns red.
 */
import { describe, expect, it } from "vitest";
import {
  nounInSentence,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";
import { composeDeliveredDigest } from "./delivered-digest.js";
import { deliveredDigestT } from "./delivered-digest-copy.js";

const NONE = {
  prsMerged: 0,
  commitsLanded: 0,
  outcomesMet: 0,
  sessionsClosed: 0,
  closedTitles: [],
  floor: false,
};

describe("the delivered digest's counts", () => {
  it("English reads exactly as before: one and many, the floor after the noun", () => {
    const t = deliveredDigestT();
    expect(t("digest.prsMerged", { n: 1, plus: "" })).toBe(
      "1 pull request merged"
    );
    expect(t("digest.prsMerged", { n: 2, plus: "+" })).toBe(
      "2 pull requests+ merged"
    );
    expect(t("digest.commitsLanded", { n: 1, plus: "" })).toBe(
      "1 commit landed"
    );
    expect(t("digest.outcomesMet", { n: 3, plus: "" })).toBe(
      "3 outcomes delivered"
    );
    expect(
      composeDeliveredDigest({ ...NONE, sessionsClosed: 2, floor: true })?.body
    ).toBe(`2 ${nounInSentence(resolveObjectNounPlural("session"))}+ closed.`);
  });

  it("French follows its own plural rules and the vocabulary's noun", () => {
    const body = composeDeliveredDigest(
      { ...NONE, prsMerged: 1, commitsLanded: 3, sessionsClosed: 1 },
      "fr"
    )?.body;
    expect(body).toBe(
      `1 pull request fusionnée, 3 commits intégrés, 1 ${nounInSentence(
        resolveObjectNoun("session", "fr")
      )} fermé.`
    );
    const t = deliveredDigestT("fr");
    expect(t("digest.commitsLanded", { n: 0, plus: "" })).toBe(
      "0 commit intégré"
    );
  });
});
