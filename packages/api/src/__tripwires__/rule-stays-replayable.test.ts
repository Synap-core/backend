/**
 * A RULE MUST STAY REPLAYABLE AFTER IT IS APPROVED.
 *
 * `skills.dryRunRule` REQUIRES a sentence to replay a trigger against real
 * history. The sentence was written into the rule's PROPOSAL payload
 * (`create.ts`, the `checkPermissionOrPropose` data blob) and nowhere else, so:
 *
 *   proposed rule  → has a sentence → replayable
 *   approved rule  → no sentence    → NOT replayable, forever
 *
 * You could preview a rule you had not trusted yet, and never the one that had
 * been running for a month. Exactly backwards for a feature whose entire point
 * is "show me what this actually does before you trust it".
 *
 * The asymmetry is what this pins: BOTH sinks must receive the sentence. A
 * behavioural test in `create.test.ts` asserts the stored row really carries it
 * (and was mutation-verified — deleting the pass-through left all 89 other
 * tests green, because they covered `buildRuleMetadata` in isolation and
 * nothing covered the SEAM). This file guards the pair, which no single
 * behavioural test can express.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API_SRC = join(__dirname, "..");

/**
 * Strip comments. Every assertion here scans for CODE, and this repo's files
 * carry long explanatory headers that quote the very identifiers being looked
 * for — a scan that cannot tell code from prose measures prose. (Three tests
 * in this wave were fooled exactly that way.)
 */
function readCode(rel: string): string {
  const path = join(API_SRC, rel);
  if (!existsSync(path)) throw new Error(`guarded file is missing: ${rel}`);
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("a rule stays replayable after approval", () => {
  const create = () => readCode("services/rules/create.ts");

  it("the create door sends the sentence to BOTH sinks, not just the proposal", () => {
    const body = create();
    const sinks = [...body.matchAll(/sentence: input\.sentence/g)];
    expect(
      sinks.length,
      "`createRuleGoverned` must pass the sentence to the PROPOSAL payload " +
        "(so an approved rule replays byte-identically to a direct create) AND " +
        "to `buildRuleMetadata` (so the materialized rule stays replayable). " +
        `Found ${sinks.length} of the 2 expected sinks — a rule that is ` +
        "replayable while proposed and never after is the defect this guards."
    ).toBeGreaterThanOrEqual(2);
  });

  it("the metadata builder both accepts and emits it", () => {
    const index = readCode("services/rules/index.ts");
    // Accepted on the builder's input…
    expect(index).toMatch(/sentence\?:\s*unknown/);
    // …and re-emitted by the reader, or the round trip loses it silently.
    expect(
      index,
      "`readRuleMetadata` must project `sentence`, or it is written and never " +
        "read back — a store with no reader."
    ).toMatch(/candidate\.sentence/);
  });

  it("the stored sentence is NOT parsed by the reader", () => {
    // Deliberate: the reader is the untrusted-blob boundary and the sentence's
    // own schema parses at the point of replay. Parsing eagerly would let ONE
    // malformed stored sentence make the whole rule unreadable — and the rule's
    // prose is what agents consume, so it must survive a bad preview.
    const index = readCode("services/rules/index.ts");
    const at = index.indexOf("export function readRuleMetadata");
    expect(at).toBeGreaterThan(-1);
    const body = index.slice(at, at + 2000);
    expect(
      body,
      "`readRuleMetadata` must not parse the sentence — a bad preview must " +
        "never cost the rule"
    ).not.toMatch(/readRuleSentence|ruleSentenceSchema/);
  });

  /**
   * ONE SLOT, both paths.
   *
   * `skills.listRules` returns materialized and PROPOSED rules in the SAME
   * array. A materialized row carries the sentence inside `rule` (that is where
   * `readRuleMetadata` projects it); a proposed row used to carry it at the
   * row's TOP LEVEL instead. A client reading `row.rule.sentence` — the only
   * slot that exists for an approved rule — therefore found nothing on a
   * proposed one, and the dry-run panel reported "this rule's WHEN was not
   * stored" for precisely the rules that DO carry one.
   *
   * Two slots for one field in one array is the fork; this pins the merge.
   */
  it("a PROPOSED rule carries its sentence in the same slot as a materialized one", () => {
    const src = readCode("services/proposals/pending-rules.ts");
    const at = src.indexOf("buildRuleMetadata({");
    expect(at, "`buildRuleMetadata` call not found").toBeGreaterThan(-1);

    // Walk the call's own argument object, so a `sentence` key elsewhere in the
    // row literal cannot satisfy this.
    let depth = 0;
    let i = src.indexOf("{", at);
    const start = i;
    for (; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const args = src.slice(start, i);

    expect(
      /sentence/.test(args),
      "`listPendingRuleProposals` does not pass `sentence` into " +
        "`buildRuleMetadata`, so a proposed rule's sentence lands somewhere a " +
        "reader of `rule.sentence` cannot see it — and that reader is every " +
        "client, because it is the only slot a materialized rule has."
    ).toBe(true);
  });
});
