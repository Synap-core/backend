import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { deriveBuiltinVerbParamsSchema } from "../services/capabilities/capability-registry.js";
import { BUILTIN_VERB_PARAM_SCHEMAS } from "../services/capabilities/builtin-verbs.js";
import { paramsFromVerbSchema } from "../routers/automations.js";

/**
 * PROJECTION PARITY: every field the deriver produces must reach the wire.
 *
 * `deriveBuiltinVerbParamsSchema` walks the execution-time Zod schema and
 * produces `{required, description, type, options}`. `paramsFromVerbSchema`
 * projects that onto `ActionOption["params"]`, which is a PINNED CONTRACT
 * — and it used to build `{key, label, required}`, silently dropping the
 * `description` the deriver had already captured. There was no `type` to drop
 * because nobody read it, even though it sat in the shape being walked.
 *
 * ⚠️ Scope, MEASURED (an earlier version of this header named examples it had
 * not checked): 100 top-level params across the 30 builtin schemas — 80 string,
 * 9 record, 4 enum, 3 number (all `z.coerce`), 3 array, 1 union, and ZERO
 * boolean, ZERO date. `profileSlug` is `z.string()`. So the typed projection
 * buys the 4 enums and 3 numbers; the rest degrade honestly to text.
 *
 * A projection narrower than its producer is this codebase's most repeated
 * defect (the `PROJECTED_SKILL_FIELDS` parity tripwire exists for the same
 * reason on the skills side). This test derives the expected key set FROM THE
 * PRODUCER rather than listing it, so adding a field to the deriver and
 * forgetting the projection fails here instead of reaching zero surfaces.
 */
describe("action param projection carries everything the deriver produces", () => {
  const verbIds = Object.keys(BUILTIN_VERB_PARAM_SCHEMAS);

  it("has builtin verbs to scan", () => {
    // A parity test over an empty corpus is green and guards nothing.
    expect(verbIds.length).toBeGreaterThan(0);
  });

  it("no field produced by the deriver is dropped by the projection", () => {
    const dropped = new Set<string>();
    let sawAny = false;

    for (const verbId of verbIds) {
      const derived = deriveBuiltinVerbParamsSchema(verbId);
      if (!derived) continue;
      const projected = paramsFromVerbSchema(derived);

      for (const [key, spec] of Object.entries(derived)) {
        const row = projected.find((p) => p.key === key);
        expect(
          row,
          `${verbId}.${key} vanished from the projection`
        ).toBeTruthy();
        sawAny = true;
        for (const field of Object.keys(spec)) {
          const value = (spec as Record<string, unknown>)[field];
          // Only an actually-produced value can be dropped; `undefined` means
          // the deriver had nothing to say, which the wire omits on purpose.
          if (value === undefined) continue;
          if (!(field in (row as Record<string, unknown>))) {
            dropped.add(field);
          }
        }
      }
    }

    expect(sawAny, "no params were compared — the scan matched nothing").toBe(
      true
    );
    expect(
      [...dropped],
      "These fields are produced by `deriveBuiltinVerbParamsSchema` and never " +
        'reach `ActionOption["params"]`. A client cannot render what the wire ' +
        "does not carry — add them to `actionOptionSchema.params` and to " +
        "`paramsFromVerbSchema`, and mirror into `automation-intent`."
    ).toEqual([]);
  });

  it("forwards every field the CONTRACT declares, not just the ones the corpus happens to use", () => {
    // ⚠️ The test above derives its field set from the CORPUS, so it can only
    // ever catch a field some builtin verb already emits. When `reference`
    // landed, no builtin verb declared one — so `refKind`/`refCardinality` were
    // dropped by this very projection and the corpus-derived guard beside it
    // stayed green. That is the "a corpus tripwire proves the CORPUS, not the
    // contract" trap, and it cost this wave a silent re-run of the defect the
    // file exists to prevent.
    //
    // This assertion feeds a SYNTHETIC spec carrying every field the wire
    // declares, so the guard tracks the CONTRACT and fires the day a field is
    // added to `actionOptionSchema.params` without being forwarded here —
    // years before any verb happens to use it.
    const fullSpec = {
      probe: {
        required: true,
        description: "a description",
        type: "reference",
        refKind: "entity",
        refCardinality: "single",
        options: undefined,
      },
    };
    const [row] = paramsFromVerbSchema(fullSpec);
    expect(row, "the synthetic spec produced no row").toBeTruthy();

    const declared = Object.entries(fullSpec.probe)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    const dropped = declared.filter((f) => !(f in (row as object)));
    expect(
      dropped,
      "Declared on the wire, produced by the spec, and NOT forwarded by " +
        "`paramsFromVerbSchema`. Half-forwarding a reference is worse than " +
        "dropping it whole: `actionOptionSchema` refuses a reference with no " +
        "kind, so the entire action list fails to parse and the composer " +
        "renders no actions at all.\n" +
        dropped.join(", ")
    ).toEqual([]);
  });

  it("actually types the params users fill, not just the easy ones", () => {
    // A parity test can pass while the deriver types NOTHING (it would produce
    // no `type` field to drop). Assert the capability is real, on the params
    // that were the visible defect.
    const typed: string[] = [];
    let withOptions = 0;
    for (const verbId of verbIds) {
      const derived = deriveBuiltinVerbParamsSchema(verbId);
      if (!derived) continue;
      for (const spec of Object.values(derived)) {
        if (spec.type) typed.push(spec.type);
        if (spec.type === "enum" && (spec.options?.length ?? 0) > 0)
          withOptions++;
      }
    }
    // ⚠️ `typed.length > 0` was satisfiable by the 80 plain strings alone —
    // deleting every row but `string` from `ZOD_TAG_TO_PARAM_TYPE` left it
    // green at 87, while every picker and numeric keyboard silently
    // disappeared. Assert the types that actually CHANGE a control.
    expect(
      typed.filter((t) => t === "enum").length,
      "no param resolved to `enum` — the pickers are gone (4 exist in the corpus)"
    ).toBeGreaterThan(0);
    expect(
      typed.filter((t) => t === "number").length,
      "no param resolved to `number` — the numeric keyboards are gone (3 exist)"
    ).toBeGreaterThan(0);
    expect(
      withOptions,
      "an enum reached the wire with no `options` — a picker with no choices"
    ).toBeGreaterThan(0);
  });
});

