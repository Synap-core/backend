import { describe, it, expect } from "vitest";
import {
  resolveStatusLabel,
  STATUS_LABELS,
  humanizeToken,
  resolveActionLabel,
  resolveObjectNoun,
  OBJECT_NOUNS,
  buildObjectActionTitle,
  ACTION_VERBS,
  OBJECT_KINDS,
  OBJECT_KIND_ALIASES,
  FALLBACK_ICON,
  resolveProposalKindLabel,
  PROPOSAL_KIND_LABELS,
} from "./index.js";
import { buildFallbackTitle } from "../proposals/proposal-utils.js";

describe("humanizeToken", () => {
  it("never leaks a raw machine token", () => {
    // The defect: `channel-facts.ts` rendered "entity.create" verbatim to users.
    expect(humanizeToken("entity.create")).toBe("Create");
    expect(humanizeToken("governance.widen_lane")).toBe("Widen lane");
    expect(humanizeToken("focus_session")).toBe("Focus session");
    expect(humanizeToken("capabilityKind")).toBe("Capability kind");
    expect(humanizeToken("api-key")).toBe("Api key");
  });
});

describe("resolveActionLabel — two moods", () => {
  it("keeps imperative and past DISTINCT (they were an accidental fork)", () => {
    // event-renderer said "Created"; ProposalChrome said "Create". Both right.
    expect(resolveActionLabel("create", "imperative")).toBe("Create");
    expect(resolveActionLabel("create", "past")).toBe("Created");
    expect(resolveActionLabel("run", "imperative")).toBe("Run");
    expect(resolveActionLabel("run", "past")).toBe("Ran");
  });

  it("resolves a dotted proposalType by its last segment", () => {
    expect(resolveActionLabel("capability.run")).toBe("Run");
    expect(resolveActionLabel("messaging.external.send", "past")).toBe("Sent");
  });

  it("carries the session-conversion and triage verbs in both moods", () => {
    // The receipt says "Promoted to playbook X"; the button says "Promote".
    expect(resolveActionLabel("promote", "imperative")).toBe("Promote");
    expect(resolveActionLabel("promote", "past")).toBe("Promoted");
    expect(resolveActionLabel("spawn", "past")).toBe("Spawned");
    // Triage is not governance — accept/discard, never approve/reject.
    expect(resolveActionLabel("accept", "imperative")).toBe("Accept");
    expect(resolveActionLabel("discard", "past")).toBe("Discarded");
    expect(resolveActionLabel("revert", "past")).toBe("Reverted");
  });

  it("settles the Refused/Rejected split on one canonical pair", () => {
    expect(resolveActionLabel("reject", "imperative")).toBe("Reject");
    expect(resolveActionLabel("reject", "past")).toBe("Rejected");
  });

  it("names the dev-loop gates by WHICH gate, resolving the full proposal type", () => {
    // Matched on the last dotted segment, so the proposal type resolves too.
    expect(resolveActionLabel("dev.plan_approval", "imperative")).toBe(
      "Approve plan"
    );
    expect(resolveActionLabel("dev.plan_approval", "past")).toBe(
      "Approved plan"
    );
    expect(resolveActionLabel("dev.deploy_approval", "imperative")).toBe(
      "Approve deploy"
    );
    expect(resolveActionLabel("dev.deploy_approval", "past")).toBe(
      "Approved deploy"
    );
    // Not collapsed into the generic decision verb — that is the whole point.
    expect(resolveActionLabel("dev.plan_approval", "imperative")).not.toBe(
      resolveActionLabel("approve", "imperative")
    );
  });

  it("humanizes an unknown verb instead of leaking it", () => {
    expect(resolveActionLabel("declare_source")).toBe("Declare source");
  });

  it("every curated verb defines both moods", () => {
    for (const [key, verb] of Object.entries(ACTION_VERBS)) {
      expect(verb.imperative, `${key}.imperative`).toBeTruthy();
      expect(verb.past, `${key}.past`).toBeTruthy();
    }
  });
});

