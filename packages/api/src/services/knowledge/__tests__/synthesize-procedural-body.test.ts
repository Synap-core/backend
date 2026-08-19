/**
 * THE regression pin for the 2026-08-18 dogfood finding: `synap ask` answered
 * "I cannot find a specific definition of…" while the note that answered the
 * question was sitting in its own `sources` list.
 *
 * Procedural rows (`knowledge_keys`) are `{id, key, namespace, slug, value}`.
 * They carry no `name`/`title`/`content` and no `properties`, so in the context
 * builder they used to:
 *   1. fall through the whole title chain to the raw UUID, and
 *   2. land in the generic "other short string props" branch, which clips every
 *      field to 300 characters.
 * A global-lane runbook is routinely thousands of characters, so synthesis saw
 * roughly its first paragraph and nothing else — the pod stored the knowledge
 * correctly and then could not read it back. That is the whole point of the
 * pod-as-shared-memory contract, so it is pinned here.
 */

import { describe, it, expect } from "vitest";
import { buildSynthesisContext } from "../synthesize.js";
import type { AskAnswer } from "../ask.js";

const KEY = "codestate:cost-observability-chokepoint-landed-2026-08-18";
const ID = "71f8d4ff-1b14-44c4-bd77-aa6b3cf6919c";

/** The part of a real runbook that lives PAST the old 300-char cliff. */
const BURIED = "DO NOT move this to callCascade";

function proceduralAnswer(value: string): AskAnswer[] {
  const answer: AskAnswer = {
    substrate: "procedural",
    status: "ok",
    items: [
      {
        id: ID,
        key: KEY,
        namespace: "codestate",
        slug: "cost-observability-chokepoint-landed-2026-08-18",
        value,
      },
    ],
  } as unknown as AskAnswer;
  return [answer];
}

/** A body whose answer-bearing sentence sits well beyond 300 chars. */
const LONG_VALUE = `${"CODE STATE — LLM cost observability. ".repeat(20)}${BURIED}.`;

describe("buildSynthesisContext — procedural runbooks", () => {
  it("PREMISE: the answer-bearing text really is past the old 300-char cliff", () => {
    // Guards the test itself: if this ever stops holding, the assertions below
    // would pass for the wrong reason.
    expect(LONG_VALUE.indexOf(BURIED)).toBeGreaterThan(300);
  });

  it("carries the runbook BODY into the context, not just its opening 300 chars", () => {
    const { context } = buildSynthesisContext(proceduralAnswer(LONG_VALUE));
    expect(context).toContain(BURIED);
  });

  it("names the source by its KEY, never the bare UUID", () => {
    const { sources } = buildSynthesisContext(proceduralAnswer(LONG_VALUE));
    expect(sources).toHaveLength(1);
    expect(sources[0]!.title).toBe(KEY);
    expect(sources[0]!.title).not.toBe(ID);
    // The id is still carried — it is the link target, just not the label.
    expect(sources[0]!.id).toBe(ID);
  });

  it("does not emit the body twice (once long, once via the 300-char branch)", () => {
    const { context } = buildSynthesisContext(proceduralAnswer(LONG_VALUE));
    expect(context.split(BURIED).length - 1).toBe(1);
  });

  it("still budget-limits a runaway body rather than dumping it whole", () => {
    const huge = "x".repeat(50_000);
    const { context } = buildSynthesisContext(proceduralAnswer(huge));
    expect(context.length).toBeLessThan(20_000);
  });

  it("leaves entity-shaped rows unchanged (content path still wins)", () => {
    const entityAnswer = [
      {
        substrate: "semantic",
        status: "ok",
        items: [{ id: "e1", title: "Some Entity", content: "body text here" }],
      },
    ] as unknown as AskAnswer[];
    const { sources, context } = buildSynthesisContext(entityAnswer);
    expect(sources[0]!.title).toBe("Some Entity");
    expect(context).toContain("body text here");
  });
});
