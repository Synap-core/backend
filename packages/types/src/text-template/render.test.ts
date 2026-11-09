import { describe, expect, it } from "vitest";
import {
  findUnresolvedTextReferences,
  renderText,
  type RenderTextInput,
} from "./index.js";

function ok(template: string, input: RenderTextInput) {
  const r = renderText(template, input);
  if (!r.ok) throw new Error(`blocked: ${r.missing.join(",")}`);
  return r;
}

describe("renderText", () => {
  it("fills a declared {name} and @{arg:name}", () => {
    const r = ok("Hi {first}, @{arg:first}!", {
      variables: [{ name: "first", required: true }],
      values: { first: "Ada" },
    });
    expect(r.text).toBe("Hi Ada, Ada!");
    expect(r.misses).toEqual([]);
  });

  it("a missing required variable blocks and names it", () => {
    const r = renderText("Hi {first} {last}", {
      variables: [
        { name: "first", required: true },
        { name: "last", required: true },
      ],
      values: { last: "  " },
    });
    expect(r).toEqual({ ok: false, missing: ["first", "last"] });
  });

  it("uses the default when the value is absent or blank", () => {
    const r = ok("{tone}", {
      variables: [{ name: "tone", default: "warm" }],
      values: { tone: "" },
    });
    expect(r.text).toBe("warm");
  });

  it("an optional variable with no default renders empty and is recorded", () => {
    const r = ok("a{opt}b", { variables: [{ name: "opt" }] });
    expect(r.text).toBe("ab");
    expect(r.misses).toEqual([{ name: "opt", kind: "unknown-arg", count: 1 }]);
  });

  it("braces that are not a declared variable stay untouched", () => {
    const r = ok('{see below} {a.b} {"json": 1} {undeclared} {}', {
      variables: [],
    });
    expect(r.text).toBe('{see below} {a.b} {"json": 1} {undeclared} {}');
    expect(r.misses).toEqual([
      { name: "undeclared", kind: "literal-brace", count: 1 },
    ]);
  });

  it("a VALUE containing {x} stays literal (never re-parsed)", () => {
    const r = ok("{a} / {b}", {
      variables: [{ name: "a" }, { name: "b" }],
      values: { a: "{b}", b: "@{arg:a} {{a}} {today}" },
      builtins: { today: "2026-11-09" },
    });
    expect(r.text).toBe("{b} / @{arg:a} {{a}} {today}");
  });

  it("{{steps...}} text in the body is left untouched", () => {
    const body = "Hi {{steps.find.name}} and {{trigger.payload.x}} {{name}}";
    const r = ok(body, {
      variables: [{ name: "name" }],
      values: { name: "Ada" },
    });
    expect(r.text).toBe(body);
  });

  it("an undeclared prototype name never resolves", () => {
    const r = ok("{constructor} {toString} @{arg:__proto__}", {
      variables: [],
      values: {},
    });
    expect(r.text).toBe("{constructor} {toString} ");
  });

  it("a declared name is read from own keys only", () => {
    const values = Object.create({ name: "inherited" }) as Record<
      string,
      string
    >;
    const r = ok("{name}", { variables: [{ name: "name" }], values });
    expect(r.text).toBe("");
  });

  it("fills the built-ins; an unfilled one renders empty and is recorded", () => {
    const r = ok("{today}|{now}|{me}|{clipboard}|{selection}|@{context:text}", {
      variables: [],
      builtins: { today: "D", now: "N", me: "M", clipboard: "C" },
    });
    expect(r.text).toBe("D|N|M|C||C");
    expect(r.misses.map((m) => m.name).sort()).toEqual(["selection"]);
  });

  it("a declared variable named like a built-in wins", () => {
    const r = ok("{me}", {
      variables: [{ name: "me", required: true }],
      values: { me: "Ada" },
      builtins: { me: "Bob" },
    });
    expect(r.text).toBe("Ada");
  });

  it("counts repeated misses once with a count", () => {
    const r = ok("{x}{x}", { variables: [] });
    expect(r.misses).toEqual([{ name: "x", kind: "literal-brace", count: 2 }]);
  });
});

describe("findUnresolvedTextReferences", () => {
  it("treats built-ins as declared", () => {
    expect(findUnresolvedTextReferences("{today} {a} {b}", ["a"])).toEqual([
      { text: "{b}", kind: "unknown-arg" },
    ]);
  });
});