/**
 * The SECOND producer/projection pair — the one the test above cannot see.
 *
 * `action-param-projection-parity` iterates `BUILTIN_VERB_PARAM_SCHEMAS`, so
 * `playbookActionOptions` had no coverage at all and quietly dropped `type` and
 * `options` for months. That is the more damaging instance: `PlaybookParam.type`
 * is REQUIRED in the authoring contract, and playbook params are the only ones
 * that actually carry `boolean` and `choice` — the builtin corpus has zero
 * booleans, so a green builtin parity test was actively misleading about
 * whether typed controls worked.
 *
 * A parity test proves the pair it iterates and NOTHING ELSE. When a second
 * producer appears, it needs its own pairing here or the guard's green means
 * less than it looks.
 */
describe("playbook param projection carries the authored type", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../routers/automations.ts"),
    "utf8"
  );

  it("maps every PlaybookParamType that has a control, and omits the one that does not", () => {
    // Derived from the authoring contract's own union, not a copy of it.
    const contract = fs.readFileSync(
      path.resolve(__dirname, "../../../playbooks/src/index.ts"),
      "utf8"
    );
    const union = /export type PlaybookParamType =\s*([^;]+);/.exec(contract);
    expect(union, "PlaybookParamType moved — re-derive this test").toBeTruthy();
    const members = [...union![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(members.sort()).toEqual(
      ["boolean", "choice", "entity", "number", "text"].sort()
    );

    // ⚠️ Only the UNION DERIVATION is asserted here, deliberately.
    //
    // This block also source-scanned for `spec.type === "text"` and friends,
    // plus the shape of the spread. Those were BRITTLE without being stronger:
    // refactoring the if-chain into a lookup object (`{ text: "string", … }`)
    // — a perfectly good cleanup — turns them all red on byte-identical
    // behaviour, and a guard that cries wolf on a legitimate refactor gets
    // deleted rather than heeded.
    //
    // They were also redundant. `automations.playbook-then.test.ts` covers the
    // same ground BEHAVIOURALLY, on a pure exported function: it pins the
    // `choice → enum` mapping WITH its options, the boolean passthrough, and
    // the deliberate `entity` omission. A behavioural test beats a regex
    // whenever one is possible, and here one is.
    //
    // What a behavioural test CANNOT do is notice the authoring contract
    // growing a SIXTH member: nothing would fail, and the new type would
    // silently degrade to a text box. That is the only thing left here.
    for (const member of members) {
      if (member === "entity") continue; // deliberately unmapped — no control
      expect(
        new RegExp(`spec\\.type === "${member}"`).test(source),
        `PlaybookParamType "${member}" is not handled by playbookActionOptions. ` +
          "Map it, or — if no control exists — omit it deliberately the way " +
          "`entity` is, and say so here."
      ).toBe(true);
    }
  });
});
