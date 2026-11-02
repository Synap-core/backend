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
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveRunnerStateLabel,
  resolveRunnerStateLabelFor,
  resolveStatusLabel,
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

  it("the runner words take a locale: French has its own for EVERY state, English stays the table's", () => {
    for (const state of Object.keys(RUNNER_STATE_LABELS)) {
      expect(resolveRunnerStateLabel(state, "en")).toBe(
        RUNNER_STATE_LABELS[state as keyof typeof RUNNER_STATE_LABELS]
      );
      const fr = resolveRunnerStateLabel(state, "fr");
      expect(fr).not.toBe("");
      // Rules out a French reader that falls back to English.
      expect(fr).not.toBe(resolveRunnerStateLabel(state, "en"));
    }
    expect(resolveRunnerStateLabel("needs_permission", "fr")).toBe(
      "Attend votre autorisation"
    );
    // An unknown word humanizes, in any locale.
    expect(resolveRunnerStateLabel("compacting", "fr")).toBe("Compacting");
  });

  it("a session's test runs and its muted mark have their own rows (French included, never 'Test run')", () => {
    expect(resolveObjectNoun("test_run")).toBe("Test run");
    expect(resolveObjectNounPlural("test_run")).toBe("Test runs");
    expect(resolveObjectNoun("test_run", "fr")).toBe("Série de tests");
    expect(resolveObjectNounPlural("test_run", "fr")).toBe("Séries de tests");
    expect(resolveStatusLabel("muted")).toBe("Muted");
    expect(resolveStatusLabel("muted", "fr")).toBe("En sourdine");
  });

  it("a runner's wait says 'your' only to the person it waits on (M2): another reader reads that person's name", () => {
    const you = { isViewer: true, name: "Ana" };
    const ana = { isViewer: false, name: "Ana" };
    const someone = { isViewer: false, name: " " };
    for (const state of Object.keys(RUNNER_STATE_LABELS)) {
      // The viewer's own wait, or no holder: exactly the plain words.
      for (const locale of ["en", "fr"] as const) {
        expect(resolveRunnerStateLabelFor(state, you, locale)).toBe(
          resolveRunnerStateLabel(state, locale)
        );
        expect(resolveRunnerStateLabelFor(state, null, locale)).toBe(
          resolveRunnerStateLabel(state, locale)
        );
      }
    }
    expect(resolveRunnerStateLabelFor("needs_permission", ana, "en")).toBe(
      "Waiting for Ana's permission"
    );
    expect(resolveRunnerStateLabelFor("needs_answer", ana, "en")).toBe(
      "Waiting for Ana's answer"
    );
    expect(resolveRunnerStateLabelFor("needs_permission", someone, "en")).toBe(
      "Waiting for permission"
    );
    expect(resolveRunnerStateLabelFor("needs_answer", someone, "en")).toBe(
      "Waiting for an answer"
    );
    expect(resolveRunnerStateLabelFor("needs_permission", ana, "fr")).toBe(
      "Attend l’autorisation de Ana"
    );
    expect(resolveRunnerStateLabelFor("needs_answer", someone, "fr")).toBe(
      "Attend une réponse"
    );
    // Never "your" to anyone but the person waited on, in either locale.
    for (const state of ["needs_permission", "needs_answer"]) {
      for (const holder of [ana, someone]) {
        expect(resolveRunnerStateLabelFor(state, holder, "en")).not.toMatch(
          /\byour\b/i
        );
        expect(resolveRunnerStateLabelFor(state, holder, "fr")).not.toMatch(
          /\bvotre\b/i
        );
      }
    }
    // A state that waits on nobody reads the same to every reader.
    expect(resolveRunnerStateLabelFor("busy", ana, "en")).toBe("Working");
  });
});
