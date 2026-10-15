import { describe, expect, it } from "vitest";
import {
  resolveCaptureChipStateLabel,
  resolveTemplateStepLabel,
  TEMPLATE_STEP_LABELS,
  TEMPLATE_STEPS,
} from "./index.js";

describe("template step words (one mark, every surface)", () => {
  it("names every step, with the words the surfaces draw", () => {
    expect(TEMPLATE_STEPS.length).toBe(4); // non-vacuity
    for (const step of TEMPLATE_STEPS) {
      expect(TEMPLATE_STEP_LABELS[step]).toMatch(/\S/);
    }
    expect(resolveTemplateStepLabel("update")).toBe("Update available");
    expect(resolveTemplateStepLabel("unfinished")).toBe("Not finished");
    expect(resolveTemplateStepLabel("awaiting-approval")).toBe("Waiting for approval");
    expect(resolveTemplateStepLabel("current")).toBe("Up to date");
  });

  it("waiting for approval reads the same as the capture chip's", () => {
    expect(resolveTemplateStepLabel("awaiting-approval")).toBe(
      resolveCaptureChipStateLabel("awaiting_approval")
    );
  });

  it("an unknown step humanizes, never leaks the token", () => {
    expect(resolveTemplateStepLabel("needs-consent")).toBe("Needs consent");
  });
});
