import { describe, it, expect } from "vitest";
import {
  parseAttributes,
  parseContainerOpener,
  scanContainers,
  fenceColonsFor,
} from "./scan.js";

describe("parseAttributes (micromark's attribute grammar)", () => {
  it("quoted, single-quoted, unquoted, #id and .class", () => {
    expect(parseAttributes(`{id="x" owner='ai' round=2}`)).toEqual({
      id: "x",
      owner: "ai",
      round: "2",
    });
    expect(parseAttributes("{#anchor .a .b}")).toEqual({
      id: "anchor",
      class: "a b",
    });
  });
  it("decodes character references in values", () => {
    expect(parseAttributes(`{p="{&#x22;a&#x22;:1} &amp;"}`)).toEqual({
      p: '{"a":1} &',
    });
  });
  it("a quoted value followed by a letter is not an attribute block (the apostrophe case)", () => {
    expect(
      parseContainerOpener(`:::synap-cell{cellProps='{"label":"Team's load"}'}`)
    ).toBeNull();
  });
  it("a single-quoted value may hold braces and double quotes", () => {
    expect(
      parseContainerOpener(`:::synap-cell{cellProps='{"a":"b}"}'}`)?.attributes
    ).toEqual({ cellProps: '{"a":"b}"}' });
  });
});

describe("parseContainerOpener", () => {
  it("rejects what micromark rejects", () => {
    expect(parseContainerOpener(':::synap-cell {id="e"}')).toBeNull(); // space before brace
    expect(parseContainerOpener(':::synap-entity{id="e"} x')).toBeNull(); // trailing text
    expect(parseContainerOpener(':::synap-x-{id="e"}')).toBeNull(); // name ends in dash
    expect(parseContainerOpener('::synap-entity{id="e"}')).toBeNull(); // leaf, not a container
  });
  it("accepts up to three spaces of indentation and a label", () => {
    expect(
      parseContainerOpener('   :::synap-entity[Hi]{id="e"}')
    ).toMatchObject({
      colons: 3,
      name: "synap-entity",
      label: "Hi",
      attributes: { id: "e" },
    });
  });
});

describe("scanContainers", () => {
  it("closers match OUTERMOST first: `::::` closes the section and the cell inside it", () => {
    const { containers } = scanContainers(
      '::::synap-section{id="s"}\n:::synap-cell{cellKey="c"}\nx\n::::\nafter'
    );
    expect(
      containers.map((c) => [c.name, c.startLine, c.endLine, c.terminated])
    ).toEqual([
      ["synap-section", 0, 3, true],
      ["synap-cell", 1, 3, false],
    ]);
  });
  it("a fence hides openers but not an enclosing container's closer", () => {
    const { containers } = scanContainers(
      ':::synap-cell{cellKey="a"}\n```\n:::synap-entity{id="hidden"}\n:::\n```\n:::'
    );
    expect(containers.map((c) => [c.name, c.endLine, c.terminated])).toEqual([
      ["synap-cell", 3, true],
    ]);
  });
  it("a root fence hides everything until it closes", () => {
    expect(
      scanContainers('```\n:::synap-entity{id="e"}\n:::\n```').containers
    ).toEqual([]);
    expect(scanContainers("```\nopen").unclosedRootFence).toBe(true);
  });
  it("an unclosed container runs to EOF, unterminated", () => {
    const { containers } = scanContainers(':::synap-entity{id="e"}\nprose\n');
    expect(containers[0]).toMatchObject({
      startLine: 0,
      endLine: 2,
      terminated: false,
    });
  });
});

describe("fenceColonsFor", () => {
  it("one more than any colon-only line in the body, code included; min 3 or the given floor", () => {
    expect(fenceColonsFor("plain")).toBe(3);
    expect(fenceColonsFor("plain", 4)).toBe(4);
    expect(fenceColonsFor(':::synap-entity{id="e"}\n:::')).toBe(4);
    expect(fenceColonsFor("```\n:::::\n```", 4)).toBe(6);
  });
});
