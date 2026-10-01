/**
 * GUARD — the routing intent as a REAL COLUMN (`skills.intent`, migration 0292).
 *
 * WHAT THIS PROVES (reachability, not shape)
 *   The reported defect: an agent asked `synap_list_capabilities({intent:
 *   "send_message"})` on a pod that HAS a provider-agnostic `messaging.send`,
 *   and received only `gmail_send` — the builtin was invisible to intent
 *   routing. The cause was structural, not a bad row: intent was persisted
 *   ONLY in the requiring TOOL's verb catalog (`deriveToolVerbs` walks tools),
 *   and `SYNAP_CORE_DEFINITION` declares `tools: []`, so NONE of its 47
 *   builtins could ever carry one.
 *
 *   So the assertion is on the VALUE surviving the real path — definition skill
 *   → the applier's own writer → what a reader loads off the row → what a verb
 *   advertises — for a skill that requires NO tool, which is the exact shape
 *   that was invisible. Asserting that a column is DECLARED (the signature
 *   defect here) would pass while nothing populated it.
 *
 * WHY A COLUMN AND NOT THE `metadata` KEY. The key existed first and was removed:
 * it created a SECOND writer beside `deriveToolVerbs`, with neither able to see
 * the other. `resolveVerbIntent` is now the single writer, and both the reader
 * and the drift comparator read the column.
 *
 * WHAT THIS DOES NOT COVER (stated, not implied)
 *   - The DATABASE. No SQL, no `db` here — these drive the pure writer/reader and
 *     the comparator. A bug in the migration's SQL (the 0292 backfill's
 *     determinism, say) would not fail here; it is UNVERIFIED against a live DB
 *     in this change and is reported as such.
 *   - The applier's `.set()` wiring reaching the column. That is pinned by
 *     `capability-drift.projection-parity.tripwire.test.ts`, which reads the
 *     applier's own `.set({...})` out of source and fails by name if the
 *     comparator does not read what the applier writes.
 *   - The index that consumes this (`foldVerbsByIntent`) — owned by another
 *     module, deliberately untouched. What is asserted here is that the VALUE
 *     arrives on the verb a consumer would fold; the fold itself is not
 *     re-tested.
 *   - The closed-vocabulary check for an unregistered slug, which is
 *     `resolveVerbIntent`'s job and is covered by `verb-intent.test.ts`.
 *   - Non-vacuity of the seed corpus: the fixtures are hand-written, so this
 *     file does NOT prove a real template reaches this path. The reachability
 *     assertions pin the shape that was actually broken, and the non-vacuity
 *     case below pins the vocabulary the shape is drawn from.
 */

import { describe, expect, it } from "vitest";
import { ABSTRACT_VERBS } from "@synap/database/schema";
import {
  projectSkillMetadata,
  capabilityDefinitionDrift,
  type DefinitionSkillRow,
  type InstalledSkillRow,
} from "./capability-drift.js";
import { resolveVerbIntent } from "./create-from-definition.js";
import type { CapabilitySkillDef } from "@synap/playbooks";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import { buildVerbStates } from "./capability-registry.js";

/** The applier's real write, as the two call sites perform it. */
function applierWritesIntent(
  s: CapabilitySkillDef,
  known?: ReadonlySet<string>
): string | undefined {
  return resolveVerbIntent(s, known);
}

/** The catalog entry the tool row carries — the DERIVED mirror. */
function derivedMirror(s: CapabilitySkillDef, known?: ReadonlySet<string>) {
  return { intent: applierWritesIntent(s, known) };
}

/** A minimal, TYPE-CHECKED catalog entry (`govDefault` is required, not optional). */
function entry(id: string, intent?: string): ToolVerbCatalogEntry {
  return {
    id,
    label: id,
    kind: "action",
    govDefault: "propose",
    ...(intent ? { intent } : {}),
  };
}

