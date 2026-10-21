import { describe, expect, it } from "vitest";

import { sortTypeLiteralMembers } from "./sort-type-members.mjs";

describe("gen-types: object type members print in one order", () => {
  it("two member orders of the same type print the same (the archivedAt drift)", () => {
    const a = `type T = {\n\tsettings: S;\n\tarchivedAt: Date | null;\n\townerId: string;\n};\n`;
    const b = `type T = {\n\tsettings: S;\n\townerId: string;\n\tarchivedAt: Date | null;\n};\n`;
    expect(sortTypeLiteralMembers(a)).toBe(sortTypeLiteralMembers(b));
    expect(sortTypeLiteralMembers(a)).toBe(
      `type T = {\n\tarchivedAt: Date | null;\n\townerId: string;\n\tsettings: S;\n};\n`
    );
  });

  it("sorts nested literals, inside generics and intersections", () => {
    const text = `export declare const r: R<{\n\tlist: ({\n\t\tz: 1;\n\t\ta: 2;\n\t} & {\n\t\trole?: string;\n\t\tjoinedAt?: Date;\n\t})[];\n\tcreate: X;\n}>;\n`;
    expect(sortTypeLiteralMembers(text)).toBe(
      `export declare const r: R<{\n\tcreate: X;\n\tlist: ({\n\t\ta: 2;\n\t\tz: 1;\n\t} & {\n\t\tjoinedAt?: Date;\n\t\trole?: string;\n\t})[];\n}>;\n`
    );
  });

  it("a member's doc comment travels with it", () => {
    const text = `type T = {\n\t/** about b */\n\tb: string;\n\ta: number;\n};\n`;
    expect(sortTypeLiteralMembers(text)).toBe(
      `type T = {\n\ta: number;\n\t/** about b */\n\tb: string;\n};\n`
    );
  });

  it("leaves overloads, index signatures and unterminated members as printed", () => {
    const methods = `type T = {\n\tb(x: string): void;\n\ta: number;\n\tb(x: number): void;\n};\n`;
    const index = `type T = {\n\tb: string;\n\t[k: string]: unknown;\n};\n`;
    const bare = `type T = { b: string; a: number };\n`;
    for (const t of [methods, index, bare]) {
      expect(sortTypeLiteralMembers(t)).toBe(t);
    }
  });

  it("is idempotent on already-sorted text", () => {
    const text = `type T = {\n\ta: number;\n\tb: { c: 1; d: 2; };\n};\n`;
    expect(sortTypeLiteralMembers(text)).toBe(text);
  });
});
