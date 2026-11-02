import { describe, expect, it } from "vitest";
import {
  MODEL_ID_MAX_LENGTH,
  MODEL_PROVIDERS,
  parseModelProvider,
  parseReportedModel,
  resolveModelProvider,
} from "./model-providers.js";

describe("the model provider vocabulary", () => {
  it("slugs are unique, and `other` is on it", () => {
    const slugs = MODEL_PROVIDERS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(resolveModelProvider("other")?.label).toBe("Other provider");
  });

  it("a listed provider is kept, case and spaces folded", () => {
    expect(parseModelProvider("anthropic")).toBe("anthropic");
    expect(parseModelProvider("  ZAI ")).toBe("zai");
    expect(parseModelProvider("Bedrock")).toBe("bedrock");
  });

  it("an unlisted word, or a URL, reads `other`: the raw value is never kept", () => {
    expect(parseModelProvider("groq")).toBe("other");
    expect(
      parseModelProvider("https://api.z.ai/api/anthropic?key=s3cr3t")
    ).toBe("other");
  });

  it("no provider named reads unknown, never `anthropic`", () => {
    expect(parseModelProvider(undefined)).toBeUndefined();
    expect(parseModelProvider(null)).toBeUndefined();
    expect(parseModelProvider("   ")).toBeUndefined();
  });
});

describe("a reported model id", () => {
  it("keeps the ids harnesses send", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-4-6[1m]",
      "anthropic/claude-sonnet-4",
      "us.anthropic.claude-sonnet-4-5-v1:0",
      "glm-4.6",
    ]) {
      expect(parseReportedModel(id)).toBe(id);
    }
    expect(parseReportedModel("  glm-4.6 ")).toBe("glm-4.6");
  });

  it("refuses an oversized id whole, never clipped", () => {
    const max = "m".repeat(MODEL_ID_MAX_LENGTH);
    expect(parseReportedModel(max)).toBe(max);
    expect(parseReportedModel(`${max}x`)).toBeUndefined();
  });

  it("refuses junk and URLs", () => {
    expect(parseReportedModel("https://api.z.ai/v1")).toBeUndefined();
    expect(parseReportedModel("claude opus")).toBeUndefined();
    expect(parseReportedModel("model\nX-Injected: 1")).toBeUndefined();
    expect(parseReportedModel("glm?key=abc")).toBeUndefined();
    expect(parseReportedModel("")).toBeUndefined();
    expect(parseReportedModel(undefined)).toBeUndefined();
  });
});
