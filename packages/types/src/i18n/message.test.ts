import { describe, expect, it } from "vitest";
import {
  MessageSyntaxError,
  formatMessage,
  messageArguments,
  parseMessage,
  printMessage,
} from "./message.js";

const en = (m: string, p?: Record<string, string | number>) =>
  formatMessage(m, p, "en");
const fr = (m: string, p?: Record<string, string | number>) =>
  formatMessage(m, p, "fr");

const IDEAS =
  "{n, plural, =0 {No ideas} one {# idea} other {# ideas}} in {space}";

describe("formatMessage", () => {
  it("prints text and simple arguments", () => {
    expect(en("Hello")).toBe("Hello");
    expect(en("Welcome back, {name}", { name: "Ada" })).toBe(
      "Welcome back, Ada"
    );
    expect(en("{ name } and {n}", { name: "A", n: 3 })).toBe("A and 3");
  });

  it("picks the plural branch by the locale's rules, # is the number", () => {
    const m = "{n, plural, one {# file} other {# files}}";
    expect(en(m, { n: 1 })).toBe("1 file");
    expect(en(m, { n: 0 })).toBe("0 files");
    expect(en(m, { n: 2 })).toBe("2 files");
    expect(fr(m, { n: 0 })).toBe("0 file"); // French: 0 is singular
    expect(fr(m, { n: 1.5 })).toBe("1,5 file"); // the French decimal comma
  });

  it("checks exact matches before the category", () => {
    expect(en(IDEAS, { n: 0, space: "Builder" })).toBe("No ideas in Builder");
    expect(en(IDEAS, { n: 1, space: "Builder" })).toBe("1 idea in Builder");
    expect(en(IDEAS, { n: 7, space: "Builder" })).toBe("7 ideas in Builder");
    expect(
      en("{n, plural, =1 {just one} one {# one} other {#}}", { n: 1 })
    ).toBe("just one");
  });

  it("falls to other for a category the message does not list", () => {
    const m = "{n, plural, one {un} other {# autres}}";
    expect(fr(m, { n: 1000000 })).toBe("1\u202f000\u202f000 autres"); // many → other
    expect(
      fr("{n, plural, one {un} many {# de} other {#}}", { n: 2000000 })
    ).toBe("2\u202f000\u202f000 de");
  });

  it("selects on a string, other for anything else", () => {
    const m = "{kind, select, task {Task created} other {Created}}";
    expect(en(m, { kind: "task" })).toBe("Task created");
    expect(en(m, { kind: "note" })).toBe("Created");
    expect(en(m, { kind: "other" })).toBe("Created");
    expect(en(m, { kind: "toString" })).toBe("Created");
  });

  it("nests, and # in a select inside a plural is the plural's number", () => {
    const m =
      "{n, plural, one {{g, select, f {# tâche} other {# projet}}} other {{g, select, f {# tâches} other {# projets}}}}";
    expect(fr(m, { n: 1, g: "f" })).toBe("1 tâche");
    expect(fr(m, { n: 3, g: "m" })).toBe("3 projets");
    expect(
      en("{a, plural, one {# {b, plural, one {#b} other {#bs}}} other {#}}", {
        a: 1,
        b: 2,
      })
    ).toBe("1 2bs");
  });

  it("keeps # literal outside a plural, and plain apostrophes", () => {
    expect(en("#1 of {n}", { n: 2 })).toBe("#1 of 2");
    expect(fr("l'espace {name}", { name: "Builder" })).toBe("l'espace Builder");
    expect(fr("l’{name}", { name: "équipe" })).toBe("l’équipe");
  });

  it("shows a missing value as its placeholder instead of crashing", () => {
    expect(en("Hi {name}")).toBe("Hi {name}");
    expect(en("{n, plural, one {# x} other {# xs}}")).toBe("{n} xs");
    expect(en("{g, select, a {A} other {O}}")).toBe("O");
  });
});

