/**
 * A step's gate chip and a process's "What agents load" heading read their
 * words from the vocabulary door, so no surface humanizes a gate token or
 * calls an instruction skill a "Tool" (Process wave plan 0adf8352, W2).
 * The gate set is DERIVED from the leaf (`PROCESS_GATE_KINDS`).
 */
import { describe, expect, it } from "vitest";
import {
  PROCESS_GATE_KINDS,
  PROCESS_STEP_RUNNER_KINDS,
} from "../processes/steps.js";
import {
  GATE_KIND_LABELS,
  GATE_KIND_LONG_LABELS,
  STEP_RUNNER_KIND_LABELS,
  resolveGateKindLabel,
  resolveStepRunnerLabel,
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
      const long = resolveGateKindLabel(kind, { form: "long" });
      expect(long, kind).toBe(GATE_KIND_LONG_LABELS[kind]);
      expect(long, kind).not.toBe(GATE_KIND_LABELS[kind]);
      expect(resolveGateKindLabel(kind, { locale: "fr", form: "long" })).toBe(
        vocabularyFr[`gateKind.${kind}.long`]
      );
    }
    // Only `human` is an entry gate; no other gate's words say it starts.
    for (const kind of PROCESS_GATE_KINDS.filter((k) => k !== "human")) {
      expect(GATE_KIND_LONG_LABELS[kind]).not.toMatch(/start|entry/i);
    }
  });

  it("reads the token or a stored { kind } gate; no gate is empty; unknown humanizes", () => {
    expect(resolveGateKindLabel("human")).toBe("You approve");
    expect(resolveGateKindLabel({ kind: "check" })).toBe("Checked");
    expect(resolveGateKindLabel({ kind: "awaits" })).toBe("Waits for approval");
    expect(resolveGateKindLabel("human", { form: "long" })).toBe(
      "You approve before it starts"
    );
    expect(resolveGateKindLabel({ kind: "check" }, { form: "long" })).toBe(
      "Checked before it moves on"
    );
    expect(resolveGateKindLabel("awaits", { form: "long" })).toBe(
      "Waits for an approval before it moves on"
    );
    expect(resolveGateKindLabel(null)).toBe("");
    expect(resolveGateKindLabel({})).toBe("");
    expect(resolveGateKindLabel("legal_review")).toBe("Legal review");
  });
});

describe("step runner words", () => {
  it("every runner kind has its own words, in English and French", () => {
    const labels = PROCESS_STEP_RUNNER_KINDS.map((k) =>
      resolveStepRunnerLabel(k)
    );
    expect(labels).toEqual(
      PROCESS_STEP_RUNNER_KINDS.map((k) => STEP_RUNNER_KIND_LABELS[k])
    );
    expect(new Set(labels).size).toBe(PROCESS_STEP_RUNNER_KINDS.length);
    for (const kind of PROCESS_STEP_RUNNER_KINDS) {
      const fr = resolveStepRunnerLabel(kind, { locale: "fr" });
      expect(fr, kind).toBe(vocabularyFr[`stepRunner.${kind}`]);
      expect(fr, kind).not.toBe(STEP_RUNNER_KIND_LABELS[kind]);
    }
  });

  it("names each kind; no kind is empty, an unknown kind humanizes", () => {
    expect(resolveStepRunnerLabel("person")).toBe("You");
    expect(resolveStepRunnerLabel("ai")).toBe("An agent");
    expect(resolveStepRunnerLabel("automatic")).toBe("Runs by itself");
    expect(resolveStepRunnerLabel(null)).toBe("");
    // The runner mark never repeats the gate badge beside it.
    expect(resolveStepRunnerLabel("person")).not.toBe(
      resolveGateKindLabel("human")
    );
    expect(resolveStepRunnerLabel("machine_step")).toBe("Machine step");
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