describe("the intent COLUMN reaches a skill that requires no tool", () => {
  it("REACHES the row for the exact shape that was invisible", () => {
    // `messaging.send`, reduced to what the writer reads. The essential property
    // is the ABSENCE of `requires`: no tool row exists to carry a verb catalog,
    // so the skill row is the only carrier there can be. `send_message` is a
    // real member of the closed vocabulary, not a made-up slug.
    const builtin: CapabilitySkillDef = {
      name: "messaging.send",
      kind: "builtin",
      scope: "pod",
      intent: "send_message",
    } as CapabilitySkillDef;

    // Drive the applier's OWN writer — not a hand-built value.
    const written = applierWritesIntent(builtin);

    expect(
      written,
      "the routing intent did not reach the skill row — this skill would stay " +
        "invisible to every intent lookup, exactly as messaging.send did"
    ).toBe("send_message");

    // And the value a reader loads off the row is what a verb advertises: this
    // is the reachability assertion, not "the column exists".
    const verb = buildVerbStates(
      [entry("messaging.send")],
      undefined,
      "builtin",
      new Map(),
      new Map(),
      new Map(),
      new Map([["messaging.send", written!]])
    )[0];
    expect(verb.intent).toBe("send_message");
  });

  it("survives the drift comparator: a declared intent the row lacks IS drift", () => {
    // The seam that made the old projection self-certifying: a field only the
    // comparator CAN see is one the stamp can overclaim. If this is not drift,
    // a template change to intent reaches no pod — permanently, because the
    // reconcile stamps the new contentHash regardless.
    const def: DefinitionSkillRow = {
      name: "messaging.send",
      intent: "send_message",
    };
    // A row applied BEFORE the column existed.
    const stale: InstalledSkillRow = { name: "messaging.send", intent: null };

    expect(
      capabilityDefinitionDrift([stale], { skills: [def] }).drifted,
      "a declared intent missing from the live row must read as drift"
    ).toEqual(["messaging.send"]);
  });

  it("is not drift when the definition declares none — never a re-apply", () => {
    // The direction that would report drift a re-apply can never converge,
    // i.e. a re-apply on every single boot.
    const def: DefinitionSkillRow = { name: "entity.query" };
    const live: InstalledSkillRow = {
      name: "entity.query",
      intent: "search_external",
      metadata: { runCount: 12, marketSource: { slug: "synap-core" } },
    };
    expect(
      capabilityDefinitionDrift([live], { skills: [def] }).drifted
    ).toEqual([]);
  });

  it("is not drift when both sides agree", () => {
    const def: DefinitionSkillRow = {
      name: "messaging.send",
      intent: "send_message",
    };
    const live: InstalledSkillRow = {
      name: "messaging.send",
      intent: "send_message",
      metadata: { runCount: 3 },
    };
    expect(
      capabilityDefinitionDrift([live], { skills: [def] }).drifted
    ).toEqual([]);
  });
});

describe("ONE writer: the column is the authority, the catalog entry is derived", () => {
  it("the same skill resolves to the same value on BOTH surfaces", () => {
    // If these two derived their validation differently, a template could be
    // accepted by one door and rejected by the other — so both call the same
    // `resolveVerbIntent`. Asserted as sameness because that is the property
    // (it does NOT prove either is correct; `verb-intent.test.ts` does).
    const s = {
      name: "gmail_send",
      kind: "declarative",
      requires: ["gmail"],
      intent: "send_message",
    } as CapabilitySkillDef;
    expect(applierWritesIntent(s)).toBe(derivedMirror(s).intent);
  });

  it("an unregistered slug is refused at the write boundary, not persisted", () => {
    // The vocabulary is closed; the column must not become a place a typo lands
    // and quietly splits the routing axis vendor-keyed all over again.
    const s = {
      name: "messaging.send",
      kind: "builtin",
      intent: "send_mesage",
    } as CapabilitySkillDef;
    expect(() => applierWritesIntent(s)).toThrow(/unknown intent/);
  });

  it("a non-string declaration is refused too, never coerced", () => {
    // A value that merely stringifies would match nothing, or match something
    // the author did not mean.
    for (const bad of [123, ["send_message"], { verb: "send_message" }]) {
      // The `unknown` hop is the POINT, not a type-checker appeasement:
      // `CapabilitySkillDef.intent` is typed `string | undefined`, so the
      // compiler already rejects these literals — which is the first line of
      // defence. This test covers the second: templates are Control-Plane JSON
      // parsed as `unknown`, so a non-string arrives at runtime WITHOUT the
      // compile-time gate, and must still be refused rather than stringified.
      const s = {
        name: "x",
        kind: "builtin",
        intent: bad,
      } as unknown as CapabilitySkillDef;
      expect(() => applierWritesIntent(s)).toThrow(/unknown intent/);
    }
  });

  it("NON-VACUITY: the vocabulary this guard depends on is real", () => {
    // Every fixture above uses a slug that must EXIST. If `ABSTRACT_VERBS` were
    // emptied or renamed, `resolveVerbIntent` would start throwing and the
    // reachability case would fail — but the failure would read as "the writer
    // broke", not "the vocabulary changed". Pin the membership explicitly so
    // the intent of the guard is checkable on its own.
    expect(ABSTRACT_VERBS).toContain("send_message");
    expect(ABSTRACT_VERBS.length).toBeGreaterThanOrEqual(13);
  });
});

