import { describe, expect, it } from "vitest";
import { deriveVerbKind } from "./create-from-definition.js";
import type { CapabilitySkillDef } from "@synap/playbooks";

function skill(name: string, description = ""): CapabilitySkillDef {
  return { name, description };
}

describe("deriveVerbKind", () => {
  // Regression cases for the 5 confirmed-live mislabels: substring matching
  // (`.includes()`) misfired on incidental substrings inside whole words —
  // "dataset" contains "set", "thread" contains "read", "publishedDate"
  // contains "publish" — and on read-only verbs whose PROSE mentions a
  // sibling write verb ("find an actor" inside apify_run_actor's own
  // description). Whole-word, name-first matching fixes all five without
  // flipping any other seeded verb's correct kind.
  it("classifies search/find verbs as read even when description text incidentally contains action words", () => {
    expect(
      deriveVerbKind(
        skill(
          "exa_search",
          "Neural web search... startPublishedDate?: ISO8601, endPublishedDate?: ISO8601"
        )
      )
    ).toBe("read");
    expect(
      deriveVerbKind(skill("exa_find_similar", "Finds pages similar to a URL"))
    ).toBe("read");
  });

  it("classifies a billed actor-run verb as action even when its description mentions a sibling 'find' verb", () => {
    expect(
      deriveVerbKind(
        skill(
          "apify_run_actor",
          "Runs ANY Apify actor by id. Use apify_search_actors to find an actor first."
        )
      )
    ).toBe("action");
  });

  it("classifies list/get verbs as read even when 'dataset' incidentally contains the word 'set'", () => {
    expect(
      deriveVerbKind(
        skill(
          "apify_list_actor_runs",
          "Lists past runs of one actor. No cost, no side effects."
        )
      )
    ).toBe("read");
    expect(
      deriveVerbKind(
        skill(
          "apify_get_dataset_items",
          "Fetches the result items of one dataset. No cost, no side effects."
        )
      )
    ).toBe("read");
  });

  it("still classifies genuine write verbs as action", () => {
    expect(deriveVerbKind(skill("gmail_send", "Sends an email"))).toBe(
      "action"
    );
    expect(
      deriveVerbKind(skill("capture_social_post", "Posts a comment"))
    ).toBe("action");
  });

  it("falls back to description only when the name is inconclusive, and defaults to action when neither is", () => {
    // Whole-word matching only — no stemming — so the fallback needs the
    // exact signal word, not a conjugated form ("fetch", not "fetches").
    expect(deriveVerbKind(skill("do_thing", "fetch the current state"))).toBe(
      "read"
    );
    expect(deriveVerbKind(skill("do_thing", "no signal here at all"))).toBe(
      "action"
    );
  });
});
