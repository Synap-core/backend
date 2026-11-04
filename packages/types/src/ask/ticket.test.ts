/**
 * The ask's TICKET fields (`ticketFields`, `./index.ts`): urgency, answerBy,
 * consequence, reversible, dedupeKey — on every mode, each refused in words
 * when malformed, under each zod major the package admits.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAskUnder(major: "v3" | "v4") {
  vi.resetModules();
  vi.doMock("zod", () =>
    major === "v3" ? import("zod/v3") : import("zod/v4")
  );
  return import("./index.js");
}

afterEach(() => {
  vi.doUnmock("zod");
  vi.resetModules();
});

const TICKET = {
  urgency: "whenever",
  answerBy: "2026-11-05T17:00:00Z",
  consequence: "Publishes the post to LinkedIn",
  reversible: false,
  dedupeKey: "post-42-publish",
};

describe.each(["v3", "v4"] as const)(
  "ask ticket fields under zod %s",
  (major) => {
    it("ride every mode and are kept by the parse", async () => {
      const { AskSchema } = await loadAskUnder(major);
      const modes = [
        { mode: "confirm", prompt: "Publish?" },
        { mode: "choose", options: [{ label: "A" }] },
        {
          mode: "form",
          form: { fields: [{ key: "n", label: "Name", type: "text" }] },
        },
        { mode: "act", steps: ["Do it"] },
        { mode: "provide", provide: { kind: "file" } },
      ];
      for (const m of modes) {
        const parsed = AskSchema.safeParse({ ...m, ...TICKET });
        expect(parsed.success, JSON.stringify(m)).toBe(true);
        expect(parsed.data).toMatchObject(TICKET);
      }
    });

    it("refuse an urgency outside the closed three", async () => {
      const { AskSchema } = await loadAskUnder(major);
      expect(
        AskSchema.safeParse({ mode: "confirm", urgency: "asap" }).success
      ).toBe(false);
    });

    it("refuse an answerBy that is not an instant with its offset", async () => {
      const { AskSchema } = await loadAskUnder(major);
      for (const bad of [
        "tomorrow",
        "2026-11-05",
        "2026-11-05T17:00:00",
        "2026-13-45T99:00:00Z",
      ]) {
        expect(
          AskSchema.safeParse({ mode: "confirm", answerBy: bad }).success,
          bad
        ).toBe(false);
      }
      expect(
        AskSchema.safeParse({
          mode: "confirm",
          answerBy: "2026-11-05T17:00:00.000+01:00",
        }).success
      ).toBe(true);
    });

    it("refuse an empty dedupeKey or consequence", async () => {
      const { AskSchema } = await loadAskUnder(major);
      expect(
        AskSchema.safeParse({ mode: "confirm", dedupeKey: "  " }).success
      ).toBe(false);
      expect(
        AskSchema.safeParse({ mode: "confirm", consequence: "" }).success
      ).toBe(false);
    });
  }
);
