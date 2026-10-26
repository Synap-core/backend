/**
 * TRIPWIRE — the console draws an ask ONLY through `askCardView`
 * (`@synap-core/types/ask`; Resolve-XP W6a, founder 2026-10-26).
 *
 * The defect: Review drew the slot's label as the heading, its `why` under it
 * and the confirm's prompt again above Yes / No — the same sentence three
 * times — because each renderer read the raw fields itself. The card's one
 * derivation strips the machine verb prefix, drops a `why` that restates the
 * question and names the asker; a renderer that reads `label` / `why` /
 * `prompt` again re-opens all of it.
 *
 * SCANNED SET, derived: every non-test source file under `app/` that imports
 * the ask view model (`ask-detail`) or its renderer (`ask-answer`) — a new
 * host joins by existing. `ask-detail.ts` is the console's door INTO the
 * derivation (it hands the raw fields to `askCardView`), so it is checked
 * behaviourally instead: the view it returns carries no raw field.
 *
 * WHAT IT DOES NOT SEE, stated: a read through an alias (`const s = slot;
 * s.why`) or a computed key. It catches the shapes this file shipped with
 * (`{view.why}`, `prompt !== slot.label`, `{seen.label}`) and their kin.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { askView, type AskSlot } from "../app/(admin)/review/_lib/ask-detail";

const APP = fileURLToPath(new URL("../app", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Comments out: prose about `why` is not a read of it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const IMPORTS_ASK = /from\s+"[^"]*\/(?:ask-detail|ask-answer)"/;

/**
 * A raw read for DISPLAY: any `.why` / `.prompt` member, or the slot's own
 * `.label` — except as the slot's identity: in a call (`expectedLabel:`), a
 * React `key`, or the ask detail's own address (`{ kind: "ask", …, label }`,
 * what `liveAskSlot` matches on). None of those is drawn.
 */
function rawReads(src: string): string[] {
  const hits: string[] = [];
  for (const line of code(src).split("\n")) {
    if (/\.(?:why|prompt)\b/.test(line)) hits.push(line.trim());
    else if (
      /\b(?:slot|seen|live)\??\.label\b/.test(line) &&
      !/expectedLabel:\s*\w+\??\.label\b/.test(line) &&
      !/\bkey=\{/.test(line) &&
      !/\bkind:\s*"ask",\s*sessionId:/.test(line)
    )
      hits.push(line.trim());
  }
  return hits;
}

const SCANNED = sources(APP)
  .filter((f) => !f.endsWith("ask-detail.ts"))
  .filter((f) => IMPORTS_ASK.test(readFileSync(f, "utf8")) || f.endsWith("ask-answer.tsx"));

describe("tripwire: the console draws an ask only through askCardView", () => {
  it("NON-VACUITY: the scan finds the renderer and its hosts", () => {
    const names = SCANNED.map((f) => relative(APP, f));
    expect(names.some((n) => n.endsWith("ask-answer.tsx"))).toBe(true);
    expect(names.some((n) => n.endsWith("review-rows.ts"))).toBe(true);
    expect(names.some((n) => n.endsWith("session-needs-you.tsx"))).toBe(true);
    expect(SCANNED.length).toBeGreaterThanOrEqual(4);
  });

  it("SELF-CHECK: the rule sees the shapes it hunts, and spares identity", () => {
    expect(rawReads("<p>{view.why}</p>")).toHaveLength(1);
    expect(rawReads("{prompt && prompt !== slot.label && <p/>}")).toHaveLength(1);
    expect(rawReads("<h3>{seen.label}</h3>")).toHaveLength(1);
    expect(rawReads("  expectedLabel: seen.label,")).toEqual([]);
    expect(
      rawReads('{ kind: "ask", sessionId: slot.sessionId, label: slot.label, slot }')
    ).toEqual([]);
    expect(rawReads("// the agent's why, in prose")).toEqual([]);
  });

  it.each(SCANNED.map((f) => [relative(APP, f), f]))(
    "%s reads no label / why / prompt for display",
    (_name, file) => {
      expect(rawReads(readFileSync(file, "utf8"))).toEqual([]);
    }
  );

  it("the view model hands renderers the card, never a raw field", () => {
    const slot: AskSlot = {
      sessionId: "s1",
      label: "Decide: Ship it",
      sessionTitle: null,
      ask: { mode: "confirm", prompt: "Accept: Ship it?" },
      why: "Ship it. Today.",
      claimedDone: false,
      blockedReason: "decision",
      owedSince: null,
      askerName: null,
      askCause: null,
    };
    const view = askView(slot);
    expect(view).not.toHaveProperty("why");
    expect(view.control).not.toHaveProperty("prompt");
    expect(view.heading).toBe("Ship it?");
    expect(JSON.stringify(view)).not.toMatch(/Decide:|Accept:/);
  });
});
