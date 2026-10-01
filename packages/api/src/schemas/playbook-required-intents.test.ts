/**
 * `requiredIntents` at the WRITE DOOR — the closed-vocabulary check.
 *
 * The field's contract has two halves that pull in opposite directions, and
 * this file is where they are both pinned:
 *
 *   1. MEMBERSHIP IS CLOSED. A slug outside the pod's `capability_intents`
 *      vocabulary is an authoring error, exactly like a template's
 *      `taskIntents` (`task-intent-unknown`). A typo here would install a
 *      requirement nothing can ever route.
 *   2. SATISFIABILITY IS NOT CHECKED. A slug nothing installed serves is a
 *      legal, expected declaration. This door must ACCEPT it.
 *
 * Half 2 is the load-bearing one. An earlier draft of the sibling `taskIntents`
 * gated `declared ⊆ provided` and went red on the founder's own Content Studio
 * declaration (4 intents, 1 pack covers 1). A future "tightening" of this
 * schema has to argue with the test below, which says it must not.
 *
 * WHAT IT PROVES: what the ONE door (every package / capability / loop door
 * `.extend`s `playbookDefinitionSchema`) accepts and refuses, driven through the
 * real parse rather than a hand-built expectation.
 *
 * WHAT IT DOES NOT PROVE: that the vocabulary itself is right — that is the
 * parity guard in `@synap-core/types/capability-intents`, which re-derives the
 * pod's seed migrations. Nor that a satisfied requirement routes: that is the
 * resolver's job (`capability-intent-index`), and a check here could not see it.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CAPABILITY_INTENTS,
  unknownIntents,
} from "@synap-core/types/capability-intents";
import { MAX_REQUIRED_INTENTS } from "@synap/playbooks";
import {
  playbookDefinitionSchema,
  playbookRequiredIntentsSchema,
} from "./playbook-definition.js";

/** A minimal VALID definition, so each assertion is about one field. */
const base = {
  name: "Outreach",
  goalTemplate: "Reach out to {{lead}}",
};

describe("requiredIntents — membership in the closed vocabulary", () => {
  it("non-vacuity: the scan sees a real vocabulary AND a real rejection", () => {
    // A vocabulary check that never fires proves nothing. Prove both that the
    // list is non-trivial and that the parser actually REJECTS an unknown slug
    // — the negative control for every "accepts a valid list" case below.
    expect(CAPABILITY_INTENTS.length).toBeGreaterThanOrEqual(13);
    expect(unknownIntents(CAPABILITY_INTENTS)).toEqual([]);

    const rejected = playbookRequiredIntentsSchema.safeParse([
      "definitely_not_an_intent",
    ]);
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0].message).toContain(
      "definitely_not_an_intent"
    );
    // The issue NAMES the offender and points at the list — a bare "invalid"
    // is the failure mode where an author cannot tell a typo from a missing
    // feature.
    expect(rejected.error?.issues[0].message).toContain(
      CAPABILITY_INTENTS.join(", ")
    );
  });

  it("accepts every real slug the vocabulary knows", () => {
    const result = playbookRequiredIntentsSchema.safeParse([
      ...CAPABILITY_INTENTS,
    ]);
    expect(
      result.success ? [] : result.error.issues,
      "a slug from the pod's own vocabulary was refused"
    ).toEqual([]);
  });

  it("refuses an unknown slug through the DEFINITION door, not just the field", () => {
    // Reachability, not shape: drive the ONE door every package/capability/loop
    // door extends, so this proves the field is actually ON it. A field
    // declared on a schema nothing writes through would pass a test aimed at the
    // field schema alone.
    const rejected = playbookDefinitionSchema.safeParse({
      ...base,
      requiredIntents: ["send_message", "not_an_intent"],
    });
    expect(rejected.success).toBe(false);
    const issues = rejected.error?.issues ?? [];
    // ONE issue for one offender, at the offending index. Asserted on `path`
    // rather than by searching the message text: the message necessarily
    // contains the whole vocabulary (which includes "send_message"), so a
    // "this slug was not mentioned" check would fail against a correct door.
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(["requiredIntents", 1]);
    expect(issues[0].message).toContain("not_an_intent");
  });

  it("refuses a duplicate: a requirement is a set", () => {
    // Same reason `params` refuses a duplicate name — the reader drops the
    // second, so "saved" would be a lie about the stored declaration.
    const result = playbookRequiredIntentsSchema.safeParse([
      "send_message",
      "send_message",
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("repeats");
  });

  it("caps the list at MAX_REQUIRED_INTENTS — and says so when the cap cannot yet be reached", () => {
    // The whole vocabulary is accepted: today that is the LONGEST legal
    // declaration, and it must not be refused.
    expect(
      playbookRequiredIntentsSchema.safeParse([...CAPABILITY_INTENTS]).success
    ).toBe(true);

    // ⚠️ MEASURED BOUNDARY, not an omission. MAX_REQUIRED_INTENTS is 24 and
    // the closed vocabulary is 14 slugs, so NO list of real slugs can reach
    // the cap: every candidate is rejected by MEMBERSHIP before the cap could
    // bite. Asserting an over-cap rejection here would have to invent slugs,
    // and an invented slug is rejected as unknown — the test would pass while
    // proving nothing about the cap, which is the "a guard that passes while
    // no longer looking at what it claims" defect.
    //
    // So the cap is asserted where it IS observable: on a syntactically valid
    // list of arbitrary strings (membership not involved, because
    // `.max()` is checked on the array before the refinement runs).
    expect(MAX_REQUIRED_INTENTS).toBeGreaterThan(CAPABILITY_INTENTS.length);
    const overCap = Array.from(
      { length: MAX_REQUIRED_INTENTS + 1 },
      (_, i) => `x${i}`
    );
    const rejected = playbookRequiredIntentsSchema.safeParse(overCap);
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0].message).toContain("at most");
    // The boundary is inclusive: exactly the cap is not a cap violation.
    const atCap = overCap.slice(0, MAX_REQUIRED_INTENTS);
    expect(
      playbookRequiredIntentsSchema.safeParse(atCap).error?.issues[0].message
    ).not.toContain("at most");
  });
});

