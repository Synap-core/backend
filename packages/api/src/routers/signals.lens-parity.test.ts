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

  for (const door of ["owed", "list"] as const) {
    it(`${door} passes floorLens(input.workspaceId), never the raw lens`, () => {
      const blocks = callBlocks(door);
      // Guards against the scan passing vacuously if the call is renamed away.
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain("floorLens(input.workspaceId)");
        expect(block).not.toContain("workspaceId: input.workspaceId");
      }
    });
  }

  it("both procedures fetch the owed half at all", () => {
    // `list` and `count` must answer over ONE population. A count that skipped
    // the owed door would render a badge smaller than the rows beneath it.
    expect(callBlocks("owed")).toHaveLength(2);
  });
});
