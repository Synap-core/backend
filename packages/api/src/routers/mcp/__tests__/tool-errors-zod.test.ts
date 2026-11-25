import { describe, it, expect } from "vitest";
import { z } from "zod";
import { toSafeToolError } from "../tool-errors.js";

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("");

const schema = z.object({
  items: z.array(z.object({ a: z.string() })),
});

function zodFailure(n: number): unknown {
  const r = schema.safeParse({ items: Array.from({ length: n }, () => ({})) });
  if (r.success) throw new Error("expected failure");
  return r.error;
}

describe("toSafeToolError — zod failures list every issue", () => {
  it("lists all 12 issues of a direct ZodError (was cut at 5)", () => {
    const text = textOf(toSafeToolError(zodFailure(12), "t"));
    for (let i = 0; i < 12; i++) expect(text).toContain(`items.${i}.a`);
  });

  it("unwraps a ZodError carried as a wrapper error's cause", () => {
    const wrapped = Object.assign(new Error("x".repeat(900)), {
      name: "TRPCError",
      cause: zodFailure(8),
    });
    const text = textOf(toSafeToolError(wrapped, "t"));
    expect(text).toContain("rejected the arguments");
    for (let i = 0; i < 8; i++) expect(text).toContain(`items.${i}.a`);
  });

  it("says how many issues were omitted past the cap", () => {
    const text = textOf(toSafeToolError(zodFailure(40), "t"));
    expect(text).toContain("(10 more issues omitted)");
  });
});
