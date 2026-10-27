/**
 * The ask schema under EACH zod major this package admits (`^3.25.0 ||
 * ^4.0.0`). The backend pins zod 4; the root workspace (app, browser, relay,
 * and the be-types gate) resolves zod 3.25, where a zod-4-only param is
 * silently ignored. follow-up.test.ts went red only there (27 Oct 2026): the
 * one-level refusal read zod 3's default wording. Here both majors are loaded
 * explicitly (`zod/v3`, `zod/v4` ship in both packages), whichever one the
 * tree resolves.
 *
 * Covers ask/index.ts only: another module's zod-4-only param is not seen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAskUnder(major: "v3" | "v4") {
  vi.resetModules();
  vi.doMock("zod", () => (major === "v3" ? import("zod/v3") : import("zod/v4")));
  return import("./index.js");
}

afterEach(() => {
  vi.doUnmock("zod");
  vi.resetModules();
});

const deepChoose = (optionExtra: Record<string, unknown>) => ({
  mode: "choose",
  options: [
    {
      label: "X",
      followUp: {
        prompt: "Then?",
        options: [{ label: "A", ...optionExtra }, { label: "B" }],
      },
    },
  ],
});

describe.each(["v3", "v4"] as const)("the ask schema under zod %s", (major) => {
  it("is built by that major (the mock took)", async () => {
    const { AskSchema } = await loadAskUnder(major);
    // zod 4 schemas carry `_zod`; zod 3 schemas do not.
    expect("_zod" in AskSchema).toBe(major === "v4");
  });

  it("refuses a second level with its own wording", async () => {
    const { AskSchema } = await loadAskUnder(major);
    const deep = AskSchema.safeParse(
      deepChoose({ followUp: { prompt: "Deeper?", options: [{ label: "A" }, { label: "B" }] } })
    );
    expect(deep.success).toBe(false);
    expect(JSON.stringify(deep.error?.issues)).toMatch(/one level deep/);
  });

  it("refuses another unknown key with the default wording, not the follow-up one", async () => {
    const { AskSchema } = await loadAskUnder(major);
    const stray = AskSchema.safeParse(deepChoose({ colour: "red" }));
    expect(stray.success).toBe(false);
    const issues = JSON.stringify(stray.error?.issues);
    expect(issues).toMatch(/colour/);
    expect(issues).not.toMatch(/one level deep/);
  });

  it("keeps one level", async () => {
    const { AskSchema } = await loadAskUnder(major);
    expect(AskSchema.safeParse(deepChoose({})).success).toBe(true);
  });
});
