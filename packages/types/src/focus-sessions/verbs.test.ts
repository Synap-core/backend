import { describe, expect, it } from "vitest";
import { ACTION_VERBS, resolveActionLabel } from "../vocabulary/index.js";
import { SESSION_KINDS, SESSION_KIND_FILTERS, isSessionKind } from "./kinds.js";
import { SESSION_STATUSES, TERMINAL_SESSION_STATUSES } from "./statuses.js";
import {
  SESSION_VERBS,
  SESSION_VERB_DECLARATION,
  sessionVerbLabel,
  sessionVerbsFor,
} from "./verbs.js";

describe("SESSION_KINDS — the three populations, one list", () => {
  it("is work, run, receipt; the filter adds only `all`", () => {
    expect([...SESSION_KINDS]).toEqual(["work", "run", "receipt"]);
    expect([...SESSION_KIND_FILTERS]).toEqual([...SESSION_KINDS, "all"]);
    expect(isSessionKind("run")).toBe(true);
    expect(isSessionKind("all")).toBe(false);
    expect(isSessionKind(null)).toBe(false);
  });
});

describe("SESSION_VERBS — words through the vocabulary door", () => {
  it("declares every verb, and nothing else", () => {
    expect(Object.keys(SESSION_VERB_DECLARATION).sort()).toEqual(
      [...SESSION_VERBS].sort()
    );
  });

  // Every verb's action token must be a CURATED row with both moods: a
  // token with no row falls through to `humanizeToken`, which has no tense
  // (the past mood would read "Stop", "Wait on" on a receipt).
  it.each(SESSION_VERBS.map((v) => [v]))(
    "%s has a curated vocabulary row in both moods",
    (verb) => {
      const token = SESSION_VERB_DECLARATION[verb].action;
      expect(Object.hasOwn(ACTION_VERBS, token)).toBe(true);
      const imperative = sessionVerbLabel(verb, "imperative");
      const past = sessionVerbLabel(verb, "past");
      expect(imperative).toBe(resolveActionLabel(token, "imperative"));
      expect(past).toBe(ACTION_VERBS[token]!.past);
      expect(past).not.toBe(imperative);
    }
  );

  it("speaks French through the same door", () => {
    expect(sessionVerbLabel("stop", "imperative", "fr")).toBe("Arrêter");
    expect(sessionVerbLabel("pause", "imperative", "fr")).toBe(
      "Mettre en pause"
    );
  });

  it("every declared status is a real one", () => {
    for (const verb of SESSION_VERBS) {
      for (const s of SESSION_VERB_DECLARATION[verb].from) {
        expect(SESSION_STATUSES as readonly string[]).toContain(s);
      }
    }
  });
});

describe("sessionVerbsFor — what a session offers now", () => {
  it("an active session: pause, stop, wait on, release", () => {
    expect(sessionVerbsFor({ status: "active" })).toEqual([
      "pause",
      "stop",
      "wait_on",
      "release",
    ]);
  });

  it("a paused or stale session resumes; it never pauses again", () => {
    for (const status of ["paused", "stale"]) {
      const verbs = sessionVerbsFor({ status });
      expect(verbs).toContain("resume");
      expect(verbs).not.toContain("pause");
      expect(verbs).toContain("stop");
    }
  });

  it("an ended session offers nothing but rerun, and only when the read says so", () => {
    for (const status of TERMINAL_SESSION_STATUSES) {
      expect(sessionVerbsFor({ status })).toEqual([]);
      expect(sessionVerbsFor({ status, rerunAvailable: null })).toEqual([]);
      expect(sessionVerbsFor({ status, rerunAvailable: true })).toEqual([
        "rerun",
      ]);
    }
  });

  it("an unknown or missing status offers nothing", () => {
    expect(sessionVerbsFor({ status: null })).toEqual([]);
    expect(sessionVerbsFor({ status: "archived" })).toEqual([]);
  });
});