describe("resolveObjectNoun", () => {
  it("de-underscores kinds that used to render raw", () => {
    // Canonical names come from OBJECT_KIND_ALIASES + OBJECT_KINDS, NOT from
    // naive humanization — the registry calls this kind "Session", so we must
    // too. These pairs used to be a hand-mirrored table guarded by a drift test
    // in synap-app; there is now ONE table, so they are asserted here.
    expect(resolveObjectNoun("focus_session")).toBe("Session");
    expect(resolveObjectNoun("focus_sessions")).toBe("Session");
    expect(resolveObjectNoun("entity_facet")).toBe("Facet");
    expect(resolveObjectNoun("entity_facets")).toBe("Facet");
    expect(resolveObjectNoun("property_def")).toBe("Property");
    expect(resolveObjectNoun("property_defs")).toBe("Property");
    expect(resolveObjectNoun("relation")).toBe("Link");
    expect(resolveObjectNoun("relations")).toBe("Link");
  });

  it("titles the backend-only kinds the registry does not model", () => {
    expect(resolveObjectNoun("relation_def")).toBe("Relation type");
    expect(resolveObjectNoun("api_key")).toBe("API key");
    expect(resolveObjectNoun("env_variable")).toBe("Environment variable");
  });

  /**
   * PORTED from the deleted `vocabulary-noun-drift.test.ts` (synap-app). The
   * drift assertion itself is vacuous now that there is one table, but the
   * property it protected is not: no registered kind may render as a raw token,
   * and every kind's rendered noun must be its registry label.
   */
  it("renders every registered kind as its registry label, never a raw token", () => {
    const disagreements: string[] = [];
    for (const [slug, def] of Object.entries(OBJECT_KINDS)) {
      const rendered = resolveObjectNoun(slug);
      if (rendered !== def.label) {
        disagreements.push(
          `${slug}: registry="${def.label}" rendered="${rendered}"`
        );
      }
      expect(rendered, slug).not.toMatch(/[_.]/);
      expect(rendered[0], slug).toBe(rendered[0]?.toUpperCase());
    }
    expect(disagreements).toEqual([]);
  });

  /**
   * The graph door (`GRAPH_KINDS`) and the Processes queue return these three;
   * before they were registered, `resolveObjectIcon` gave every one of them the
   * neutral `Box` and each surface kept its own glyph map beside the registry.
   */
  it("registers the graph-only kinds the Why pane and the queue render", () => {
    for (const kind of ["run", "source", "participant"] as const) {
      expect(OBJECT_KINDS[kind], kind).toBeDefined();
      expect(OBJECT_KINDS[kind]?.icon, kind).not.toBe(FALLBACK_ICON);
    }
    expect(resolveObjectNoun("run")).toBe("Run");
    expect(resolveObjectNoun("source")).toBe("Source");
    expect(resolveObjectNoun("participant")).toBe("Participant");
  });

  it("the backend-only tail never shadows a registry kind (one table, no fork)", () => {
    for (const key of Object.keys(OBJECT_NOUNS)) {
      expect(OBJECT_KINDS[key], key).toBeUndefined();
      expect(OBJECT_KIND_ALIASES[key], key).toBeUndefined();
    }
  });
});

