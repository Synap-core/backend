/**
 * Every key in an install-time merge baseline must be writable by the UPDATE
 * door the reconcile replays it through.
 *
 * `reconcileStandaloneConfigsToTemplates` builds its `desired` set from EXACTLY
 * `Object.keys(source.baseline)` and hands it to `<kind>Router.update`. tRPC zod
 * objects STRIP unknown keys, and the reconcile casts the payload with
 * `as Parameters<…>[0]`, so a baseline key the update input does not declare is
 * dropped in silence and tsc stays green. The merge still marks the field
 * applied, `nextBaseline` advances, and the metadata persists — so the row never
 * changed while the report says `updated: [<key>]`. On the next pass
 * `live !== base`, the field is classified OWNER-OWNED, and it can never
 * converge again. That is a DURABLE LIE, not a missed update.
 *
 * This shipped once already: the skill baseline carried `providerSpec` while
 * `skillsRouter.update` did not accept it.
 *
 * BOTH sides are DERIVED — the baseline literal is parsed out of the applier's
 * own source, the accepted keys are read off the live zod shape of the router
 * procedure — so a hand-listed pin can never drift from the code it pins. Same
 * idiom as `capability-drift.projection-parity.tripwire.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const applierSrc = readFileSync(join(here, "marketplace-install.ts"), "utf8");

const WHY_IT_MATTERS =
  "A baseline key the update door cannot write is stripped by zod, yet the " +
  "3-way merge advances the stored baseline as if it had been applied. The row " +
  "is unchanged, the report claims it was updated, and every later pass sees " +
  "live !== base and classifies the field as user-edited — permanently. Either " +
  "add the field to that router's `update` input (and to RE_APPROVAL_FIELDS if " +
  "it is execution-defining), or drop it from the install baseline.";

/**
 * The keys of the object literal `marketplace-install.ts` stamps as the merge
 * baseline for one install kind — read out of its own `buildMarketSource(...)`
 * argument rather than re-listed here.
 */
function baselineKeysFor(kind: "skill" | "view" | "automation"): string[] {
  const caseAt = applierSrc.indexOf(`case "${kind}": {`);
  expect(caseAt, `case "${kind}" block not found`).toBeGreaterThan(-1);
  const call = /buildMarketSource\((\w+),/.exec(applierSrc.slice(caseAt));
  expect(call, `no buildMarketSource(...) call in case "${kind}"`).toBeTruthy();
  const varName = call![1];
  const declAt = applierSrc.lastIndexOf(
    `const ${varName} = {`,
    caseAt + call!.index
  );
  expect(
    declAt,
    `baseline literal \`const ${varName} = {\` not found for "${kind}"`
  ).toBeGreaterThan(caseAt);

  const keys: string[] = [];
  let depth = 0;
  for (const line of applierSrc.slice(declAt).split("\n")) {
    const before = depth;
    // A line at depth 1 that opens with `key:` or a shorthand `key,` is a
    // top-level baseline field; a wrapped value continuation (`entry?.name ??`,
    // `input.slug,`) never matches because of the `.`/`?`.
    if (before === 1) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s*[:,]/.exec(line);
      if (m) keys.push(m[1]);
    }
    depth += (line.match(/[{[]/g) ?? []).length;
    depth -= (line.match(/[}\]]/g) ?? []).length;
    if (before > 0 && depth === 0) break;
  }
  return keys;
}

/** The keys the router's `update` procedure actually accepts (live zod shape). */
async function updateInputKeys(
  kind: "skill" | "view" | "automation"
): Promise<string[]> {
  const router = {
    skill: async () => (await import("../../routers/skills.js")).skillsRouter,
    view: async () => (await import("../../routers/views.js")).viewsRouter,
    automation: async () =>
      (await import("../../routers/automations.js")).automationsRouter,
  }[kind];
  const proc = (
    (await router()) as unknown as {
      _def: {
        procedures: Record<
          string,
          { _def: { inputs: Array<{ shape?: Record<string, unknown> }> } }
        >;
      };
    }
  )._def.procedures.update;
  expect(proc, `${kind} router has no \`update\` procedure`).toBeTruthy();
  const shape = proc._def.inputs?.[0]?.shape;
  expect(
    shape,
    `could not read the zod shape off ${kind}Router.update — the extraction is ` +
      `broken, not the code under test`
  ).toBeTruthy();
  return Object.keys(shape!);
}

describe("install baseline ⊆ update-door write-set", () => {
  for (const kind of ["skill", "view", "automation"] as const) {
    it(`every ${kind} baseline key is writable by ${kind}Router.update`, async () => {
      const baseline = baselineKeysFor(kind);
      // Guard against a vacuous pass: a broken source extraction yields an empty
      // set, and every subset assertion below then succeeds on nothing.
      expect(
        baseline.length,
        `extracted no baseline keys for "${kind}" — the extraction is broken, ` +
          `not the code under test`
      ).toBeGreaterThanOrEqual(4);
      const accepted = await updateInputKeys(kind);
      expect(accepted.length).toBeGreaterThanOrEqual(4);

      const unwritable = baseline.filter((k) => !accepted.includes(k));
      expect(
        unwritable,
        `the ${kind} install baseline carries ${JSON.stringify(unwritable)}, ` +
          `which ${kind}Router.update does not accept. ${WHY_IT_MATTERS}`
      ).toEqual([]);
    });
  }

  it("pins the baseline SIZE per kind so widening one is a deliberate edit", () => {
    expect(baselineKeysFor("skill").length).toBe(12);
    expect(baselineKeysFor("view").length).toBe(4);
    expect(baselineKeysFor("automation").length).toBe(5);
  });
});
