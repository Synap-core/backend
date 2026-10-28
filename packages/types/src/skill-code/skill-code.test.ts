/**
 * The code-skill rule, as the catalog validator and the pod both call it.
 * Rows that rule out a wrong rule: the Apollo line (`??` mixed with `||`)
 * that shipped for three months, which a "does it look like JS" check passes;
 * a helper beside a top-level `return`, which "first statement is a function"
 * would refuse; side-effect code with no `return`, which "must return" would
 * refuse; a local shadow of a forbidden name, which a name blacklist refuses.
 */
import { describe, expect, it } from "vitest";
import { checkSkillCode, SKILL_ALLOWED_GLOBALS } from "./index.js";

describe("checkSkillCode", () => {
  it("refuses a syntax error the catalog shipped (apollo_search_people)", () => {
    const apolloLine = `const rows = args.people ?? [];
return rows.map((p) => ({
  name: p?.name ?? [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null,
}));`;
    expect(checkSkillCode(apolloLine)).toMatchObject({ kind: "syntax" });
    // The same line, parenthesised, is fine.
    expect(
      checkSkillCode(
        apolloLine.replace(
          "p?.name ?? [p?.first_name, p?.last_name].filter(Boolean).join(' ') || null",
          "(p?.name ?? [p?.first_name, p?.last_name].filter(Boolean).join(' ')) || null"
        )
      )
    ).toBeNull();
  });

  it("refuses code that only defines a function", () => {
    expect(
      checkSkillCode("async (args, context) => { return args.text; }")
    ).toMatchObject({ kind: "defines-only" });
    expect(checkSkillCode("function run() { return 1; }")).toMatchObject({
      kind: "defines-only",
    });
  });

  it("refuses a global the runtime does not provide, naming it", () => {
    const problem = checkSkillCode("return await fetch('https://x');");
    expect(problem).toMatchObject({
      kind: "unknown-globals",
      globals: ["fetch"],
    });
    expect(problem?.message).toMatch(/host\.fetch/);
  });

  it("passes a function body, with or without a return", () => {
    for (const ok of [
      "function helper(x) { return x; }\nreturn helper(args.text);",
      "await propose({ summary: String(args.text) });",
      "const fetch = host.fetch; return await fetch('https://x');",
      "",
      "   ",
    ]) {
      expect(checkSkillCode(ok), ok).toBeNull();
    }
  });

  it("allows the runtime's own surface (non-vacuity)", () => {
    for (const name of ["callProvider", "host", "URLSearchParams", "args"]) {
      expect(SKILL_ALLOWED_GLOBALS).toContain(name);
    }
  });
});
