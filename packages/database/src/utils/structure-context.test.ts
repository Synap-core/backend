import { describe, it, expect } from "vitest";
import {
  assembleStructureContext,
  composeStructureContext,
  STRUCTURE_INSTRUCTIONS_BUDGET,
} from "./structure-context.js";
import type { ResolvedGuideline } from "./config-settings.js";

/**
 * Driven through the REAL resolver (`resolveGuidelines`) with the same
 * one-query fake db as config-settings.test.ts, so a kind/source-scoped row
 * travels store row → resolver → composer → instructions with nothing
 * hand-built in between.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(rows: any[]): any {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (r: unknown[]) => void) => resolve(rows),
        }),
      }),
    }),
  };
}

function row(o: {
  id: string;
  scopeKind: string;
  scopeRef?: string | null;
  text: string;
  version?: number;
}) {
  return {
    id: o.id,
    scopeKind: o.scopeKind,
    scopeRef: o.scopeRef ?? null,
    value: { text: o.text },
    shape: null,
    version: o.version ?? 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function g(id: string, specificity: number, text: string): ResolvedGuideline {
  return {
    id,
    version: 1,
    scopeKind: "default",
    scopeRef: null,
    specificity,
    text,
  };
}

describe("assembleStructureContext — through the real resolver", () => {
  it("a source-scoped and a kind-scoped guideline both reach the instructions, with the explicit text last, and their {id,version} are returned", async () => {
    const out = await assembleStructureContext({
      db: makeDb([
        row({
          id: "g-src",
          scopeKind: "sourceKind",
          scopeRef: "image",
          text: "Read prices literally",
          version: 2,
        }),
        row({
          id: "g-kind",
          scopeKind: "entityKind",
          scopeRef: "person",
          text: "Capture the LinkedIn URL",
        }),
        row({
          id: "g-other-src",
          scopeKind: "sourceKind",
          scopeRef: "url",
          text: "never",
        }),
      ]),
      userId: "u1",
      sourceKind: "image",
      entityKinds: ["person"],
      instructions: ["explicit wins"],
    });
    expect(out.instructions).toBe(
      "Read prices literally\n\n" +
        'When structuring a "person": Capture the LinkedIn URL\n\n' +
        "explicit wins"
    );
    expect(out.guidelines).toEqual([
      { id: "g-src", version: 2 },
      { id: "g-kind", version: 1 },
    ]);
    expect(out.guidelineStatus).toBe("ok");
    expect(out.truncated).toBe(false);
  });

  it("NO-OP: with nothing matching, the text is byte-identical to the explicit parts joined (or undefined)", async () => {
    const nonMatching = [
      row({
        id: "g-src",
        scopeKind: "sourceKind",
        scopeRef: "url",
        text: "never",
      }),
      row({
        id: "g-kind",
        scopeKind: "entityKind",
        scopeRef: "deal",
        text: "never",
      }),
    ];
    const explicit = ["  new-lead intake  ", undefined, "anchor block"];
    const out = await assembleStructureContext({
      db: makeDb(nonMatching),
      userId: "u1",
      sourceKind: "text",
      entityKinds: ["person"],
      instructions: explicit,
    });
    expect(out.instructions).toBe(
      [explicit[0], explicit[2]].map((s) => s!.trim()).join("\n\n")
    );
    expect(out.guidelines).toEqual([]);

    const none = await assembleStructureContext({
      db: makeDb(nonMatching),
      userId: "u1",
    });
    expect(none.instructions).toBeUndefined();
  });

  it("a FAILED guideline read is reported, not folded into 'none', and explicit instructions still flow", async () => {
    const failingDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (_res: unknown, rej: (e: Error) => void) =>
              rej(new Error("db down")),
          }),
        }),
      }),
    };
    const out = await assembleStructureContext({
      db: failingDb as never,
      userId: "u1",
      instructions: ["explicit"],
    });
    expect(out.guidelineStatus).toBe("unavailable");
    expect(out.instructions).toBe("explicit");
  });
});

describe("composeStructureContext — the shared budget", () => {
  it("drops the LEAST specific guidelines whole, keeps explicit, never exceeds the budget, and is deterministic", () => {
    const input = {
      guidelines: [
        g("general", 0, "a".repeat(50)),
        g("middle", 1, "b".repeat(50)),
        g("specific", 2, "c".repeat(50)),
      ],
      instructions: ["x".repeat(40)],
      budget: 150,
    };
    const out = composeStructureContext(input);
    // explicit 40 + specific 52 + middle 52 = 144 ≤ 150; general would be 196.
    expect(out.guidelines.map((r) => r.id)).toEqual(["middle", "specific"]);
    expect(out.dropped.map((r) => r.id)).toEqual(["general"]);
    expect(out.truncated).toBe(true);
    expect(out.instructions!.length).toBeLessThanOrEqual(150);
    expect(out.instructions).toBe(
      ["b".repeat(50), "c".repeat(50), "x".repeat(40)].join("\n\n")
    );
    expect(composeStructureContext(input)).toEqual(out);
  });

  it("hard-slices only an explicit text that alone exceeds the budget, and then admits no guideline", () => {
    const out = composeStructureContext({
      guidelines: [g("gl", 0, "short")],
      instructions: ["y".repeat(STRUCTURE_INSTRUCTIONS_BUDGET + 10)],
    });
    expect(out.instructions).toBe("y".repeat(STRUCTURE_INSTRUCTIONS_BUDGET));
    expect(out.guidelines).toEqual([]);
    expect(out.dropped).toEqual([{ id: "gl", version: 1 }]);
  });

  it("puts import guidance between guidelines and explicit instructions", () => {
    const out = composeStructureContext({
      guidelines: [g("gl", 0, "guideline")],
      importGuidance: "import notes",
      instructions: ["explicit"],
    });
    expect(out.instructions).toBe("guideline\n\nimport notes\n\nexplicit");
  });
});
