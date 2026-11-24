import { describe, expect, it } from "vitest";

import {
  checkVerbParameters,
  describeParameterRepair,
} from "./validate-verb-parameters.js";
import { readParameterRules } from "./parameter-rules.js";

/**
 * A verb's conditional input rules (`metadata.parameterRules`) refuse a call
 * BEFORE a proposal is filed.
 *
 * The filed case (agent report 8a0b5606): `fal_generate_image` with model
 * `fal-ai/flux-pro/kontext/max`, aspectRatio `4:5` and one pod image was
 * proposed, approved, then refused by fal. The rules below are the shape the
 * catalog's fal verb declares; the model names live there, not in the pod.
 */

const KONTEXT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "3:2",
  "1:1",
  "2:3",
  "3:4",
  "9:16",
  "9:21",
];

const fal = {
  kind: "code",
  name: "fal_generate_image",
  parameters: {
    prompt: "string",
    model: "string?",
    imageUrls: "array?",
    images: "file[]:url?",
    aspectRatio: "string?",
  },
  metadata: {
    parameterRules: [
      {
        when: { model: ["fal-ai/flux-pro/kontext/max"] },
        allow: { aspectRatio: KONTEXT_RATIOS },
        count: { fields: ["images", "imageUrls"], min: 1, max: 1 },
        why: "For several images use fal-ai/flux-pro/kontext/max/multi.",
      },
    ],
  },
};

describe("a verb's parameterRules refuse the call before anyone approves it", () => {
  it("THE FILED CASE: kontext/max with aspectRatio 4:5 is invalid, with the accepted ratios", () => {
    const check = checkVerbParameters(fal, {
      prompt: "blur the note",
      model: "fal-ai/flux-pro/kontext/max",
      aspectRatio: "4:5",
      images: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(check.status).toBe("invalid");
    if (check.status !== "invalid") return;
    expect(check.repair.hints).toHaveLength(1);
    expect(check.repair.hints![0]).toContain('aspectRatio "4:5"');
    expect(check.repair.hints![0]).toContain("21:9");
    const message = describeParameterRepair("fal_generate_image", check.repair);
    expect(message).toContain("Nothing was proposed or run");
    expect(message).toContain("kontext/max/multi");
  });

  it("a single-image model given two images is invalid; given none, too", () => {
    const two = checkVerbParameters(fal, {
      prompt: "p",
      model: "fal-ai/flux-pro/kontext/max",
      imageUrls: ["https://a.example/1.png"],
      images: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(two.status).toBe("invalid");
    if (two.status === "invalid") {
      expect(two.repair.hints![0]).toContain("at most 1 item together (got 2)");
    }
    const none = checkVerbParameters(fal, {
      prompt: "p",
      model: "fal-ai/flux-pro/kontext/max",
    });
    expect(none.status).toBe("invalid");
  });

  it("a call that keeps the rule, or a model no rule names, is untouched", () => {
    expect(
      checkVerbParameters(fal, {
        prompt: "p",
        model: "fal-ai/flux-pro/kontext/max",
        aspectRatio: "3:4",
        images: ["11111111-1111-4111-8111-111111111111"],
      })
    ).toEqual({ status: "ok", unknown: [] });
    expect(
      checkVerbParameters(fal, {
        prompt: "p",
        model: "fal-ai/flux/schnell",
        aspectRatio: "4:5",
      })
    ).toEqual({ status: "ok", unknown: [] });
    // No model at all: the rule's `when` names one, so it does not apply.
    expect(checkVerbParameters(fal, { prompt: "p" }).status).toBe("ok");
  });

  it("a rule's sentence joins a type-map repair instead of replacing it", () => {
    const check = checkVerbParameters(fal, {
      model: "fal-ai/flux-pro/kontext/max",
      aspectRatio: "4:5",
      images: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(check.status).toBe("invalid");
    if (check.status !== "invalid") return;
    expect(check.repair.missing).toEqual(["prompt"]);
    expect(check.repair.hints).toHaveLength(1);
  });

  it("refuses even when the verb declares no type map", () => {
    const check = checkVerbParameters(
      { ...fal, parameters: undefined },
      { model: "fal-ai/flux-pro/kontext/max", aspectRatio: "4:5" }
    );
    expect(check.status).toBe("invalid");
  });

  it("a rule this module cannot read is skipped, never a refusal", () => {
    const unreadable = [
      { when: "fal-ai/flux-pro/kontext/max", allow: { aspectRatio: ["1:1"] } },
      { when: { model: ["m"] } },
      { when: { model: ["m"] }, allow: { aspectRatio: "1:1" } },
      { when: { model: ["m"] }, count: { fields: ["images"] } },
      { when: { model: ["m"] }, count: { fields: ["images"], max: -1 } },
    ];
    expect(readParameterRules({ parameterRules: unreadable })).toEqual([]);
    expect(
      checkVerbParameters(
        { ...fal, metadata: { parameterRules: unreadable } },
        { prompt: "p", model: "m", aspectRatio: "4:5" }
      ).status
    ).toBe("ok");
  });
});
