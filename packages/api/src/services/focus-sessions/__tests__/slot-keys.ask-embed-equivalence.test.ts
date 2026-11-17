/**
 * The `:::synap-ask` embed resolves its slot with a SHARED copy of the answer
 * door's rule (`findAskSlot`, `@synap-core/types/ask`), because the phone, the
 * browser and web cannot import `@synap/api`. This pins the two together, so a
 * drift in either is red here, not a wrong answer sent in production.
 *
 * Deterministic: a seeded PRNG over slot arrays that mix duplicate labels, keys
 * equal to other labels or to derived keys, keyless (legacy) and label-less
 * slots, non-object entries, unicode / casefold / whitespace labels, and
 * owed / answered / done / retired states.
 *
 * Properties (E = the embed's rule, S = `findSlotIndex`, the door's):
 *  1. whenever E resolves slot X, S called with X's matched KEY resolves X;
 *  2. a key hit on the server is a hit, on the same slot, in the embed;
 *  3. the ONLY raw-ref divergence is the intended one: several slots share the
 *     label and no key hits. E takes the single OWED one, or is `ambiguous`;
 *     S takes the first.
 */
import { describe, it, expect } from "vitest";
import { findAskSlot } from "@synap-core/types/ask";
import { deriveSlotKeys } from "@synap-core/types/units";
import { findSlotIndex } from "../slot-keys.js";

/** A bare comparison: `expect` costs ~100x as much over 100k+ cases. */
function agree(actual: unknown, wanted: unknown, where: string): void {
  if (actual !== wanted) {
    throw new Error(
      `${where}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`
    );
  }
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = [
  "Ship it?",
  "ship it?",
  "  SHIP IT?  ",
  "Pick a logo",
  "pick a logo ",
  "Ünï côdé",
  "ünï CÔDÉ",
  "İstanbul",
  "Straße",
  "STRASSE",
  "a",
  "A",
  " ",
  "",
];
const KEYS = [
  "ship-it",
  "ship-it-2",
  "pick-a-logo",
  "pick-a-logo-2",
  " ship-it ",
  "Ship it?",
  "a",
  "straße",
  "output",
  "output-2",
];
const JUNK: unknown[] = [null, 5, "x", [], undefined];
const STATES = [
  { owner: "human", status: "pending" },
  { owner: "human", status: "pending" },
  { owner: "agent", answer: { text: "yes" } },
  { owner: "human", status: "done" },
  { owner: "human", status: "pending", retiredAt: "2026-11-16T10:00:00Z" },
  { owner: "human", status: "pending", attestedAt: "2026-11-16T10:00:00Z" },
  { owner: "human", status: "pending", answer: { text: "old" } },
  {},
];

function build(rnd: () => number): unknown[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const n = 1 + Math.floor(rnd() * 6);
  return Array.from({ length: n }, () => {
    if (rnd() < 0.08) return pick(JUNK);
    const slot: Record<string, unknown> = { ...pick(STATES) };
    const shape = rnd();
    if (shape < 0.8) slot.label = pick(LABELS);
    else if (shape < 0.9) slot.description = pick(LABELS);
    else slot.profileSlug = "note";
    if (rnd() < 0.45) slot.key = pick(KEYS);
    return slot;
  });
}

function refsFor(slots: unknown[], rnd: () => number): string[] {
  const keys = deriveSlotKeys(slots);
  const refs = new Set<string>(["", " ", "nope", "ship-it", "Ship It?"]);
  for (const [i, s] of slots.entries()) {
    if (keys[i]) refs.add(keys[i]!);
    const label = (s as { label?: unknown } | null)?.label;
    if (typeof label === "string") {
      refs.add(label);
      refs.add(` ${label.toUpperCase()} `);
    }
  }
  refs.add(LABELS[Math.floor(rnd() * LABELS.length)]!);
  refs.add(KEYS[Math.floor(rnd() * KEYS.length)]!);
  return [...refs];
}

const owedNow = (s: unknown) => {
  const o = s as Record<string, unknown>;
  return (
    o.owner === "human" && o.status !== "done" && !o.retiredAt && !o.attestedAt
  );
};

describe("the ask embed's slot rule is the answer door's rule", () => {
  it("agrees with findSlotIndex across 20k seeded slot arrays", () => {
    const rnd = prng(0x5a17);
    let cases = 0;
    let resolved = 0;
    let divergent = 0;
    for (let n = 0; n < 20_000; n++) {
      const slots = build(rnd);
      const keys = deriveSlotKeys(slots);
      for (const ref of refsFor(slots, rnd)) {
        cases++;
        const e = findAskSlot(slots, ref);
        const s = findSlotIndex(slots, ref);
        // Cheap on purpose: the case is reproducible from (seed, n, ref).
        const where = `array #${n}, ref ${JSON.stringify(ref)}`;
        const keyHit = ref.trim() !== "" && keys.includes(ref.trim());

        if (e && e !== "ambiguous") {
          resolved++;
          const at = slots.indexOf(e.slot);
          agree(at >= 0, true, where);
          // 1. the matched KEY names the same slot at the door.
          agree(e.key, keys[at], where);
          agree(findSlotIndex(slots, e.key), at, where);
        }
        // 2. a key hit is the same slot in both.
        if (keyHit) {
          agree(e !== null && e !== "ambiguous", true, where);
          agree(slots.indexOf((e as { slot: unknown }).slot), s, where);
          continue;
        }
        // No key hit: a label match, or nothing.
        if (s === -1) {
          agree(e, null, where);
          continue;
        }
        if (e === null)
          throw new Error(
            `embed missed a door hit: ${where} ${JSON.stringify(slots)}`
          );
        // 3. the one intended divergence: a shared label.
        const label = (slots[s] as { label: string }).label
          .trim()
          .toLowerCase();
        const sameLabel = slots.flatMap((x, i) =>
          typeof (x as { label?: unknown } | null)?.label === "string" &&
          (x as { label: string }).label.trim().toLowerCase() === label
            ? [i]
            : []
        );
        if (sameLabel.length === 1) {
          agree(slots.indexOf((e as { slot: unknown }).slot), s, where);
          continue;
        }
        divergent++;
        const owed = sameLabel.filter((i) => owedNow(slots[i]));
        if (owed.length === 1) {
          agree(slots.indexOf((e as { slot: unknown }).slot), owed[0], where);
        } else {
          agree(e, "ambiguous", where);
        }
      }
    }
    // The generator must actually reach each branch, or the guard proves nothing.
    expect(cases).toBeGreaterThan(100_000);
    expect(resolved).toBeGreaterThan(20_000);
    expect(divergent).toBeGreaterThan(500);
  });
});
