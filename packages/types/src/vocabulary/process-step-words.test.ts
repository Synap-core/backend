/**
 * A process step's runner mark and a process's "What agents load" heading read
 * their words from the vocabulary door, so no surface hand-writes "You" /
 * "An agent" or calls an instruction skill a "Tool" (Process wave plan
 * 0adf8352, W2). A step's GATE words are `trackStepGateLabel`
 * (`@synap-core/types/units`), not this door. The runner set is DERIVED from
 * the leaf (`PROCESS_STEP_RUNNER_KINDS`).
 */
import { describe, expect, it } from "vitest";
import { PROCESS_STEP_RUNNER_KINDS } from "../processes/steps.js";
import { trackStepGateLabel } from "../units/track-step.js";
import {
  STEP_RUNNER_KIND_LABELS,
  resolveObjectNoun,
  resolveStepRunnerLabel,
  resolveToolKindLabel,
  resolveToolKindPlural,
} from "./index.js";
import { vocabularyFr } from "./catalog.fr.js";

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
    // The runner mark never repeats the gate's words beside it.
    expect(resolveStepRunnerLabel("person")).not.toBe(
      trackStepGateLabel("human")
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
