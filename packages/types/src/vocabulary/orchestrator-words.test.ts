/**
 * The orchestrator (founder decision D5, plan b38bc224; lane doc 5fccda9b):
 * its noun, its proposal's verb in both moods, and the words of its edge
 * `orchestrated_by` read from either end, in English and French.
 */
import { describe, it, expect } from "vitest";
import {
  resolveActionLabel,
  resolveLineageEdgeLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "./index.js";

describe("orchestrator words", () => {
  it("names the orchestrator (EN + FR), never a humanized token", () => {
    expect(resolveObjectNoun("orchestrator")).toBe("Orchestrator");
    expect(resolveObjectNounPlural("orchestrator")).toBe("Orchestrators");
    expect(resolveObjectNoun("orchestrator", "fr")).toBe("Orchestrateur");
    expect(resolveObjectNounPlural("orchestrator", "fr")).toBe(
      "Orchestrateurs"
    );
  });

  it("orchestrate: the proposal's verb has both moods", () => {
    expect(resolveActionLabel("orchestrate", "imperative")).toBe("Orchestrate");
    expect(resolveActionLabel("orchestrate", "past")).toBe("Orchestrated");
    expect(resolveActionLabel("orchestrate", "imperative", "fr")).toBe(
      "Orchestrer"
    );
  });

  it("orchestrated_by reads from each end", () => {
    expect(resolveLineageEdgeLabel("orchestrated_by", "outgoing")).toBe(
      "Orchestrated by"
    );
    expect(resolveLineageEdgeLabel("orchestrated_by", "incoming")).toBe(
      "Orchestrates"
    );
  });
});
