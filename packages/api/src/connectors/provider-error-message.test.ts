import { describe, it, expect } from "vitest";
import { extractProviderErrorMessage } from "./external-dispatch.js";

/**
 * The provider's own error text is what a failed call's caller is shown
 * (`/connectors/tool-execute` → `error`, read by an in-skill `callProvider`).
 *
 * Measured 2026-10-27 on the founder's pod: fal.ai answered `fal_generate_image`
 * with 422 and every caller saw only "provider call failed (status 422)" —
 * no way to tell a missing `image_urls` from a content-checker refusal, because
 * fal (FastAPI / pydantic) puts the reason in `detail`, a shape this reader did
 * not know. The bodies below are the documented pydantic shapes fal returns.
 */
describe("extractProviderErrorMessage — the provider's reason reaches the caller", () => {
  it("reads a pydantic `detail` list: location, message and type", () => {
    const body = {
      detail: [
        {
          loc: ["body", "image_urls"],
          msg: "Field required",
          type: "missing",
          input: { prompt: "put the logo on a mug" },
        },
      ],
    };
    expect(extractProviderErrorMessage(422, body)).toBe(
      "body.image_urls: Field required (missing)"
    );
  });

  it("names a content-checker refusal as such, so it is not mistaken for a bad parameter", () => {
    const body = {
      detail: [
        {
          loc: ["body", "prompt"],
          msg: "The content could not be processed because it contained material flagged by a content checker.",
          type: "content_policy_violation",
        },
      ],
    };
    expect(extractProviderErrorMessage(422, body)).toMatch(
      /^body\.prompt: .*content checker\. \(content_policy_violation\)$/
    );
  });

  it("never echoes the submitted `input` of a pydantic item", () => {
    const body = {
      detail: [
        {
          loc: ["body", "seed"],
          msg: "Input should be a valid integer",
          type: "int_parsing",
          input: "SECRET-PROMPT-TEXT",
        },
      ],
    };
    expect(extractProviderErrorMessage(422, body)).not.toContain(
      "SECRET-PROMPT-TEXT"
    );
  });

  it("reads a string `detail` and caps a long list at three items", () => {
    expect(
      extractProviderErrorMessage(404, { detail: "Application not found" })
    ).toBe("Application not found");
    const many = {
      detail: [1, 2, 3, 4, 5].map((i) => ({
        loc: ["body", `f${i}`],
        msg: "bad",
      })),
    };
    expect(extractProviderErrorMessage(422, many)).toBe(
      "body.f1: bad; body.f2: bad; body.f3: bad (+2 more)"
    );
  });

  it("redacts a credential the provider quotes back, and bounds the text", () => {
    const msg = extractProviderErrorMessage(401, {
      detail:
        "Invalid header Authorization: Key 4f1c2a9e-1111-2222-3333-444455556666:abcdef0123456789 " +
        "x".repeat(1000),
    });
    expect(msg).not.toContain("4f1c2a9e-1111-2222-3333-444455556666");
    // fal keys are `<id>:<secret>`: the half after the colon is the secret.
    expect(msg).not.toContain("abcdef0123456789");
    expect(msg.length).toBeLessThanOrEqual(400);
  });

  it("keeps the earlier shapes and the status fallback", () => {
    expect(
      extractProviderErrorMessage(403, {
        error: { message: "API not enabled" },
      })
    ).toBe("API not enabled");
    expect(
      extractProviderErrorMessage(401, { error: "Invalid API token" })
    ).toBe("Invalid API token");
    expect(extractProviderErrorMessage(422, { detail: [] })).toBe(
      "provider call failed (status 422)"
    );
    expect(extractProviderErrorMessage(500, "<html>")).toBe(
      "provider call failed (status 500)"
    );
  });
});
