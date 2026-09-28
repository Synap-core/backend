import { describe, it, expect } from "vitest";
import { ASK_LIMITS, AskSchema, askFingerprint } from "./index.js";

const ref = (i: number) => ({ kind: "entity" as const, id: `e-${i}` });

describe('ask "what I looked at"', () => {
  it("rides beside every mode", () => {
    const lookedAt = [ref(1), { kind: "document", id: "d-1" }];
    for (const ask of [
      { mode: "confirm" },
      { mode: "choose", options: [{ label: "A" }] },
      { mode: "form", form: { fields: [{ key: "k", label: "K", type: "text" }] } },
      { mode: "act" },
      { mode: "provide", provide: { kind: "file" } },
    ]) {
      const parsed = AskSchema.safeParse({ ...ask, lookedAt });
      expect(parsed.success, ask.mode).toBe(true);
      expect(parsed.success && parsed.data.lookedAt, ask.mode).toEqual(lookedAt);
    }
  });

  it("is capped: at most 8 refs, more is refused (never clipped)", () => {
    const eight = Array.from({ length: ASK_LIMITS.lookedAtMax }, (_, i) => ref(i));
    expect(ASK_LIMITS.lookedAtMax).toBe(8);
    expect(AskSchema.safeParse({ mode: "confirm", lookedAt: eight }).success).toBe(true);
    expect(
      AskSchema.safeParse({ mode: "confirm", lookedAt: [...eight, ref(9)] }).success
    ).toBe(false);
  });

  it("never trusts an agent's title: it is stripped at the parse", () => {
    const parsed = AskSchema.parse({
      mode: "confirm",
      lookedAt: [{ kind: "entity", id: "e-1", title: "Totally the CEO's salary" }],
    });
    expect(parsed.lookedAt).toEqual([{ kind: "entity", id: "e-1" }]);
  });

  it("refuses a kind the pod cannot adjudicate (cell, url, session)", () => {
    for (const kind of ["cell", "url", "session"]) {
      expect(
        AskSchema.safeParse({ mode: "confirm", lookedAt: [{ kind, id: "x" }] })
          .success,
        kind
      ).toBe(false);
    }
  });

  it("is outside the fingerprint: a titled read answers against the stored ask", () => {
    const stored = AskSchema.parse({ mode: "confirm", lookedAt: [ref(1)] });
    const read = { ...stored, lookedAt: [{ ...ref(1), title: "Acme" }] };
    expect(askFingerprint(read as never)).toBe(askFingerprint(stored));
    expect(askFingerprint(stored)).toBe(askFingerprint({ mode: "confirm" }));
  });
});
