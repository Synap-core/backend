/**
 * `requiredIntents` — a playbook declares what the pod must be able to DO.
 *
 * Three seams, each of which fails a different way:
 *
 *   1. THE READER — a stored jsonb bag read tolerantly. The failure it exists
 *      to prevent is a reader that turns "malformed" into "declares nothing",
 *      which then reports every playbook as fully satisfied.
 *   2. THE MATCHER — a declaration plus a RESOLVER index becomes per-intent
 *      verdicts. The failure here is a subset gate: rejecting a playbook for
 *      declaring an intent nothing serves yet is what `taskIntents` already had
 *      to be corrected for, so it is asserted as the CORRECT behaviour.
 *   3. THE MERGE — an overlay composition unions rather than narrows. The
 *      failure is an overlay silently stripping a real dependency off a shared
 *      method.
 *
 * WHAT IT PROVES: the reader is total, the matcher reports rather than gates,
 * and the merge is additive.
 *
 * WHAT IT DOES NOT PROVE: that the supplied index is the RIGHT index. The
 * matcher is handed an opaque `Map` — it cannot know that the ids came from
 * `intentIndex(ctx)` rather than being typed in by a test, so nothing here
 * validates the resolver itself, nor that a requirement is satisfiable at all
 * (only that it is currently backed). A vocabulary check is likewise absent by
 * design: this package holds no vocabulary, so membership is the write door's
 * rule (`@synap/api` `schemas/playbook-definition.ts`, where `taskIntents`
 * also checks it).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_REQUIRED_INTENTS,
  REQUIRED_INTENTS_FIELD,
  composePlaybookDef,
  matchRequiredIntents,
  mergeRequiredIntents,
  readRequiredIntents,
  type LoopPlaybookDef,
} from "./index.js";

describe("requiredIntents — the reader is total, never silently empty", () => {
  it("non-vacuity: the field name is the one the whole package agrees on", () => {
    // The name is the one thing a reader and a writer can silently disagree
    // about: a reader looking for a different key reads [] forever and reports
    // every playbook as satisfied. So pin the string, and prove the reader is
    // actually keying on THAT string rather than on a literal of its own.
    expect(REQUIRED_INTENTS_FIELD).toBe("requiredIntents");
    expect(
      readRequiredIntents({ [REQUIRED_INTENTS_FIELD]: ["send_message"] })
    ).toEqual(["send_message"]);
    // And a bag under a DIFFERENT key reads as nothing — the negative control
    // for the assertion above, which would also pass on a reader that ignored
    // its input entirely.
    expect(readRequiredIntents({ intents: ["send_message"] })).toEqual([]);
  });

  it("reads a legacy playbook, and any non-array, as declaring nothing", () => {
    // A playbook stored before this field existed has no key at all; it must
    // RESOLVE, not throw, or every reader over old rows breaks.
    for (const bag of [
      undefined,
      null,
      {},
      { requiredIntents: undefined },
      { requiredIntents: null },
      { requiredIntents: "send_message" },
      { requiredIntents: { intent: "send_message" } },
      { requiredIntents: 42 },
    ]) {
      expect(readRequiredIntents(bag)).toEqual([]);
    }
  });

  it("drops malformed entries but keeps every real one alongside them", () => {
    // The load-bearing case: a bag that is PARTLY bad must not collapse to [].
    // That collapse is the "an empty result and a failed read are different
    // facts" defect — a reader cannot tell "declared nothing" from "declares
    // junk I dropped", and a caller guessing "empty" reports a satisfied
    // playbook that actually depends on something.
    expect(
      readRequiredIntents({
        requiredIntents: [
          "send_message",
          42,
          null,
          "",
          "   ",
          { intent: "generate_media" },
          ["nested"],
          "generate_media",
          "send_message", // duplicate — a requirement is a SET
        ],
      })
    ).toEqual(["send_message", "generate_media"]);
  });

  it("trims, and caps at MAX_REQUIRED_INTENTS (the doors refuse more)", () => {
    expect(
      readRequiredIntents({ requiredIntents: ["  send_message  "] })
    ).toEqual(["send_message"]);
    const many = Array.from(
      { length: MAX_REQUIRED_INTENTS + 5 },
      (_, i) => `intent_${i}`
    );
    const read = readRequiredIntents({ requiredIntents: many });
    expect(read).toHaveLength(MAX_REQUIRED_INTENTS);
    // Truncation takes the FIRST n, so a cap can never silently drop the head.
    expect(read[0]).toBe("intent_0");
  });
});

describe("requiredIntents — a gap is a FACT, never a rejection", () => {
  // This describe is the founder's requirement made executable: "the AI want
  // something, it does not even need to think about the capability, it just
  // specify the intent and use the capability based on that". A playbook
  // declares an intent; whether anything serves it is a RUNTIME answer.
  //
  // An earlier draft of the sibling `taskIntents` field gated
  // `declared ⊆ provided` as a hard failure and went red on Content Studio's
  // own reference declaration. The assertion below is the anti-pattern's
  // opposite, pinned so a future "tightening" has to argue with it.

  it("reports an intent nothing serves as unsatisfied WITHOUT rejecting it", () => {
    const provided = new Map<string, readonly string[]>([
      ["send_message", ["gmail_send"]],
    ]);
    const report = matchRequiredIntents(
      ["send_message", "generate_media"],
      provided
    );
    // The served one is satisfied, naming its concrete provider.
    expect(report.requirements[0]).toEqual({
      intent: "send_message",
      status: "satisfied",
      providers: ["gmail_send"],
    });
    // The unserved one is a REPORTED GAP with an EMPTY provider list — a real
    // answer ("nothing installed serves this"), never a placeholder, and never
    // a thrown error or a filtered-out requirement.
    expect(report.requirements[1]).toEqual({
      intent: "generate_media",
      status: "unsatisfied",
      providers: [],
    });
    expect(report.gaps).toEqual(["generate_media"]);
    expect(report.satisfied).toBe(false);
    // Both requirements survive — a matcher that dropped the unsatisfiable one
    // would let a caller believe the playbook needs nothing it cannot do.
    expect(report.requirements).toHaveLength(2);
  });

  it("is fully satisfied when an intent has several providers", () => {
    const report = matchRequiredIntents(
      ["send_message"],
      new Map([["send_message", ["gmail_send", "unipile_send_message"]]])
    );
    expect(report.satisfied).toBe(true);
    expect(report.gaps).toEqual([]);
    // Providers are reported verbatim — the matcher never picks a winner, which
    // is the resolver's call and a governance question above it.
    expect(report.requirements[0].providers).toEqual([
      "gmail_send",
      "unipile_send_message",
    ]);
  });

  it("defaults to an empty index, and treats a playbook declaring nothing as satisfied", () => {
    // Both must be total: "I require nothing" and "nothing is installed" are
    // legitimate answers a run has to be able to report, not errors.
    expect(matchRequiredIntents(["send_message"]).requirements).toEqual([
      { intent: "send_message", status: "unsatisfied", providers: [] },
    ]);
    const none = matchRequiredIntents([]);
    expect(none).toEqual({ requirements: [], gaps: [], satisfied: true });
    expect(matchRequiredIntents([], new Map()).satisfied).toBe(true);
  });

  it("ignores index entries nobody declared (an intent is not a requirement)", () => {
    // The mirror image of over-reporting: the index is a pod-wide fact and the
    // declaration is this playbook's, so an intent served but undeclared must
    // not appear in the report at all.
    const report = matchRequiredIntents(
      ["send_message"],
      new Map([["publish_post", ["linkedin_post"]]])
    );
    expect(report.requirements).toHaveLength(1);
    expect(report.gaps).toEqual(["send_message"]);
  });
});

describe("requiredIntents — the seam to the resolver is a Map, and nothing more", () => {
  it("accepts the shape intentIndex() actually returns, after a verbId projection", () => {
    // This is the WHOLE of the seam, stated as a test so it cannot quietly
    // grow: the resolver returns `Map<intent, IntentVerbMatch[]>`; projecting
    // each list to its verbIds is a one-liner at the call site, and this
    // package therefore never imports — or duplicates — that index.
    //
    // Asserted with the resolver's real row shape (one per verb, plus a field
    // this package ignores) so a future change to IntentVerbMatch that broke
    // the projection would be visible here rather than at the call site.
    const resolverOutput = new Map<string, readonly unknown[]>([
      [
        "send_message",
        [
          {
            intent: "send_message",
            verbId: "gmail_send",
            verbLabel: "Send a message",
            verbKind: "write",
            granted: true,
            effectiveExecMode: "propose",
            backingSkillExecutable: true,
            capabilityId: "cap-1",
            capabilityName: "Gmail",
          },
        ],
      ],
    ]);
    const provided = new Map(
      [...resolverOutput].map(([intent, matches]) => [
        intent,
        (matches as ReadonlyArray<{ verbId: string }>).map((m) => m.verbId),
      ])
    );
    expect(matchRequiredIntents(["send_message"], provided).satisfied).toBe(
      true
    );

    // Non-vacuity: the projection is not a no-op that would satisfy everything.
    expect(matchRequiredIntents(["send_message"], new Map()).gaps).toEqual([
      "send_message",
    ]);
  });

  it("exposes no resolver import of its own (one index, not two)", () => {
    // The structural claim, asserted structurally. A source scan beats prose:
    // if this package ever grew its own capability lookup, the seam would be a
    // SECOND place deciding which capability serves an intent.
    //
    // ⚠️ COMMENTS ARE STRIPPED before matching. This file's own docblock NAMES
    // the resolver it deliberately does not import, so a naive scan is red
    // against the thing it polices — a prose mention is not a dependency. The
    // scan therefore reads CODE only, and its boundary is measured: it catches
    // a value or type IMPORT of the index (the realistic failure), and would
    // NOT catch a copy of its logic that never mentions its name.
    const src = readFileSync(
      new URL("./required-intents.ts", import.meta.url),
      "utf8"
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    expect(code).not.toMatch(/capability-intent-index/);
    // Nor may it hold a vocabulary of its own — the fifth mirror.
    expect(code).not.toMatch(/\bABSTRACT_INTENTS\b|\bREGISTERED_EXTRAS\b/);

    // Non-vacuity, both directions: the stripper really removed the prose that
    // named the resolver, and the scan can still see an import statement (a
    // self-check that it is not now blind).
    expect(src).toMatch(/capability-intent-index/);
    expect(code).not.toMatch(/capability-intent-index/);
    expect(
      'import { capabilitiesByIntent } from "./capability-intent-index.js";'
    ).toMatch(/capability-intent-index/);
  });

  it("holds NO intent vocabulary of its own — the deleted fourth mirror cannot come back", () => {
    // The guard for the 2026-10-01 collapse. `AbstractVerb` used to live in
    // this package's barrel as a TYPE-only mirror of the intent vocabulary.
    // It was stale (13 slugs, missing `publish_post`) AND had zero importers
    // repo-wide — so nothing could ever have noticed the staleness. Deleted.
    //
    // WHY A SCAN AND NOT A TYPE: the failure being prevented is a declaration
    // REAPPEARING. Nothing consumes it, so no typecheck anywhere fails when it
    // returns — only a scan of the emitted code catches it. The mirror would be
    // re-added as a union or a const, so both a `type` and a `const` binding
    // are policed, by BARE name.
    //
    // WHAT IT DOES NOT COVER, measured: it reads ONE file (this package's
    // barrel, `index.ts`), and it strips comments first — so a vocabulary
    // re-declared in a NEW sibling file under `src/` would pass. It also cannot
    // see a copy whose name differs from the three policed here. It is a
    // backstop on the exact name that was deleted, not a proof of absence.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    for (const name of [
      "AbstractVerb",
      "ABSTRACT_INTENTS",
      "REGISTERED_EXTRAS",
    ]) {
      // A DECLARATION, not any mention: `type X =` / `const X =` / `let X =`.
      expect(
        code,
        `${name} was re-declared in @synap/playbooks — the intent vocabulary is ` +
          `the pod's capability_intents TABLE. Add a MIGRATION + all three mirrors, ` +
          `never a fourth.`
      ).not.toMatch(new RegExp(`\\b(?:type|const|let|enum)\\s+${name}\\b`));
      // A bare IMPORT of any of the three, from anywhere in this file — the
      // other way a dependency on the vocabulary sneaks in.
      expect(code).not.toMatch(new RegExp(`import[^;]*\\b${name}\\b[^;]*from`));
    }

    // NON-VACUITY, both directions. (a) The stripper really removed the prose
    // that NAMES all three — the deletion note above discusses each by name, so
    // a scan that ran on raw source would be red against the very thing it
    // polices. (b) The scan can still see a declaration it hunts: prove it
    // against literal samples, in the same file, as the resolvers use.
    for (const name of [
      "AbstractVerb",
      "ABSTRACT_INTENTS",
      "REGISTERED_EXTRAS",
    ]) {
      expect(src, `${name} must be named in prose (the deletion note)`).toMatch(
        new RegExp(name)
      );
      expect(code).not.toMatch(new RegExp(name));
    }
    expect('export type AbstractVerb = "send_message";').toMatch(
      /type\s+AbstractVerb\b/
    );
    expect(
      'import { ABSTRACT_INTENTS } from "@synap/database/schema";'
    ).toMatch(/import[^;]*\bABSTRACT_INTENTS\b[^;]*from/);
  });
});

describe("requiredIntents — composition unions, never narrows", () => {
  const base: LoopPlaybookDef = {
    ref: "conversion-base",
    name: "Conversion Journey",
    goalTemplate: "Convert {{lead}}",
    requiredIntents: ["send_message", "fetch_record"],
  };

  it("an overlay adds requirements; it cannot remove the base's", () => {
    // The failure this prevents: a per-source overlay silently dropping a real
    // dependency off a shared method, so the flattened playbook looks runnable
    // when it is not. Declarations UNION, exactly like grants.
    const out = composePlaybookDef(base, {
      ref: "cold-outreach",
      name: "Cold Outreach",
      goalTemplate: "Cold-outreach {{lead}}",
      extends: "conversion-base",
      requiredIntents: ["search_external", "send_message"],
    });
    expect(out.requiredIntents).toEqual([
      "send_message",
      "fetch_record",
      "search_external",
    ]);
    // Base-first order, first-seen wins — stable, so a snapshot does not churn.
    expect(out.extends).toBeUndefined();
  });

  it("an overlay that declares nothing inherits the base's verbatim", () => {
    expect(
      composePlaybookDef(base, {
        ref: "plain",
        name: "Plain",
        goalTemplate: "g",
        extends: "conversion-base",
      }).requiredIntents
    ).toEqual(["send_message", "fetch_record"]);
  });

  it("mergeRequiredIntents: base-only, overlay-only, neither, malformed, capped", () => {
    expect(mergeRequiredIntents(["a", "b"], undefined)).toEqual(["a", "b"]);
    expect(mergeRequiredIntents(undefined, ["c"])).toEqual(["c"]);
    // Both absent ⇒ undefined, so a flattened hand-authored def (whose keys are
    // stripped when undefined) keeps matching one authored without the field.
    expect(mergeRequiredIntents(undefined, undefined)).toBeUndefined();
    expect(mergeRequiredIntents([], [])).toEqual([]);
    // Malformed entries on either side are dropped, never merged through.
    expect(mergeRequiredIntents(["a", 42, ""], ["b", null, {}])).toEqual([
      "a",
      "b",
    ]);
    const many = Array.from(
      { length: MAX_REQUIRED_INTENTS + 5 },
      (_, i) => `i${i}`
    );
    expect(mergeRequiredIntents(many, undefined)).toHaveLength(
      MAX_REQUIRED_INTENTS
    );
  });
});
