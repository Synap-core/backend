import { describe, expect, it } from "vitest";
import {
  isAiProviderChoiceRefusal,
  resolveAiFailureState,
  resolveAiProviderChoiceGate,
} from "./index.js";

const read = (
  over: Partial<Parameters<typeof resolveAiProviderChoiceGate>[0] & object>
) => ({
  choice: null,
  ownProviderReady: false,
  mayChoose: true,
  ...over,
});

describe("resolveAiProviderChoiceGate", () => {
  it("nobody chose: an admin chooses, a member asks", () => {
    expect(resolveAiProviderChoiceGate(read({}))).toBe("choose");
    expect(resolveAiProviderChoiceGate(read({ mayChoose: false }))).toBe(
      "ask_admin"
    );
  });

  it("DeepSeek chosen, or a provider of the pod's own ready: AI runs", () => {
    expect(resolveAiProviderChoiceGate(read({ choice: "deepseek" }))).toBe(
      "ok"
    );
    expect(resolveAiProviderChoiceGate(read({ ownProviderReady: true }))).toBe(
      "ok"
    );
    expect(
      resolveAiProviderChoiceGate(
        read({
          choice: "own_provider",
          ownProviderReady: true,
          mayChoose: false,
        })
      )
    ).toBe("ok");
  });

  it("own provider chosen, none ready: add one (admin) or ask", () => {
    expect(resolveAiProviderChoiceGate(read({ choice: "own_provider" }))).toBe(
      "add_provider"
    );
    expect(
      resolveAiProviderChoiceGate(
        read({ choice: "own_provider", mayChoose: false })
      )
    ).toBe("ask_admin");
  });

  it("a read that failed or has not landed is unknown, never ok", () => {
    expect(resolveAiProviderChoiceGate(null)).toBe("unknown");
    expect(resolveAiProviderChoiceGate(undefined)).toBe("unknown");
  });
});

describe("the refusal on the wire", () => {
  it("ai_consent_required opens the choice and is no availability state", () => {
    expect(isAiProviderChoiceRefusal("ai_consent_required")).toBe(true);
    expect(isAiProviderChoiceRefusal("ai_consent_unverified")).toBe(false);
    expect(isAiProviderChoiceRefusal("credits_empty")).toBe(false);
    expect(resolveAiFailureState("ai_consent_required")).toBeNull();
    expect(resolveAiFailureState("ai_consent_unverified")).toBeNull();
  });
});
