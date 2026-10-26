/**
 * Coordination-post intent words (one agent's typed message to another
 * session). Each row is pinned, and an unknown intent never leaks its token.
 */
import { describe, expect, it } from "vitest";
import {
  SESSION_POST_INTENT_LABELS,
  resolveSessionPostIntentLabel,
} from "./index.js";
import { SESSION_POST_INTENTS } from "../agents/index.js";

describe("session post intent words", () => {
  it.each([
    ["blocked_on_you", "Blocked on you"],
    ["handoff", "Handoff"],
    ["done", "Done"],
    ["fyi", "FYI"],
  ])("%s → %s", (intent, words) => {
    expect(resolveSessionPostIntentLabel(intent)).toBe(words);
  });

  it("covers exactly the intents the pod stamps", () => {
    expect(Object.keys(SESSION_POST_INTENT_LABELS).sort()).toEqual(
      [...SESSION_POST_INTENTS].sort()
    );
  });

  it("an unknown intent humanizes, an absent one is empty", () => {
    expect(resolveSessionPostIntentLabel("needs_review")).toBe("Needs review");
    expect(resolveSessionPostIntentLabel(null)).toBe("");
  });
});
