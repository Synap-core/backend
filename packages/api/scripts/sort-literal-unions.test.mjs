import { describe, expect, it } from "vitest";

import { sortStringLiteralUnions } from "./sort-literal-unions.mjs";

describe("gen-types: literal unions print in one order", () => {
  it("two orders of the same union print the same", () => {
    const a = 'data: "human" | "agent" | "playbook" | "automation";';
    const b = 'data: "agent" | "human" | "automation" | "playbook";';
    expect(sortStringLiteralUnions(a)).toBe(sortStringLiteralUnions(b));
    expect(sortStringLiteralUnions(a)).toBe(
      'data: "agent" | "automation" | "human" | "playbook";'
    );
  });

  it("keeps a non-literal tail in place", () => {
    expect(
      sortStringLiteralUnions('status?: "running" | "error" | undefined;')
    ).toBe('status?: "error" | "running" | undefined;');
    expect(
      sortStringLiteralUnions('src: "orchestrator" | "mention" | null;')
    ).toBe('src: "mention" | "orchestrator" | null;');
  });

  it("leaves a single literal and non-union text alone", () => {
    const text = 'kind: "only";\nname: string | null;';
    expect(sortStringLiteralUnions(text)).toBe(text);
  });
});
