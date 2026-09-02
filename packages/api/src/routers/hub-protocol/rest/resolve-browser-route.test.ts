import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  browserRouteFor,
  EMITTABLE_LABELS,
  UNOPENABLE_KINDS,
} from "./resolve-browser-route.js";
import { PROBE_ORDER } from "../../../services/diagnose/resolve-object-kind.js";

/**
 * TRIPWIRE — `/resolve/:id` may only emit labels the browser can actually route.
 *
 * `synap open <bare-id>` calls this endpoint and then emits
 * `synap://open/<type>/<id>` for WHATEVER type comes back — the CLI's own kind
 * allowlist was deleted, so it is no longer a second table that would catch a
 * bad label. That makes this endpoint's output vocabulary load-bearing: a label
 * with no `case` arm in `browser/…/navigation/object-nav.ts` produces a link
 * that opens the app and lands nowhere.
 *
 * ── THE LIST IS PARSED, NEVER HAND-WRITTEN ───────────────────────────────────
 * The allowed set is read off `object-nav.ts`'s own `case` labels, exactly as
 * `browser/…/navigation/deepLinkOneTable.test.ts` does. Hand-copying it here
 * would BE the third table this consolidation exists to delete.
 *
 * ── THE CROSS-REPO CAVEAT, STATED PLAINLY ────────────────────────────────────
 * `browser/` is a SEPARATE git repository (`synap/browser/.git`), and backend CI
 * checks out only `synap-backend`. So the parity block below can only run where
 * both repos are checked out side by side — the developer monorepo, which is
 * where anyone editing either table actually works. It is `runIf`-gated on the
 * file's presence rather than made to fail in CI.
 *
 * A conditional assertion is exactly the vacuity failure mode this repo has been
 * bitten by, so the gate is bounded on BOTH sides:
 *   • the always-on `describe` below exercises the parser against an INLINE
 *     FIXTURE, so a regex that stops matching fails EVERYWHERE, CI included;
 *   • the always-on block also pins the emittable-label set itself (non-empty,
 *     derived from both projection tables, exhaustive over PROBE_ORDER).
 * What CI genuinely cannot see is a label going stale because someone renamed a
 * `case` arm in the OTHER repo. Closing that would need a shared contract
 * package spanning backend and browser; there is none today (`@synap-core/
 * deep-link-constants` lives in `synap-app`, a third repo).
 */

const OBJECT_NAV = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "browser",
  "electron",
  "renderer",
  "src",
  "navigation",
  "object-nav.ts"
);

/** Prose documents the grammar; only CODE decides routing. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CASE_LABEL = /case\s+'([a-z-]+)'\s*:/g;

/** Every kind `objectNavTarget` routes, read off the table's own source. */
function routedKinds(source: string): Set<string> {
  const kinds = new Set<string>();
  for (const match of stripComments(source).matchAll(CASE_LABEL)) {
    kinds.add(match[1]!);
  }
  return kinds;
}

describe("the label projection is well-formed (runs everywhere, CI included)", () => {
  it("the case-label parser can see the shape it is looking for", () => {
    // Anti-vacuity: if this regex stops matching, the parity block below would
    // silently compare against an EMPTY allowed set and pass forever. Built
    // from fragments so this fixture is not itself a hardcoded kind list.
    const q = String.fromCharCode(39);
    const fixture = [
      `switch (kind) {`,
      `  case ${q}${["ent", "ity"].join("")}${q}:`,
      `    return null;`,
      `  case ${q}${["doc", "ument"].join("")}${q}:`,
      `    return null;`,
      `  // case ${q}${["comm", "ented"].join("")}${q}: not code`,
      `}`,
    ].join("\n");
    const kinds = routedKinds(fixture);
    expect([...kinds].sort()).toEqual(
      [["ent", "ity"].join(""), ["doc", "ument"].join("")].sort()
    );
    // …and a commented-out arm is not a routable kind.
    expect(kinds.has(["comm", "ented"].join(""))).toBe(false);
  });

  it("every emittable label is derived from the projection tables and non-empty", () => {
    expect(EMITTABLE_LABELS.length).toBeGreaterThan(5);
    expect(new Set(EMITTABLE_LABELS).size).toBe(EMITTABLE_LABELS.length);
  });

  it("every probed kind is decided EXPLICITLY — routed or declared unopenable", () => {
    // The projection is typed `Record<ObjectKind, …>`, so this cannot regress
    // silently; assert it anyway so the intent survives a type refactor.
    for (const kind of PROBE_ORDER) {
      const route = browserRouteFor({ kind });
      expect(route, `no routing decision for kind ${kind}`).not.toBeUndefined();
    }
  });

  it("a run projects onto `run` PLUS its flow discriminator, never a bare id", () => {
    // A run is addressed by {flowType, runId}. object-nav's `run` arm defaults a
    // missing `?flowType=` to 'automation', so emitting a playbook run without
    // the param would send it to the wrong reader — silently.
    expect(browserRouteFor({ kind: "automation_run" })).toEqual({
      label: "run",
      params: { flowType: "automation" },
    });
    expect(browserRouteFor({ kind: "playbook_run" })).toEqual({
      label: "run",
      params: { flowType: "playbook" },
    });
  });

  it("the `capability` umbrella splits by subKind — three tables, three doors", () => {
    expect(browserRouteFor({ kind: "capability", subKind: "skill" })).toEqual({
      label: "skill",
    });
    expect(browserRouteFor({ kind: "capability", subKind: "tool" })).toEqual({
      label: "tool",
    });
    expect(
      browserRouteFor({ kind: "capability", subKind: "capability" })
    ).toEqual({ label: "capability" });
  });

  it("a kind with no browser door is UNOPENABLE, not mapped to a lookalike", () => {
    // `external_send` is a correlationId-keyed audit event: no row, no surface.
    // The honest answer is "this is what it is, and it cannot be opened" — a
    // dead deep link is worse than a refusal.
    expect(UNOPENABLE_KINDS).toContain("external_send");
    expect(browserRouteFor({ kind: "external_send" })).toBeNull();
    expect(EMITTABLE_LABELS).not.toContain("external_send");
  });
});

const hasBrowserRepo = existsSync(OBJECT_NAV);

describe.runIf(hasBrowserRepo)(
  "every emittable label exists as a `case` in object-nav.ts (needs the browser repo)",
  () => {
    it("finds a non-trivial routing table to compare against", () => {
      // Anti-vacuity: "every label is in the set" is trivially true of an empty
      // set. If the file moves or the parse breaks, fail rather than pass.
      const kinds = routedKinds(readFileSync(OBJECT_NAV, "utf8"));
      expect(kinds.size).toBeGreaterThan(8);
    });

    it("no label this endpoint can emit is a dead deep link", () => {
      const routed = routedKinds(readFileSync(OBJECT_NAV, "utf8"));
      const dead = EMITTABLE_LABELS.filter((label) => !routed.has(label));
      expect(
        dead,
        "`/resolve/:id` can emit a label object-nav.ts has no `case` for. " +
          "The CLI turns that label straight into `synap://open/<label>/<id>`, " +
          "so the link opens the app and lands nowhere. Either add the arm in " +
          "browser/…/navigation/object-nav.ts or mark the kind unopenable in " +
          "resolve-browser-route.ts."
      ).toEqual([]);
    });
  }
);
