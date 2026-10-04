/**
 * LENS-PARITY TRIPWIRE for the needs-you union.
 *
 * `proposals.groups` reads an ABSENT `workspaceId` as the full user floor.
 * Every other half of this union resolves its scope through `resolveScope`,
 * which falls back to the ACTIVE-WORKSPACE HEADER when the field is absent. Mix
 * the two and one half of one number narrows to whatever workspace the client
 * last activated while the others stay pod-wide — the tray then says "nothing
 * needs you" with work waiting one lens over.
 *
 * That has shipped broken twice: once for notifications, and it would have
 * shipped a third time for owed slots. `floorLens` is the fix, and the two
 * assertions below pin BOTH halves of it:
 *
 *   1. the translation itself (a unit test — pure, no DB), and
 *   2. that the owed call in each procedure actually goes through it. A source
 *      scan, because the defect lives in the SEAM between the helper and its
 *      call site: `floorLens` is individually correct with the bug present, and
 *      a behavioural test of the router needs a database this suite does not
 *      have.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { floorLens } from "./signals.js";

describe("floorLens", () => {
  it("translates ABSENT into the explicit floor, not the header default", () => {
    // `[]` is `resolveScope`'s "widen to the floor" value; `undefined` would
    // let the active-workspace header narrow the half silently.
    expect(floorLens(undefined)).toEqual([]);
  });

  it("passes an explicit lens through untouched", () => {
    expect(floorLens("ws-1")).toBe("ws-1");
    // `null` is pod-personal/globals only — a real lens, not an absence.
    expect(floorLens(null)).toBeNull();
  });
});

describe("every resolveScope-backed half of the union speaks the same lens", () => {
  const src = readFileSync(join(__dirname, "signals.ts"), "utf8");

  /** Each `…createCaller(ctx).<door>({ … })` argument block in the file. */
  function callBlocks(door: string): string[] {
    const blocks: string[] = [];
    const marker = `createCaller(ctx).${door}({`;
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at === -1) break;
      // Walk to the matching brace so the block cannot swallow a later call.
      let depth = 0;
      let i = at + marker.length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      blocks.push(src.slice(at, i + 1));
      from = i;
    }
    return blocks;
  }

  /** Each `<marker>…)` argument block, walked to the matching brace. */
  function blocksAt(marker: string): string[] {
    const blocks: string[] = [];
    let from = 0;
    for (;;) {
      const at = src.indexOf(marker, from);
      if (at === -1) break;
      let depth = 0;
      let i = at + marker.length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) break;
      }
      blocks.push(src.slice(at, i + 1));
      from = i;
    }
    return blocks;
  }

  // Every half whose door resolves scope through `resolveScope`: the
  // notification door (`notifCenter.list`) and the owed/draft reads (built on
  // ONE `resolveScope(ctx, …)` scope object, `owedScope`).
  const halves: Array<[string, string[]]> = [
    ["notifCenter.list", callBlocks("list")],
    ["resolveScope (owed + drafts)", blocksAt("resolveScope(ctx, {")],
  ];
  for (const [name, blocks] of halves) {
    it(`${name} passes floorLens(input.workspaceId), never the raw lens`, () => {
      // Guards against the scan passing vacuously if the call is renamed away.
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain("floorLens(input.workspaceId)");
        expect(block).not.toContain("workspaceId: input.workspaceId");
      }
    });
  }

  it("the owed and draft reads both take that ONE scope object", () => {
    expect(src.match(/listOwedSlots\(\{\s*\.\.\.owedScope/g)).toHaveLength(1);
    expect(src.match(/listDraftAskSlots\(owedScope\)/g)).toHaveLength(1);
    // Nowhere else may the owed read be called with a scope of its own.
    expect(src.match(/listOwedSlots\(/g)).toHaveLength(1);
  });

  it("list and count read through ONE reader, so they answer over one population", () => {
    // `count` (via countSignals), the needs-you/proposed/suggestions lenses and
    // the page all call `readAttention` — no second assembly of the halves.
    const body = src.slice(src.indexOf("export const signalsRouter"));
    expect(src).toMatch(/async function countSignals[\s\S]*?readAttention\(/);
    expect(body.match(/readAttention\(/g)?.length ?? 0).toBeGreaterThanOrEqual(
      1
    );
    expect(src.match(/createCaller\(ctx\)\.groups\(/g)).toHaveLength(1);
  });
});
