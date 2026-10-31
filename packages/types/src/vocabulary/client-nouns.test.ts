/**
 * The client's nouns (founder decision G1, 30 Oct 2026; audit X-08): what
 * waits for a person's yes is a Request (Demande), a person's unit of work is
 * a Job (Travail), and their pod is "Your company" (Votre entreprise). The
 * kind tokens stay (`proposal`, `session`, `pod`); only the words change, at
 * the one door, so every surface that reads it follows.
 */
import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { setAmbientCatalogLocale } from "../i18n/ambient.js";
import { buildFallbackTitle } from "../proposals/proposal-utils.js";
import {
  buildObjectActionTitle,
  normalizeObjectKind,
  resolveNoun,
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveProposalKindLabel,
} from "./index.js";

const NBSP = " ";

const CLIENT_NOUNS = [
  // [kind token, en one, en other, fr one, fr other]
  ["proposal", "Request", "Requests", "Demande", "Demandes"],
  ["session", "Job", "Jobs", "Travail", "Travaux"],
  ["focus_session", "Job", "Jobs", "Travail", "Travaux"],
  [
    "pod",
    "Your company",
    "Your companies",
    "Votre entreprise",
    "Vos entreprises",
  ],
  [
    "data-pod",
    "Your company",
    "Your companies",
    "Votre entreprise",
    "Vos entreprises",
  ],
] as const;

afterEach(() => setAmbientCatalogLocale("en"));

describe("client nouns (G1): the door names them in English and French", () => {
  it.each(CLIENT_NOUNS)("%s", (kind, enOne, enOther, frOne, frOther) => {
    expect(resolveObjectNoun(kind, "en")).toBe(enOne);
    expect(resolveObjectNounPlural(kind, "en")).toBe(enOther);
    expect(resolveObjectNoun(kind, "fr")).toBe(frOne);
    expect(resolveObjectNounPlural(kind, "fr")).toBe(frOther);
  });

  it("the kind tokens do not change", () => {
    expect(normalizeObjectKind("proposals")).toBe("proposal");
    expect(normalizeObjectKind("focus_session")).toBe("session");
    expect(normalizeObjectKind("data-pod")).toBe("pod");
  });

  it("French agrees with each noun's gender", () => {
    expect(resolveNoun("proposal", "fr").gender).toBe("f");
    expect(resolveNoun("session", "fr").gender).toBe("m");
    expect(resolveNoun("pod", "fr").gender).toBe("f");
  });

  it("a client never reads the old words, in either language", () => {
    const old = /\b(proposals?|propositions?|sessions?|data pods?)\b/i;
    for (const [kind] of CLIENT_NOUNS) {
      for (const locale of ["en", "fr"] as const) {
        expect(resolveObjectNoun(kind, locale)).not.toMatch(old);
        expect(resolveObjectNounPlural(kind, locale)).not.toMatch(old);
      }
    }
  });

  it("the ambient catalog locale reaches them with no argument", () => {
    setAmbientCatalogLocale("fr");
    expect(resolveObjectNoun("proposal")).toBe("Demande");
    expect(resolveObjectNoun("session")).toBe("Travail");
  });
});

describe("client nouns (G1): titles with no verb name the request", () => {
  it("English sets the noun apart: Request is also a verb", () => {
    expect(buildObjectActionTitle({ objectKind: "task", locale: "en" })).toBe(
      "Request: Task"
    );
    expect(buildObjectActionTitle({ locale: "en" })).toBe("Request");
    expect(buildFallbackTitle({})).toBe("Request");
    expect(buildFallbackTitle({ profileSlug: "task" })).toBe("Request: Task");
  });

  it("French", () => {
    expect(buildObjectActionTitle({ objectKind: "task", locale: "fr" })).toBe(
      `Demande${NBSP}: tâche`
    );
  });

  it("a proposal that starts work is a Job on its chip", () => {
    expect(resolveProposalKindLabel("session")).toBe("Job");
  });
});