describe("buildFallbackTitle — the regressions it shipped", () => {
  it('titles a capability RUN as a run, not "Update Capability"', () => {
    // THE bug: a run carries no changeType, gets defaulted to "update"
    // upstream, and was rendered "Update Capability" — it updates nothing.
    const title = buildFallbackTitle({
      changeType: "update",
      proposalType: "run",
      targetType: "capability",
    });
    expect(title).toBe("Run Capability");
    expect(title).not.toBe("Update Capability");
  });

  it("de-underscores the TYPE label, not just the action", () => {
    // Users saw "Focus_session" / "Property_def".
    expect(
      buildFallbackTitle({ changeType: "create", targetType: "focus_session" })
    ).toBe("Create Session");
    expect(
      buildFallbackTitle({ changeType: "update", targetType: "property_def" })
    ).toBe("Update Property");
  });

  it("keeps the historical shape for ordinary proposals", () => {
    expect(
      buildFallbackTitle({
        changeType: "create",
        profileSlug: "task",
        targetName: "Design onboarding",
      })
    ).toBe('Create Task "Design onboarding"');
    // `entity` is the generic base kind — suppressed, never "Create Entity".
    expect(
      buildFallbackTitle({ changeType: "create", targetType: "entity" })
    ).toBe("Create");
    expect(buildFallbackTitle({})).toBe("Proposal");
  });

  it("never emits the double-space the old concat band-aided away", () => {
    const title = buildFallbackTitle({
      changeType: "update",
      targetType: "entity",
      targetName: "X",
    });
    expect(title).not.toMatch(/ {2}/);
  });
});

describe("buildObjectActionTitle", () => {
  it("prefers proposalType over changeType", () => {
    expect(
      buildObjectActionTitle({
        action: "run",
        fallbackAction: "update",
        objectKind: "capability",
      })
    ).toBe("Run Capability");
  });

  it("falls back to changeType when no proposalType", () => {
    expect(
      buildObjectActionTitle({
        fallbackAction: "delete",
        objectKind: "view",
        objectName: "To-dos",
      })
    ).toBe('Delete View "To-dos"');
  });
});

/**
 * TRIPWIRE — no proposal type may reach a human as a raw machine token.
 *
 * The vocabulary deliberately FALLS BACK to `humanizeToken` rather than
 * requiring an entry per type, so this asserts the property that actually
 * matters (nothing leaks) instead of demanding a hand-maintained list that
 * would rot. The sample is the real vocabulary observed in the executor
 * registry and on live pods.
 */
describe("tripwire: no raw machine token reaches a title", () => {
  const REAL_PROPOSAL_TYPES = [
    "create",
    "update",
    "delete",
    "run",
    "capability.run",
    "capability.install",
    "capability.enable",
    "merge",
    "merge_branch",
    "join",
    "import.graph",
    "capture.graph",
    "governance.widen_lane",
    "governance.tighten_lane",
    "governance.raise_ceiling",
    "governance.tighten_posture",
    "messaging.external.send",
    "vault.request",
    "channel.mcp.add",
    "renderer.set",
    "declare_source",
    "configure_public_projection",
  ];
  const REAL_TARGET_TYPES = [
    "entity",
    "capability",
    "view",
    "workspace",
    "focus_session",
    "property_def",
    "relation_def",
    "channel",
    "automation",
    "playbook",
    "document",
    "project",
  ];

  for (const proposalType of REAL_PROPOSAL_TYPES) {
    it(`"${proposalType}" renders as words`, () => {
      for (const targetType of REAL_TARGET_TYPES) {
        const title = buildFallbackTitle({ proposalType, targetType });
        expect(title, `${proposalType} / ${targetType}`).not.toMatch(/[_.]/);
        expect(title.trim()).not.toBe("");
        // A leaked token would still be lowercase mid-string; a rendered
        // sentence always starts with a capital.
        expect(title[0]).toBe(title[0]?.toUpperCase());
      }
    });
  }
});

