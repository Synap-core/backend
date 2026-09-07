/**
 * CROSS-PACKAGE PARITY: the executor knows every `reference` mode the wire
 * contract can store.
 *
 * `REFERENCE_MODES` is declared in `packages/api/src/routers/automations.ts` and
 * cannot be imported here — `@synap/jobs` does not depend on `@synap/api` (jobs
 * is imported BY api, never the reverse). So `RESOLVABLE_REFERENCE_MODES` in
 * `steps/reference-param.ts` is a mirror, and a mirror rots: adding a third mode
 * to the SSOT would leave the executor throwing "unknown reference mode" on a
 * value the API happily stores and the rule builder happily authors.
 *
 * A source scan is the same device `action-option-parity.test.ts` (synap-app)
 * uses for the client mirror of this very vocabulary.
 *
 * ⚠️ The mapping check alone is not enough — a mode can be LISTED and still fall
 * through to the unknown-mode branch. The second test drives the resolver with
 * each mode and asserts it is HANDLED (accepted, or refused for a reason
 * specific to that mode), never rejected as unknown. That is the forwarding
 * check, and it is the one that would survive someone editing the list alone.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOLVABLE_REFERENCE_MODES,
  resolveReferenceParam,
} from "../steps/reference-param.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SSOT = path.resolve(
  __dirname,
  "../../../../api/src/routers/automations.ts"
);

describe("reference modes stay in lockstep with the API contract", () => {
  it("the SSOT is where we think it is", () => {
    // A parity test whose corpus silently vanished is green and guards nothing.
    expect(fs.existsSync(SSOT), `SSOT not found at ${SSOT}`).toBe(true);
  });

  it("the executor mirrors REFERENCE_MODES exactly", () => {
    const src = fs.readFileSync(SSOT, "utf8");
    const match = src.match(/export const REFERENCE_MODES = \[([^\]]*)\]/);
    expect(
      match,
      "`export const REFERENCE_MODES = [...]` no longer parses out of " +
        "routers/automations.ts — the mirror in steps/reference-param.ts is " +
        "now unguarded. Fix the scan, do not delete it."
    ).toBeTruthy();
    const ssotModes = [...(match as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(ssotModes.length).toBeGreaterThan(0);
    expect(
      [...RESOLVABLE_REFERENCE_MODES].sort(),
      "The automation executor does not know every mode the API can store. A " +
        "mode it does not know throws `unknown reference mode` at fire time, " +
        "on a rule that saved green."
    ).toEqual(ssotModes);
  });

  it("every listed mode is actually BRANCHED ON, not merely listed", () => {
    for (const mode of RESOLVABLE_REFERENCE_MODES) {
      // A minimally-populated value for each mode; `bound` needs a target,
      // `ask` needs nothing. Either outcome is fine — resolving, or refusing
      // for a mode-specific reason. What must never happen is the fall-through.
      const err = (() => {
        try {
          resolveReferenceParam(
            { mode, refKind: "entity", value: [{ id: "id-1" }] },
            "test.param"
          );
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(
        err?.message ?? "",
        `mode "${mode}" fell through to the unknown-mode branch — it is in the ` +
          "list but nothing handles it."
      ).not.toMatch(/unknown reference mode/);
    }
  });
});
