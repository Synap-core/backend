/**
 * A step's gate chip and a process's "What agents load" heading read their
 * words from the vocabulary door, so no surface humanizes a gate token or
 * calls an instruction skill a "Tool" (Process wave plan 0adf8352, W2).
 * The gate set is DERIVED from the leaf (`PROCESS_GATE_KINDS`).
 */
import { describe, expect, it } from "vitest";
import { PROCESS_GATE_KINDS } from "../processes/steps.js";
import {
  GATE_KIND_LABELS,
  resolveGateKindLabel,
  resolveObjectNoun,
  resolveToolKindLabel,
  resolveToolKindPlural,
} from "./index.js";
import { vocabularyFr } from "./catalog.fr.js";

describe("gate kind words", () => {
  it("every gate kind has its own words, in English and French", () => {
    const labels = PROCESS_GATE_KINDS.map((k) => resolveGateKindLabel(k));
    expect(labels).toEqual(PROCESS_GATE_KINDS.map((k) => GATE_KIND_LABELS[k]));
    expect(new Set(labels).size).toBe(PROCESS_GATE_KINDS.length);
    for (const kind of PROCESS_GATE_KINDS) {
      const fr = resolveGateKindLabel(kind, { locale: "fr" });
      expect(fr, kind).toBe(vocabularyFr[`gateKind.${kind}`]);
      expect(fr, kind).not.toBe(GATE_KIND_LABELS[kind]);
    }
  });

  it("reads the token or a stored { kind } gate; no gate is empty; unknown humanizes", () => {
    expect(resolveGateKindLabel("human")).toBe("Your approval");
    expect(resolveGateKindLabel({ kind: "check" })).toBe("Automatic check");
    expect(resolveGateKindLabel({ kind: "awaits" })).toBe("Waits for a signal");
    expect(resolveGateKindLabel(null)).toBe("");
    expect(resolveGateKindLabel({})).toBe("");
    expect(resolveGateKindLabel("legal_review")).toBe("Legal review");
  });
});

describe("the instruction-skill noun", () => {
  it("a process's instruction skills are Skills, never the umbrella Tool", () => {
    expect(resolveToolKindLabel("skill")).toBe("Skill");
    expect(resolveToolKindPlural("skill")).toBe("Skills");
    expect(resolveToolKindPlural("skill")).not.toBe(
      resolveObjectNoun("skill") + "s"
    );
    expect(resolveToolKindPlural("capability")).toBe("Capabilities");
    expect(resolveToolKindPlural("tool")).toBe("Integrations");
    expect(resolveToolKindPlural("mcp_server")).toBe("Mcp server");
    expect(resolveToolKindPlural(null)).toBe("");
  });
});