describe("resolveStatusLabel", () => {
  it("settles the Refused/Rejected split (one canonical word)", () => {
    expect(resolveStatusLabel("rejected")).toBe("Rejected");
    // A proposal applied per-item is a distinct outcome from a full approval,
    // even though the row's `status` column says `approved` for both.
    expect(resolveStatusLabel("partially_approved")).toBe("Partially approved");
    expect(resolveStatusLabel("partially_approved")).not.toBe(
      resolveStatusLabel("approved")
    );
    expect(resolveStatusLabel("denied")).toBe("Rejected");
  });

  it("settles the failed/stale renderings for LIFECYCLE states", () => {
    expect(resolveStatusLabel("failed")).toBe("Failed");
    // Deliberately the neutral word: `stale` is overloaded across three domains
    // (session progress / sync freshness / broken binding), so a GLOBAL table
    // must not impose one reading.
    expect(resolveStatusLabel("stale")).toBe("Stale");
  });

  it("humanizes an unknown status instead of leaking it", () => {
    expect(resolveStatusLabel("some_new_state")).toBe("Some new state");
    expect(resolveStatusLabel("")).toBe("");
  });

  it("names the derived session lenses without leaking their tokens", () => {
    expect(resolveStatusLabel("ready")).toBe("Ready");
    expect(resolveStatusLabel("waiting")).toBe("Waiting");
    expect(resolveStatusLabel("blocked")).toBe("Blocked");
    expect(resolveStatusLabel("done")).toBe("Done");
    expect(resolveStatusLabel("drafted")).toBe("Drafted");
  });

  it("never renders a raw token for any known status", () => {
    for (const key of Object.keys(STATUS_LABELS)) {
      const label = resolveStatusLabel(key);
      expect(label, key).not.toMatch(/[_.]/);
      expect(label[0], key).toBe(label[0]?.toUpperCase());
    }
  });
});

describe("resolveProposalKindLabel — all 14 ProposalKind values", () => {
  // The full `ProposalKind` union from `@synap-core/proposal-types`
  // (`useProposalPresentation.ts`), minus `document`/`session` which are
  // covered by `resolveObjectNoun` via `OBJECT_KINDS` directly.
  const ALL_PROPOSAL_KINDS = [
    "create",
    "update",
    "delete",
    "document",
    "link",
    "facet",
    "composite",
    "session",
    "merge",
    "install",
    "governance_widen",
    "governance_tighten",
    "governance_raise_ceiling",
    "governance_tighten_posture",
    "capability_run",
    "automation_run",
    "dev_plan_approval",
    "dev_deploy_approval",
  ];

  it("settles the facet/composite fork between relay and proposal-ui", () => {
    // relay's shared.tsx said "Role"/"Bundle"; synap-app's ProposalChrome.tsx
    // said "Facet"/"Multi-entity" (and leaked raw tokens for anything else it
    // didn't list). This table is the one both should resolve through.
    expect(resolveProposalKindLabel("facet")).toBe("Role");
    expect(resolveProposalKindLabel("composite")).toBe("Bundle");
  });

  it("names the governance recommender kinds instead of humanizing them", () => {
    expect(resolveProposalKindLabel("governance_widen")).toBe("Widen a lane");
    expect(resolveProposalKindLabel("governance_tighten")).toBe(
      "Tighten a lane"
    );
    expect(resolveProposalKindLabel("governance_raise_ceiling")).toBe(
      "Raise a ceiling"
    );
    expect(resolveProposalKindLabel("governance_tighten_posture")).toBe(
      "Tighten posture"
    );
  });

  it("gives each dev-loop gate its OWN chip", () => {
    // Two different questions — "may I start?" vs "may I ship?" — must never
    // collapse into one label a reviewer has to open the card to disambiguate.
    expect(resolveProposalKindLabel("dev_plan_approval")).toBe(
      "Approve a plan"
    );
    expect(resolveProposalKindLabel("dev_deploy_approval")).toBe(
      "Approve a deploy"
    );
    expect(resolveProposalKindLabel("dev_plan_approval")).not.toBe(
      resolveProposalKindLabel("dev_deploy_approval")
    );
  });

  it("covers every ProposalKind with a real word, never a raw token", () => {
    for (const kind of ALL_PROPOSAL_KINDS) {
      const label = resolveProposalKindLabel(kind);
      expect(label, kind).not.toBe("");
      expect(label, kind).not.toMatch(/[_.]/);
      expect(label[0], kind).toBe(label[0]?.toUpperCase());
    }
  });

  it("humanizes an unknown kind instead of leaking it", () => {
    expect(resolveProposalKindLabel("some_future_kind")).toBe(
      "Some future kind"
    );
    expect(resolveProposalKindLabel(null)).toBe("");
  });

  it("PROPOSAL_KIND_LABELS has an entry for every curated kind used above", () => {
    for (const kind of [
      "create",
      "update",
      "delete",
      "document",
      "link",
      "facet",
      "composite",
      "session",
      "merge",
      "install",
      "governance_widen",
      "governance_tighten",
      "governance_raise_ceiling",
      "governance_tighten_posture",
      "capability_run",
      "automation_run",
    ]) {
      expect(PROPOSAL_KIND_LABELS[kind], kind).toBeTruthy();
    }
  });
});

