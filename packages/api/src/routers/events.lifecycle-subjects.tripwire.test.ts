/**
 * Tripwire: every family `parseConnectionEvent` (`@synap-core/types/events`)
 * turns into a Happened line is CLASSIFIED by the SQL prefilter of
 * `events.read({ dataLines })` — prefiltered in (`LIFECYCLE_LINE_SUBJECTS`) or
 * deliberately left to its own read, with a reason
 * (`LIFECYCLE_SUBJECTS_LEFT_TO_THEIR_OWN_READ`).
 *
 * The parser's families are DERIVED from its source (`case "<subject>":`
 * inside `parseConnectionEvent`), never hand-listed here, so a family the
 * parser learns fails this test until someone decides where it goes — the
 * defect it prevents is a lifecycle line that parses but never reaches a page
 * because SQL dropped it first.
 *
 * Does NOT cover: a family whose `case` label is computed (not a string
 * literal) — none exists today; the non-vacuity floor and the literal
 * self-check below fail if the scan stops seeing cases at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseConnectionEvent } from "@synap-core/types/events";
import {
  LIFECYCLE_LINE_SUBJECTS,
  LIFECYCLE_SUBJECTS_LEFT_TO_THEIR_OWN_READ,
} from "./events.js";

const here = dirname(fileURLToPath(import.meta.url));
const parserSource = readFileSync(
  join(here, "../../../types/src/events/connection-lines.ts"),
  "utf8"
);

function parserSubjects(src: string): string[] {
  const start = src.indexOf("export function parseConnectionEvent(");
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start);
  // The parser's top-level `switch (subject)` — its cases are the families.
  const sw = body.indexOf("switch (subject)");
  expect(sw).toBeGreaterThan(-1);
  const end = body.indexOf("\n}\n", sw);
  const block = body.slice(sw, end === -1 ? undefined : end);
  return [...block.matchAll(/^\s{4}case "([a-zA-Z_]+)":/gm)].map((m) => m[1]!);
}

describe("events.read dataLines — every lifecycle family is classified", () => {
  const families = parserSubjects(parserSource);

  it("the scan sees the parser's families (non-vacuity + a literal sample)", () => {
    expect(families.length).toBeGreaterThanOrEqual(10);
    expect(families).toContain("app");
    expect(families).toContain("webhooks");
  });

  it("each family is prefiltered in or left out with a reason — never neither", () => {
    const leftOut = Object.keys(LIFECYCLE_SUBJECTS_LEFT_TO_THEIR_OWN_READ);
    const unclassified = families.filter(
      (f) =>
        !(LIFECYCLE_LINE_SUBJECTS as readonly string[]).includes(f) &&
        !leftOut.includes(f)
    );
    expect(unclassified).toEqual([]);
  });

  it("nothing is both, and nothing classified is a family the parser does not have", () => {
    const leftOut = Object.keys(LIFECYCLE_SUBJECTS_LEFT_TO_THEIR_OWN_READ);
    for (const s of LIFECYCLE_LINE_SUBJECTS) {
      expect(leftOut).not.toContain(s);
      expect(families).toContain(s);
    }
    for (const s of leftOut) expect(families).toContain(s);
  });

  it("a prefiltered family really parses into a line (behaviour, not just a label)", () => {
    expect(parseConnectionEvent("app.approve.completed", { name: "X" })).not.toBeNull();
    expect(parseConnectionEvent("apiKey.revoke.completed", {})).not.toBeNull();
    expect(parseConnectionEvent("connector.auth_expire", {})).not.toBeNull();
  });
});
