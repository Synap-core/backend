/**
 * TRIPWIRE — the renderer `slot` / `scope` wire enums must be DERIVED, never
 * hand-mirrored.
 *
 * THE DEFECT THIS EXISTS FOR. The backend has had FOUR renderer slots since
 * `entity-card` landed (`RENDERER_SLOTS`, `PROFILE_CONTENT_KIND_TO_SLOT`), but
 * the two external doors each hand-wrote `["list", "detail", "dashboard"]` —
 * three members. `card` was therefore unreachable from the Hub route and from
 * MCP `synap_promote_cell_to_renderer`: not an error, just a slot no external
 * caller could ever name. Same class as the hand-mirrored status enums that let
 * a deployed expiry job expire nothing while the tests pinned the same lie, and
 * the reason the vocabulary rule says NEVER hand-write a second table.
 *
 * Reading the SOURCE rather than importing the modules is deliberate. Importing
 * `hub-protocol/profiles.ts` proves the enum's VALUES agree today; it cannot
 * prove they agree because one is derived from the other, so a future literal
 * that happens to match would pass and then drift on the next slot. The scan
 * asserts the DERIVATION.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  RENDERER_SCOPES,
  RENDERER_SLOTS,
} from "../services/profiles/renderer-slots.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, "..", rel), "utf8");

/**
 * Literal arrays sitting where a `slot:` or `scope:` enum is declared — a
 * Zod `z.enum([...])` or a JSON-schema `enum: [...]`. Deliberately position-
 * anchored rather than "any string array in the file": a bare
 * `["pod", "workspace"]` elsewhere in these routers is an unrelated
 * entity-scope vocabulary, and flagging it would make the tripwire noise
 * someone silences instead of a floor someone trusts.
 */
function handListedEnums(source: string): string[][] {
  const out: string[][] = [];
  const re = /\b(?:slot|scope)\s*:\s*(?:z\.enum\(|)\[((?:\s*"[^"]*"\s*,?)+)\]/g;
  for (const m of source.matchAll(re)) {
    out.push([...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  }
  return out;
}

describe("renderer slot/scope enum parity", () => {
  it("keeps `card` in the ONE constant (the member the wire doors were missing)", () => {
    expect([...RENDERER_SLOTS]).toEqual([
      "list",
      "detail",
      "card",
      "dashboard",
    ]);
    expect([...RENDERER_SCOPES]).toEqual(["workspace", "pod", "user"]);
  });

  it("the Hub setRenderer route derives both enums instead of listing members", () => {
    const source = src("routers/hub-protocol/profiles.ts");
    expect(source).toContain("slot: z.enum(RENDERER_SLOTS)");
    expect(source).toContain("scope: z.enum(RENDERER_SCOPES)");
  });

  it("the tRPC override route derives the scope enum", () => {
    const source = src("routers/profiles.ts");
    expect(source).toContain("scope: z.enum(RENDERER_SCOPES)");
  });

  it("no clean wire door re-lists the slot or scope members as a literal", () => {
    for (const rel of [
      "routers/hub-protocol/profiles.ts",
      "routers/profiles.ts",
    ]) {
      expect(
        handListedEnums(src(rel)),
        `${rel} hand-lists renderer enum members instead of spreading the constant`
      ).toEqual([]);
    }
  });

  /**
   * HELD BY A CONCURRENT SESSION — the MCP tool schema could not be edited in
   * this wave (`packages/api/src/routers/mcp/tools/index.ts` was dirty in the
   * shared working tree). Its `slot` enum is still the 3-member literal, so
   * `card` remains unreachable from MCP alone.
   *
   * This is HONEST UNDER-CONVERGENCE, not a stamp: nothing claims MCP converged,
   * and this test PINS the exact literal that is there — so if anyone edits it
   * to anything other than the derived form, the pin fails and they are sent to
   * the real fix. The required diff, verbatim:
   *
   *   -              enum: ["list", "detail", "dashboard"],
   *   +              enum: [...RENDERER_SLOTS],
   *   -              enum: ["workspace", "pod"],
   *   +              enum: [...RENDERER_SCOPES],
   *
   * plus `import { RENDERER_SCOPES, RENDERER_SLOTS } from
   * "../../../services/profiles/renderer-slots.js";`, and widening
   * `build.ts`'s cast from `"list" | "detail" | "dashboard"` to `RendererSlot`.
   * Delete this test and add the file to the derived-doors list above once done.
   */
  it("MCP tool schema is a KNOWN un-derived door (pinned, not certified)", () => {
    const source = src("routers/mcp/tools/index.ts");
    const derived = source.includes("enum: [...RENDERER_SLOTS]");
    if (derived) return; // Someone did the real fix — retire this test.
    expect(
      source,
      "MCP slot enum changed without being derived — apply the diff in this test's docblock"
    ).toContain('enum: ["list", "detail", "dashboard"]');
  });
});