describe("requiredIntents — satisfiability is NOT gated (the founder's requirement)", () => {
  it("ACCEPTS a requirement no installed capability can serve today", () => {
    // The declaration working. A playbook that needs an intent nothing provides
    // yet is the specification of a future install; rejecting it would forbid
    // the specification itself. Asserted positively so the behaviour is a
    // stated contract, not an absence that later "tightening" can reverse.
    const result = playbookDefinitionSchema.safeParse({
      ...base,
      requiredIntents: [
        "generate_media",
        "capture_into_pod",
        "search_external",
        "manage_file",
      ],
    });
    expect(
      result.success ? [] : result.error.issues,
      "the write door gated SATISFIABILITY — a gap must be reported, not rejected"
    ).toEqual([]);
  });

  it("a playbook declaring nothing is still valid (absent and [] both pass)", () => {
    // Otherwise the field would become mandatory by accident on every playbook
    // in the corpus, and one that needs no external capability could not say so.
    expect(playbookDefinitionSchema.safeParse(base).success).toBe(true);
    expect(
      playbookDefinitionSchema.safeParse({ ...base, requiredIntents: [] })
        .success
    ).toBe(true);
  });
});

describe("requiredIntents — the vocabulary is not a fifth copy", () => {
  it("the door imports the shared leaf rather than declaring its own list", () => {
    // Structural, because a list of slugs written here WOULD parse identically
    // to the shared one until the pod added a slug — and then only this door's
    // copy would go stale. A scan beats prose.
    const src = readFileSync(
      new URL("./playbook-definition.ts", import.meta.url),
      "utf8"
    );
    // Comments are stripped: this file's own prose names the leaf, and a prose
    // mention is not a dependency. Boundary measured: the scan sees CODE, so
    // it catches a real import and cannot be fooled by the docblock.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    expect(code).toContain("@synap-core/types/capability-intents");
    // It must use that door's helper rather than re-implementing membership.
    expect(code).toMatch(/unknownIntents\(/);
    // Boundary: this asserts the door does not declare the vocabulary. It does
    // NOT check the leaf is itself in step with the pod — that is the leaf's
    // parity guard, against the seed migrations.
  });
});