describe("parseMessage: the subset and nothing else", () => {
  const rejects = (m: string, why: RegExp) => {
    expect(() => parseMessage(m)).toThrow(MessageSyntaxError);
    expect(() => parseMessage(m)).toThrow(why);
  };

  it("rejects malformed braces", () => {
    rejects("Hello {name", /Unclosed/);
    rejects("Hello }", /Unmatched/);
    rejects("{}", /argument name/);
    rejects("{n, plural, one {x} other {y}", /Unclosed/);
    rejects("{n, plural, one {x other {y}}", /Unclosed/);
  });

  it("rejects ICU features outside the subset", () => {
    rejects("{n, number}", /Unsupported argument type "number"/);
    rejects("{d, date, short}", /Unsupported argument type "date"/);
    rejects("{n, selectordinal, one {#st} other {#th}}", /selectordinal/);
    rejects("{n, plural, offset:1 one {x} other {y}}", /plural category/);
  });

  it("requires other, rejects unknown categories and duplicates", () => {
    rejects("{n, plural, one {x}}", /"other"/);
    rejects("{g, select, a {x}}", /"other"/);
    rejects("{n, plural, single {x} other {y}}", /Unknown plural category/);
    rejects("{n, plural, one {x} one {y} other {z}}", /Duplicate/);
    rejects("{n, plural, = {x} other {y}}", /number after =/);
  });

  it("rejects an ASCII apostrophe where ICU would quote", () => {
    rejects("l'{name}", /apostrophe/);
    rejects("it''s", /apostrophe/);
    rejects("a '}' b", /apostrophe/);
    rejects("{n, plural, other {'#}}", /apostrophe/);
    expect(() => parseMessage("'#' outside a plural")).not.toThrow();
  });

  it("memoises: the same text parses to the same AST object", () => {
    expect(parseMessage(IDEAS)).toBe(parseMessage(IDEAS));
  });

  it("prints back to text that parses to the same AST", () => {
    for (const m of [
      "Hello",
      "Welcome back, {name}",
      IDEAS,
      "{g, select, f {{n, plural, one {#} other {# x}}} other {o}}",
    ]) {
      expect(parseMessage(printMessage(parseMessage(m)))).toEqual(
        parseMessage(m)
      );
    }
  });
});

describe("messageArguments", () => {
  it("lists every argument with how it is used", () => {
    expect(Object.fromEntries(messageArguments(IDEAS))).toEqual({
      n: "plural",
      space: "arg",
    });
    expect(
      Object.fromEntries(
        messageArguments(
          "{g, select, f {{n, plural, other {# {who}}}} other {{n}}}"
        )
      )
    ).toEqual({ g: "select", n: "plural", who: "arg" });
    expect(messageArguments("Hello").size).toBe(0);
  });
});

describe("numbers print in the locale's form (value-format)", () => {
  const ITEMS =
    "{n, plural, one {# élément} many {# d’éléments} other {# éléments}}";

  it("# in a French plural: narrow no-break space thousands, decimal comma", () => {
    expect(fr(ITEMS, { n: 1000000 })).toBe("1\u202f000\u202f000 d’éléments");
    expect(fr(ITEMS, { n: 1234 })).toBe("1\u202f234 éléments");
    expect(fr(ITEMS, { n: 0 })).toBe("0 élément");
    expect(fr(ITEMS, { n: 2.5 })).toBe("2,5 éléments");
  });

  it("a numeric {arg} too; a string arg prints as given", () => {
    expect(fr("{n} sur {total}", { n: 1500, total: 2000 })).toBe(
      "1\u202f500 sur 2\u202f000"
    );
    expect(fr("en {year}", { year: "2026" })).toBe("en 2026");
  });

  it("English: unchanged below a thousand, grouped with a comma above", () => {
    expect(en("{n, plural, one {# file} other {# files}}", { n: 42 })).toBe(
      "42 files"
    );
    expect(
      en("{n, plural, one {# file} other {# files}}", { n: 1234567 })
    ).toBe("1,234,567 files");
    expect(en("{ratio}", { ratio: 0.5 })).toBe("0.5");
  });
});
