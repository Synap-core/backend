/**
 * The desktop door to a Claude Code session's terminal (sessions cockpit C7)
 * and the runner's terminal waits read from the one vocabulary: an action
 * key with BOTH moods (the button, the receipt), its own dotted key so bare
 * `open` keeps its readers, and the `needs_answer` label beside the
 * permission one (decision D-R1, extended).
 */
import { describe, it, expect } from "vitest";
import {
  resolveActionLabel,
  resolveRunnerStateLabel,
  RUNNER_STATE_LABELS,
} from "./index.js";

describe("terminal words", () => {
  it("terminal.open: Open terminal on the button, Opened terminal on the receipt", () => {
    expect(resolveActionLabel("terminal.open", "imperative")).toBe(
      "Open terminal"
    );
    expect(resolveActionLabel("terminal.open", "past")).toBe("Opened terminal");
    // Bare `open` is untouched.
    expect(resolveActionLabel("open", "imperative")).toBe("Open");
    // French has its own words, never the English fallback.
    expect(resolveActionLabel("terminal.open", "imperative", "fr")).toBe(
      "Ouvrir le terminal"
    );
  });

  it("the runner's two terminal waits each have their own words", () => {
    expect(resolveRunnerStateLabel("needs_permission")).toBe(
      "Waiting for your permission"
    );
    expect(resolveRunnerStateLabel("needs_answer")).toBe(
      "Waiting for your answer"
    );
    expect(Object.keys(RUNNER_STATE_LABELS)).toEqual([
      "busy",
      "idle",
      "needs_permission",
      "needs_answer",
      "ended",
    ]);
  });
});
