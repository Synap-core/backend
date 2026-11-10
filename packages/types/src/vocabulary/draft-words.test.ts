import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PROPOSAL_STATUSES } from "../proposals/attention.js";
import {
  DRAFT_DECISION_API,
  DRAFT_DECISIONS,
  DRAFT_DECISION_WORDS,
  draftDecisionWord,
  draftStateOf,
  resolveActionLabel,
  resolveActionProgressive,
} from "./index.js";

describe("draft words: a draft decided in place (one definition)", () => {
  it("every stored proposal status is a draft state, and none of them is `unknown`", () => {
    for (const status of PROPOSAL_STATUSES) {
      expect(draftStateOf(status), status).not.toBe("unknown");
    }
    expect(draftStateOf("pending")).toBe("proposed");
    expect(draftStateOf("approved")).toBe("approved");
    expect(draftStateOf("auto_approved")).toBe("approved");
    expect(draftStateOf("rejected")).toBe("discarded");
    expect(draftStateOf("approval_failed")).toBe("failed");
    expect(draftStateOf("withdrawn")).toBe("gone");
    expect(draftStateOf("expired")).toBe("gone");
    expect(draftStateOf("reverted")).toBe("reverted");
  });

  it("a status it does not know is `unknown`, never a guessed state", () => {
    expect(draftStateOf("archived")).toBe("unknown");
    expect(draftStateOf("")).toBe("unknown");
    expect(draftStateOf(null)).toBe("unknown");
    expect(draftStateOf(undefined)).toBe("unknown");
    expect(draftStateOf("toString")).toBe("unknown");
    expect(draftStateOf(" Rejected ")).toBe("discarded");
  });

  it("a draft is discarded through the API's reject, approved through its approve", () => {
    expect(DRAFT_DECISION_API).toEqual({
      approve: "approve",
      discard: "reject",
    });
    expect([...DRAFT_DECISIONS]).toEqual(["approve", "discard"]);
  });

  it("the vocabulary's approve and discard ARE the draft words, in every mood and language", () => {
    for (const decision of DRAFT_DECISIONS) {
      for (const locale of ["en", "fr"] as const) {
        const words = DRAFT_DECISION_WORDS[locale][decision];
        expect(resolveActionLabel(decision, "imperative", locale)).toBe(
          words.imperative
        );
        expect(resolveActionLabel(decision, "past", locale)).toBe(words.past);
        expect(resolveActionProgressive(decision, locale)).toBe(
          words.progressive
        );
        expect(draftDecisionWord(decision, "past", locale)).toBe(words.past);
      }
    }
    expect(draftDecisionWord("discard", "imperative")).toBe("Discard");
    expect(draftDecisionWord("discard", "past", "de")).toBe("Discarded");
  });

  it("the leaf imports nothing (the SDK vendors it byte for byte)", () => {
    const source = readFileSync(
      new URL("./draft-words.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("export function draftStateOf");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
