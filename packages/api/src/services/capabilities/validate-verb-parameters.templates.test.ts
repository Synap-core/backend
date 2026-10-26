import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkVerbParameters } from "./validate-verb-parameters.js";

/**
 * Every shipped code skill's `parameters` is read by the pod's ONE validator,
 * and a call built from string values (how CLI and HTTP callers send them) is
 * accepted. Ported from the IS `skills-executor.regression` test (b), which
 * proved the same over its `buildZodSchema`; the pod sandbox now validates
 * with `checkVerbParameters` before any code runs (R1).
 *
 * The set is DERIVED: every `kind:"code"` skill of every capability in the
 * official catalog source, synap-app/packages/workspace-templates/capabilities
 * (envelope `spec`). Missing = RED, never skip.
 *
 * NOT covered: a skill whose author declared a type outside the dialect; the
 * validator skips that field (see its own test), so it cannot be refused here.
 */

const REPO_ROOT = join(import.meta.dirname, "../../../../../..");
const CATALOG = join(
  REPO_ROOT,
  "synap-app/packages/workspace-templates/capabilities"
);

type Declared = Record<string, unknown>;
interface CodeSkill {
  template: string;
  name: string;
  parameters: Declared | undefined;
}

function loadCodeSkills(): CodeSkill[] {
  const out: CodeSkill[] = [];
  for (const file of readdirSync(CATALOG)) {
    if (!file.endsWith(".capability.json")) continue;
    const json = JSON.parse(readFileSync(join(CATALOG, file), "utf8")) as {
      spec?: { key?: string; skills?: Array<Record<string, unknown>> };
    };
    for (const s of json.spec?.skills ?? []) {
      if (s.kind !== "code") continue;
      out.push({
        template: String(json.spec?.key ?? file),
        name: String(s.name),
        parameters: s.parameters as Declared | undefined,
      });
    }
  }
  return out;
}

/** A call carrying EVERY declared field, as a CLI would send it: all strings. */
function stringCall(declared: Declared): Record<string, unknown> {
  const call: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(declared)) {
    const type = String(raw).replace(/\?$/, "");
    call[field] =
      type === "number"
        ? "5"
        : type === "boolean"
          ? "true"
          : type === "array"
            ? []
            : type === "object"
              ? {}
              : "x";
  }
  return call;
}

describe("shipped code skills: every `parameters` is readable and accepts a string-encoded call", () => {
  it("the catalog source is present", () => {
    expect(existsSync(CATALOG), CATALOG).toBe(true);
  });

  const skills = existsSync(CATALOG) ? loadCodeSkills() : [];

  it("non-vacuity: the scan found the shipped code skills, including the one that crashed the IS", () => {
    // 53 on 2026-10-26.
    expect(skills.length).toBeGreaterThanOrEqual(40);
    expect(skills.some((s) => s.name === "linkedin_search_people")).toBe(true);
    // And at least one declares a number (what the string-call probes).
    expect(
      skills.some((s) =>
        Object.values(s.parameters ?? {}).some((t) =>
          String(t).startsWith("number")
        )
      )
    ).toBe(true);
  });

  it.each(skills.map((s) => [s.template, s.name, s] as const))(
    "%s / %s",
    (_t, _n, s) => {
      const call = stringCall(s.parameters ?? {});
      const check = checkVerbParameters(
        { kind: "code", name: s.name, parameters: s.parameters },
        call
      );
      // Readable (never the JSON-Schema "unreadable" branch) …
      expect(check).not.toEqual({
        status: "unvalidated",
        reason: "unreadable_dialect",
      });
      // … and a complete string-encoded call is accepted.
      expect(check.status, JSON.stringify(check)).not.toBe("invalid");
    }
  );
});