describe("the reader prefers the column and falls back to the derived mirror", () => {
  const gmail = entry("gmail_send");

  it("a null column with a mirror still resolves — the not-yet-reapplied pod", () => {
    // Migration 0292's backfill covers rows installed before it by deriving from
    // exactly this catalog entry, but a pod that has not re-applied its
    // definition can still have a null column and a populated mirror. Falling
    // back is what keeps those verbs routable in the meantime.
    const [v] = buildVerbStates(
      [entry("gmail_send", "send_message")],
      undefined,
      "provider",
      new Map(),
      new Map(),
      new Map(),
      new Map()
    );
    expect(v.intent).toBe("send_message");
  });

  it("the COLUMN wins over a stale mirror — the applier is the authority", () => {
    // The direction that matters: if the mirror won, a value the applier has
    // since written could never take effect, and the re-apply would be a no-op
    // forever while the pod kept routing by the old meaning.
    const [v] = buildVerbStates(
      [entry("gmail_send", "send_message")],
      undefined,
      "provider",
      new Map(),
      new Map(),
      new Map(),
      new Map([["gmail_send", "fetch_record"]])
    );
    expect(v.intent).toBe("fetch_record");
  });

  it("no column and no mirror leaves the verb ABSENT, never guessed into a bucket", () => {
    // A legacy verb that predates the axis must stay out of the index entirely;
    // a consumer can then tell "declares none" from "declares something".
    const [v] = buildVerbStates(
      [gmail],
      undefined,
      "provider",
      new Map(),
      new Map(),
      new Map(),
      new Map()
    );
    expect(v.intent).toBeUndefined();
    expect("intent" in v).toBe(false);
  });

  it("an EMPTY column value is treated as absent, like the write door's min(1)", () => {
    const [v] = buildVerbStates(
      [gmail],
      undefined,
      "provider",
      new Map(),
      new Map(),
      new Map(),
      new Map([["gmail_send", ""]])
    );
    expect(v.intent).toBeUndefined();
  });
});

describe("removing the metadata key did not disturb the two that were already there", () => {
  it("writes egress/readOnly WITHOUT blanking what was already on the row", () => {
    // The property the whole bag approach depends on: each key is independently
    // skippable, so a template declaring only `readOnly` must leave an
    // `allowedHosts` list set through the tRPC door intact.
    const existing = {
      allowedHosts: ["api.exa.ai"],
      readOnly: true,
      marketSource: { slug: "exa" },
      runCount: 9,
    };
    const projected = projectSkillMetadata(existing, {
      allowedHosts: ["api.exa.ai"],
    });

    expect(projected).toEqual({
      allowedHosts: ["api.exa.ai"],
      readOnly: true,
      marketSource: { slug: "exa" },
      runCount: 9,
    });
  });

  it("writes NOTHING at all when the definition declares no owned key", () => {
    // `undefined` → Drizzle's `.set()` SKIPS the key and the live bag is not
    // rewritten. This is the guard on "no owned key" itself — and with `intent`
    // gone from the bag, a skill that declares ONLY an intent must take this
    // path, leaving the live bag untouched.
    expect(projectSkillMetadata({ runCount: 4 }, undefined)).toBeUndefined();
    expect(projectSkillMetadata({ runCount: 4 }, {})).toBeUndefined();
  });

  it("does NOT smuggle the intent back into the bag", () => {
    // The second writer, asserted absent rather than merely unused: a definition
    // carrying both an intent and egress must produce a bag with ONLY the
    // bag-shaped keys. If a future edit re-adds the intent key, this goes red —
    // which is the point, since the column now owns that value.
    const projected = projectSkillMetadata(
      { runCount: 2 },
      { allowedHosts: ["a.example.com"], readOnly: true }
    );
    expect(projected).not.toHaveProperty("intent");
    expect(Object.keys(projected!).sort()).toEqual([
      "allowedHosts",
      "readOnly",
      "runCount",
    ]);
  });

  it("keeps each key independently skippable in BOTH directions", () => {
    // readOnly alone must not drag allowedHosts in…
    expect(projectSkillMetadata(null, { readOnly: true })).toEqual({
      readOnly: true,
    });
    // …and a declared allowlist must not blank a live readOnly.
    expect(
      projectSkillMetadata(
        { readOnly: true },
        { allowedHosts: ["a.example.com"] }
      )
    ).toEqual({ readOnly: true, allowedHosts: ["a.example.com"] });
  });
});