describe("publish — the object-work decision verb", () => {
  it("carries BOTH moods, so the button and the receipt cannot disagree", () => {
    // "Publish" on the button while the trail says "Approved" would describe
    // one act two ways. The past mood is the proof the table entry exists:
    // an unknown token humanizes to "Publish" in BOTH moods.
    expect(resolveActionLabel("publish")).toBe("Publish");
    expect(resolveActionLabel("publish", "past")).toBe("Published");
  });
});

describe("session population lenses", () => {
  it("names the three session kinds", () => {
    // One `focus_sessions` table, three populations. A surface offering the
    // lens must not hand-write these three words.
    expect(resolveStatusLabel("work")).toBe("Work");
    expect(resolveStatusLabel("run")).toBe("Run");
    expect(resolveStatusLabel("receipt")).toBe("Receipt");
  });
});

/**
 * MOOD-COVERAGE tripwire — the fallback is silent, and that is the class bug.
 *
 * `resolveActionLabel(action, mood)` falls back to `humanizeToken(action)` for
 * an unknown token. `humanizeToken` has no tense and **ignores `mood`
 * entirely**, so a past-mood call for a missing verb returns a present-tense
 * word and nothing anywhere reports a problem. That is how a settled Activity
 * row rendered "Complete Capture" — present-imperative, in the emerald agent
 * voice — making a thing that had already happened look like a thing about to
 * happen. The two moods exist precisely so that cannot occur; a token missing
 * from `ACTION_VERBS` collapses them back into one.
 *
 * The fallback itself is correct and must stay: a NEW enum value must never
 * reach a user as a raw token. What must not happen silently is a token the
 * system ROUTINELY EMITS having no entry. So this pins the emitted corpus.
 */
describe("every emitted action token has both moods", () => {
  /**
   * Action tokens that reach a user-facing surface.
   *
   * `EVENT_ACTIONS` is the closed list for entity events. The rest are middle
   * segments other producers emit into `events.type` — `buildEventPattern`'s
   * `PATTERN_MAP` (automations/sentence.ts) and `routers/capture.ts`. They are
   * listed rather than derived because they live in another package; adding a
   * producer means adding it here, which is the point.
   */
  const EMITTED = [
    "create",
    "update",
    "delete",
    "archive",
    "restore",
    "complete", // capture.complete.completed
    "received", // external_message.received.completed
    "run", // capability.run
  ] as const;

  for (const action of EMITTED) {
    it(`\`${action}\` resolves through ACTION_VERBS, not the humanize fallback`, () => {
      expect(ACTION_VERBS[action]).toBeDefined();
    });
  }

  it("the two moods are actually different words where tense applies", () => {
    // A verb whose moods are identical is either genuinely invariant or a row
    // someone filled in twice with the same word. None of these are invariant.
    for (const action of EMITTED) {
      const verb = ACTION_VERBS[action];
      expect(verb, action).toBeDefined();
      expect(
        verb!.imperative === verb!.past,
        `\`${action}\` has the same word for both moods — the mood argument ` +
          `does nothing for it, which is the defect this file guards.`
      ).toBe(false);
    }
  });

  it("the fallback still protects an unknown token", () => {
    // Not a regression test for the above — the opposite. An enum value nobody
    // has taught us must humanize, never leak.
    expect(resolveActionLabel("declare_source", "past")).toBe("Declare source");
  });
});
