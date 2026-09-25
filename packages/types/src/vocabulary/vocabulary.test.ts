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
  resolveObjectNounPlural,
  resolveProvenanceLabel,
  PROVENANCE_LABELS,
  resolveBlockedReasonLabel,
  BLOCKED_REASON_LABELS,
  resolveLineageEdgeLabel,
  LINEAGE_EDGE_LABELS,
  resolveCaptureDoorLabel,
  CAPTURE_DOOR_LABELS,
  resolveNotificationCategoryLabel,
  NOTIFICATION_CATEGORY_LABELS,
  resolveNotificationRoutingRuleLabel,
  NOTIFICATION_ROUTING_RULE_LABELS,
} from "./index.js";

describe("capture vocabulary", () => {
  it("names every derived capture status in words humanizing would get wrong", () => {
    expect(resolveStatusLabel("structured")).toBe("Structured");
    // Discriminating: humanizeToken says "Saved without ai" / "Needs answer".
    expect(resolveStatusLabel("saved_without_ai")).toBe("Saved without AI");
    expect(humanizeToken("saved_without_ai")).not.toBe("Saved without AI");
    expect(resolveStatusLabel("needs_answer")).toBe("Needs your answer");
    expect(resolveStatusLabel("not_structured")).toBe("Not structured");
  });

  it("keys a dotted door by the WHOLE token, never its tail segment", () => {
    expect(resolveCaptureDoorLabel("capture.graph")).toBe("Agent or app");
    expect(humanizeToken("capture.graph")).toBe("Graph");
    expect(resolveCaptureDoorLabel("calcom.webhook")).toBe("Cal.com");
    expect(resolveCaptureDoorLabel("calcom.backfill")).toBe("Cal.com");
    expect(resolveCaptureDoorLabel("message.interpret")).toBe("Chat");
    expect(resolveCaptureDoorLabel("capture.execute")).toBe("Capture");
    expect(resolveCaptureDoorLabel("structure_again")).toBe("Structure again");
    // A tail-keyed lookup would miss every dotted row: none of the tails are keys.
    for (const door of Object.keys(CAPTURE_DOOR_LABELS).filter((d) =>
      d.includes(".")
    )) {
      expect(
        CAPTURE_DOOR_LABELS[door.slice(door.lastIndexOf(".") + 1)],
        door
      ).toBeUndefined();
    }
  });

  it("an unknown door humanizes, never leaks; an absent door is empty", () => {
    expect(resolveCaptureDoorLabel("zapier.hook_in")).toBe("Hook in");
    expect(resolveCaptureDoorLabel("zapier.hook_in")).not.toMatch(/[._]/);
    expect(resolveCaptureDoorLabel(null)).toBe("");
  });
});
import { buildFallbackTitle } from "../proposals/proposal-utils.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

describe("resolveLineageEdgeLabel", () => {
  it("reads the produced edge from the side the reader stands on", () => {
    expect(resolveLineageEdgeLabel("produced", "incoming")).toBe("Made from");
    expect(resolveLineageEdgeLabel("produced", "outgoing")).toBe("Made");
  });

  it("names a rerun only through its own key, never spawned_from", () => {
    expect(resolveLineageEdgeLabel("rerun", "outgoing")).toBe("Rerun of");
    // A plain fork is also spawned_from — it must not read "Rerun of".
    expect(resolveLineageEdgeLabel("spawned_from", "outgoing")).toBe(
      "Spawned from"
    );
    expect(LINEAGE_EDGE_LABELS.spawned_from).toBeUndefined();
  });

  it("humanizes an uncurated edge or direction instead of leaking it", () => {
    expect(resolveLineageEdgeLabel("rerun", "incoming")).toBe("Rerun");
    expect(resolveLineageEdgeLabel("blocked_by", "incoming")).toBe(
      "Blocked by"
    );
    expect(resolveLineageEdgeLabel(null, "incoming")).toBe("");
  });
});

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

  it("`undo` and `reopen` are their own verbs with both moods — never `revert`, never the humanize fallback", () => {
    expect(resolveActionLabel("undo", "imperative")).toBe("Undo");
    expect(resolveActionLabel("undo", "past")).toBe("Undone");
    expect(resolveActionLabel("reopen", "imperative")).toBe("Reopen");
    expect(resolveActionLabel("reopen", "past")).toBe("Reopened");
    // `undo` (back to the queue) must never collapse into `revert` (into `reverted`).
    expect(resolveActionLabel("undo", "imperative")).not.toBe(
      resolveActionLabel("revert", "imperative")
    );
    // Both are REAL rows: the fallback ignores mood, so its past would equal its
    // imperative — the defect this row exists to prevent.
    expect(ACTION_VERBS.undo).toBeDefined();
    expect(ACTION_VERBS.reopen).toBeDefined();
  });

  it("`retry` is a real verb with both moods (a failed approval is retried, not approved again)", () => {
    expect(resolveActionLabel("retry", "imperative")).toBe("Retry");
    expect(resolveActionLabel("retry", "past")).toBe("Retried");
    expect(ACTION_VERBS.retry).toBeDefined();
  });

  it("`reverted` has one status label", () => {
    expect(resolveStatusLabel("reverted")).toBe("Reverted");
    expect(STATUS_LABELS.reverted).toBe("Reverted");
  });

  it("carries the pod hygiene verbs in both moods (retire is never a delete)", () => {
    // The cleanup pack's title and a retire receipt: the button asks, the
    // history reports. Unknown tokens humanize with NO tense, so without these
    // rows a settled retire would read "Retire".
    expect(resolveActionLabel("retire", "imperative")).toBe("Retire");
    expect(resolveActionLabel("retire", "past")).toBe("Retired");
    expect(resolveActionLabel("close", "past")).toBe("Closed");
    expect(resolveActionLabel("expire", "past")).toBe("Expired");
    expect(resolveActionLabel("pause", "past")).toBe("Paused");
    expect(resolveActionLabel("retire", "past")).not.toBe(
      resolveActionLabel("delete", "past")
    );
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
    // CP publish vocabulary → pod runtime vocabulary. A marketplace package of
    // this kind must not read "Workflow" in one surface and "Automation" in
    // another; before the alias, `workflow` humanized and missed the icon.
    expect(resolveObjectNoun("workflow")).toBe(resolveObjectNoun("automation"));
    expect(resolveObjectNoun("workflows")).toBe(
      resolveObjectNoun("automation")
    );
    expect(resolveObjectNoun("property_defs")).toBe("Property");
    expect(resolveObjectNoun("relation")).toBe("Link");
    expect(resolveObjectNoun("relations")).toBe("Link");
  });

  it("titles the backend-only kinds the registry does not model", () => {
    expect(resolveObjectNoun("relation_def")).toBe("Relation type");
    expect(resolveObjectNoun("api_key")).toBe("API key");
    expect(resolveObjectNoun("env_variable")).toBe("Environment variable");
  });

  it("re-checks OBJECT_NOUNS after aliasing, not just the raw key", () => {
    // The bug: `apikey` aliases to the canonical `api_key`, but the registry
    // has no `api_key` KIND (only OBJECT_NOUNS does) — so the resolver fell
    // straight to humanizeToken("api_key") = "Api key", even though
    // OBJECT_NOUNS["api_key"] === "API key" was sitting right there. This is
    // the exact failure `.claude/rules/vocabulary.md` cites as the reason
    // this SSOT exists.
    expect(resolveObjectNoun("apikey")).toBe("API key");
    expect(resolveObjectNoun("api_keys")).toBe("API key");
    expect(resolveObjectNoun("apikeys")).toBe("API key");
    expect(resolveObjectNounPlural("apikey")).toBe("API keys");
    expect(resolveObjectNounPlural("api_keys")).toBe("API keys");
    expect(resolveObjectNounPlural("apikeys")).toBe("API keys");
  });

  it("names the proactive-AI event domain, not the bare quality", () => {
    // humanizeToken("proactive") = "Proactive" loses the subject (the AI is
    // what's proactive) — curated rather than left to humanize.
    expect(resolveObjectNoun("proactive")).toBe("Proactive AI");
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
    "governance.structure_guideline",
    "governance.work_guideline",
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

  it("names the three tool-demand states (tool_request.tr_status)", () => {
    // `wanted` rides the humanize fallback; only `installable` needs a row.
    expect(resolveStatusLabel("wanted")).toBe("Wanted");
    expect(resolveStatusLabel("installable")).toBe("Ready to install");
    expect(resolveStatusLabel("connected")).toBe("Connected");
  });

  it("settles the failed/stale renderings for LIFECYCLE states", () => {
    expect(resolveStatusLabel("failed")).toBe("Failed");
    // Deliberately the neutral word: `stale` is overloaded across three domains
    // (session progress / sync freshness / broken binding), so a GLOBAL table
    // must not impose one reading.
    expect(resolveStatusLabel("stale")).toBe("Stale");
  });

  it("names session evaluation verdicts — unmeasured never reads as a failure", () => {
    // humanizeToken would say "Pass" (an imperative) and "Unmeasured".
    expect(resolveStatusLabel("pass")).toBe("Passed");
    expect(resolveStatusLabel("fail")).toBe("Failed");
    expect(resolveStatusLabel("unmeasured")).toBe("Not checked");
  });

  it("names session VERDICT STATES honestly for work still in flight", () => {
    // Without rows these humanized to "Passing" / "Failing" / "Incomplete":
    // "Failing" accuses unfinished work of having failed.
    expect(resolveStatusLabel("passing")).toBe("Met");
    expect(resolveStatusLabel("failing")).toBe("Not yet met");
    expect(resolveStatusLabel("incomplete")).toBe("Partly checked");
    // The state of the CONTRACT is a different fact from one criterion's
    // verdict, so the two never share a word.
    expect(resolveStatusLabel("failing")).not.toBe(resolveStatusLabel("fail"));
    expect(resolveStatusLabel("incomplete")).not.toBe(
      resolveStatusLabel("unmeasured")
    );
  });

  it("names every connection-sync phase (no humanized fallback)", () => {
    expect(resolveStatusLabel("fetching")).toBe("Fetching");
    expect(resolveStatusLabel("mapping")).toBe("Matching");
    // humanizeToken would say "Review ready" — a label about the mechanism.
    expect(resolveStatusLabel("review_ready")).toBe("Ready to review");
    expect(resolveStatusLabel("synced")).toBe("Synced");
    expect(resolveStatusLabel("failed")).toBe("Failed");
  });

  it("names external connection states", () => {
    expect(resolveStatusLabel("connected")).toBe("Connected");
    // humanizeToken would say "Disconnected" — a past event, not a state.
    expect(resolveStatusLabel("disconnected")).toBe("Not connected");
    expect(resolveStatusLabel("unavailable")).toBe("Not available");
  });

  it("curates not_connected, the one connection-status word surfaces map to", () => {
    // humanizeToken("not_connected") happens to spell the same words, so the
    // label alone cannot tell a curated row from the fallback. The row is the
    // contract: assert it exists, then that it reads like its twin.
    expect(
      Object.prototype.hasOwnProperty.call(STATUS_LABELS, "not_connected")
    ).toBe(true);
    expect(resolveStatusLabel("not_connected")).toBe("Not connected");
    expect(resolveStatusLabel("not_connected")).toBe(
      resolveStatusLabel("disconnected")
    );
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

  it("names `scheduled` explicitly, and keeps it distinct from `drafted`", () => {
    // Was reachable ONLY through the humanizeToken fallback, which exists to
    // stop a raw token leaking — not as an endorsement of the word.
    expect(STATUS_LABELS.scheduled).toBe("Scheduled");
    expect(resolveStatusLabel("scheduled")).toBe("Scheduled");
    // Two DIFFERENT pre-start ideas: `drafted` waits for a PERSON to accept a
    // suggestion; `scheduled` waits for a CLOCK. Collapsing them would replace
    // two correct strings with one wrong one — the same failure as collapsing
    // the two verb moods.
    expect(resolveStatusLabel("scheduled")).not.toBe(
      resolveStatusLabel("drafted")
    );
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
    "governance_structure_guideline",
    "governance_work_guideline",
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
    // humanizeToken would say "Governance structure guideline" — the mechanism,
    // not what the reviewer is being asked to adopt.
    expect(resolveProposalKindLabel("governance_structure_guideline")).toBe(
      "Extraction guideline"
    );
    expect(resolveProposalKindLabel("governance_work_guideline")).toBe(
      "Work guideline"
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
      "governance_structure_guideline",
      "governance_work_guideline",
      "capability_run",
      "automation_run",
    ]) {
      expect(PROPOSAL_KIND_LABELS[kind], kind).toBeTruthy();
    }
  });
});

describe("rerun — the intake run verb", () => {
  it("carries BOTH moods: the button says Rerun, the receipt says Reran", () => {
    expect(resolveActionLabel("rerun", "imperative")).toBe("Rerun");
    // humanizeToken ignores the mood and would put "Rerun" into a past-tense
    // history row — this assertion is what proves the table row exists.
    expect(resolveActionLabel("rerun", "past")).toBe("Reran");
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
 * row rendered "Complete Capture" — present-imperative, in the AI-coloured agent
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

describe("resolveObjectNounPlural", () => {
  it("uses the registry's curated plural, not singular + s", () => {
    // The three that prove the point: none is the singular plus "s".
    expect(resolveObjectNounPlural("person")).toBe("People");
    expect(resolveObjectNounPlural("company")).toBe("Companies");
    expect(resolveObjectNounPlural("entity")).toBe("Entities");
  });

  it("never returns the singular with a bare `s` for a registry kind", () => {
    // The defect this exists to prevent, asserted over the WHOLE registry
    // rather than the three examples above: a curated plural that happens to
    // equal singular+s is fine, but a kind falling through to that by accident
    // is not detectable here — so assert the resolver READ the registry.
    for (const [kind, def] of Object.entries(OBJECT_KINDS)) {
      expect(resolveObjectNounPlural(kind), kind).toBe(def.labelPlural);
    }
  });

  it("resolves aliases the same way the singular does", () => {
    expect(resolveObjectNounPlural("focus_session")).toBe(
      resolveObjectNounPlural("session")
    );
  });

  it("pluralises the backend-only tail and never leaks a raw token", () => {
    expect(resolveObjectNounPlural("api_key")).toBe("API keys");
    expect(resolveObjectNounPlural("some_new_thing")).toBe("Some new things");
    expect(resolveObjectNounPlural(null)).toBe("");
  });
});

describe("withdraw — the mood trap", () => {
  it("resolves BOTH moods, so a receipt never reads present-imperative", () => {
    // `STATUS_LABELS.withdrawn` existed but `ACTION_VERBS.withdraw` did not, so
    // `resolveActionLabel` fell through to `humanizeToken`, which ignores the
    // mood argument entirely and returned "Withdraw" for a PAST-tense receipt.
    // The browser's delegation sentence ("… withdrawn by Scout") had to
    // hand-write the literal to avoid it — which the vocabulary rule forbids.
    expect(resolveActionLabel("withdraw", "imperative")).toBe("Withdraw");
    expect(resolveActionLabel("withdraw", "past")).toBe("Withdrawn");
  });

  it("the two moods are DIFFERENT — the bug was them collapsing to one", () => {
    expect(resolveActionLabel("withdraw", "past")).not.toBe(
      resolveActionLabel("withdraw", "imperative")
    );
  });
});

describe("provenance — one label door over three forked DB enums", () => {
  /**
   * The coverage claim is DERIVED from the schema, never hand-listed. Three
   * columns spell the same idea differently (`ProvenanceKind` human|ai_agent|
   * system, `CellInstanceCreatedByKind` user|agent|system,
   * `messages.authorType` human|ai_agent|external|bot) and `generated.d.ts`
   * documents the fork as intentional. A hand-written list here would go stale
   * the day a fourth member lands — exactly the silent under-coverage this
   * repo has shipped before. So the members are parsed out of the schema.
   */
  const SCHEMA = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "database",
    "src",
    "schema"
  );

  /** Members of a `export type X = "a" | "b";` union in a schema file. */
  function unionMembers(file: string, typeName: string): string[] {
    const src = readFileSync(resolve(SCHEMA, file), "utf8");
    const re = new RegExp(`export type ${typeName} =([^;]*);`);
    const m = re.exec(src);
    // NON-VACUITY: a renamed/moved type must fail loudly rather than certify
    // an empty set.
    expect(m, `${typeName} not found in schema/${file}`).toBeTruthy();
    return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  }

  const provenanceKinds = unionMembers("provenance.ts", "ProvenanceKind");
  const cellKinds = unionMembers(
    "cell-instances.ts",
    "CellInstanceCreatedByKind"
  );
  // `messages.authorType` is a text column, not an exported union — its four
  // values are documented in the file's own header block, which is where the
  // fork is asserted. Pinned literally, with the file cited so a change is
  // findable.
  const messageAuthorTypes = ["human", "ai_agent", "external", "bot"];

  it("found real members to check", () => {
    expect(provenanceKinds.length).toBeGreaterThanOrEqual(3);
    expect(cellKinds.length).toBeGreaterThanOrEqual(3);
  });

  it("every DB provenance value has an EXPLICIT label, not a humanized guess", () => {
    const all = [...provenanceKinds, ...cellKinds, ...messageAuthorTypes];
    for (const value of all) {
      expect(
        PROVENANCE_LABELS[value],
        `${value} is a live DB provenance value with no row in PROVENANCE_LABELS`
      ).toBeTruthy();
      // `humanizeToken("ai_agent")` is "Ai agent" — the exact leak the table
      // exists to prevent. Assert the resolver did NOT fall through.
      expect(resolveProvenanceLabel(value)).toBe(PROVENANCE_LABELS[value]);
    }
  });

  it("the two spellings of one idea resolve to ONE word", () => {
    // The whole point: a user must never be able to tell from the screen
    // which table a row came out of.
    expect(resolveProvenanceLabel("human")).toBe(
      resolveProvenanceLabel("user")
    );
    expect(resolveProvenanceLabel("ai_agent")).toBe(
      resolveProvenanceLabel("agent")
    );
  });

  it("keeps genuinely different provenances DIFFERENT", () => {
    // `external` is a real person outside the pod; `bot` is an automated
    // message. Folding either into Person/AI agent destroys a real fact.
    const distinct = new Set([
      resolveProvenanceLabel("human"),
      resolveProvenanceLabel("ai_agent"),
      resolveProvenanceLabel("system"),
      resolveProvenanceLabel("external"),
      resolveProvenanceLabel("bot"),
    ]);
    expect(distinct.size).toBe(5);
  });

  it("never leaks a raw token, and says nothing for nothing", () => {
    expect(resolveProvenanceLabel("some_new_kind")).toBe("Some new kind");
    expect(resolveProvenanceLabel(null)).toBe("");
    expect(resolveProvenanceLabel(undefined)).toBe("");
    expect(resolveProvenanceLabel("")).toBe("");
  });
});

describe("resolveBlockedReasonLabel", () => {
  it("names all six blockers of the closed set", () => {
    expect(resolveBlockedReasonLabel("credential")).toBe("Credential missing");
    expect(resolveBlockedReasonLabel("permission")).toBe("Permission missing");
    expect(resolveBlockedReasonLabel("capability")).toBe("Capability missing");
    expect(resolveBlockedReasonLabel("policy")).toBe("Policy block");
    expect(resolveBlockedReasonLabel("decision")).toBe("Human decision");
    expect(resolveBlockedReasonLabel("physical")).toBe("Physical action");
  });

  it("keeps all six DISTINCT — the set exists to be grouped and counted", () => {
    const labels = new Set(Object.values(BLOCKED_REASON_LABELS));
    expect(labels.size).toBe(Object.keys(BLOCKED_REASON_LABELS).length);
  });

  it("does NOT read as the object kind of the same name", () => {
    // `capability` and `decision` are also OBJECT_NOUNS. A bare humanize would
    // render both tables identically, which is precisely the ambiguity this
    // table's phrasing exists to remove.
    expect(resolveBlockedReasonLabel("capability")).not.toBe(
      resolveObjectNoun("capability")
    );
    expect(resolveBlockedReasonLabel("decision")).not.toBe(
      resolveObjectNoun("decision")
    );
  });

  it("never leaks a raw token, and says nothing for nothing", () => {
    expect(resolveBlockedReasonLabel("some_new_blocker")).toBe(
      "Some new blocker"
    );
    expect(resolveBlockedReasonLabel(null)).toBe("");
    expect(resolveBlockedReasonLabel(undefined)).toBe("");
    expect(resolveBlockedReasonLabel("")).toBe("");
  });
});

describe("resolveNotificationCategoryLabel", () => {
  it("renders the acronym category correctly — the reason this table exists", () => {
    // `humanizeToken("ai")` returns "Ai"; a curated row is the only thing that
    // makes this right, and this assertion is what would catch its removal.
    expect(humanizeToken("ai")).toBe("Ai");
    expect(resolveNotificationCategoryLabel("ai")).toBe("AI");
  });

  it("labels every category the DB enum declares", () => {
    // Mirrors `NotificationCategory` in @synap/database (this package is
    // dependency-free, so the keys are mirrored rather than imported).
    for (const category of ["governance", "data", "ai", "system", "inbox"]) {
      const label = resolveNotificationCategoryLabel(category);
      expect(label, `no curated label for ${category}`).toBe(
        NOTIFICATION_CATEGORY_LABELS[category]
      );
      expect(label).not.toBe("");
    }
    expect(Object.keys(NOTIFICATION_CATEGORY_LABELS)).toHaveLength(5);
  });

  it("humanizes an unknown category rather than leaking the token", () => {
    expect(resolveNotificationCategoryLabel("release_train")).toBe(
      "Release train"
    );
  });

  it("returns an empty string for null/undefined", () => {
    expect(resolveNotificationCategoryLabel(null)).toBe("");
    expect(resolveNotificationCategoryLabel(undefined)).toBe("");
  });
});

describe("resolveNotificationRoutingRuleLabel", () => {
  it("fixes the two tokens humanizeToken gets wrong — the reason this table exists", () => {
    // Both of these are what a settings picker would show without a curated
    // row. They are the discriminating cases: `all` and `mute` would survive a
    // naive humanize, these two would not.
    expect(humanizeToken("in_app")).toBe("In app");
    expect(humanizeToken("os")).toBe("Os");
    expect(resolveNotificationRoutingRuleLabel("in_app")).toBe("In-app only");
    expect(resolveNotificationRoutingRuleLabel("os")).toBe("Push only");
  });

  it("labels every rule the catalogue can offer", () => {
    // Mirrors the offerable set in `notifications/catalogue.ts`. `telegram` is
    // deliberately NOT here — see the table's docblock.
    for (const rule of ["all", "os", "in_app", "mute"]) {
      const label = resolveNotificationRoutingRuleLabel(rule);
      expect(label, `no curated label for ${rule}`).toBe(
        NOTIFICATION_ROUTING_RULE_LABELS[rule]
      );
      expect(label).not.toBe("");
      expect(label).not.toBe(rule);
    }
    expect(Object.keys(NOTIFICATION_ROUTING_RULE_LABELS)).toHaveLength(4);
  });

  it("humanizes a transport-less or unknown rule rather than leaking it", () => {
    // `telegram` is a legal column value with no transport. If it ever reaches
    // a surface it must read as a word, not as a raw token — and it must NOT
    // have a curated label implying it works.
    expect(NOTIFICATION_ROUTING_RULE_LABELS.telegram).toBeUndefined();
    expect(resolveNotificationRoutingRuleLabel("telegram")).toBe("Telegram");
    expect(resolveNotificationRoutingRuleLabel("email_digest")).toBe(
      "Email digest"
    );
  });

  it("returns an empty string for null/undefined", () => {
    expect(resolveNotificationRoutingRuleLabel(null)).toBe("");
    expect(resolveNotificationRoutingRuleLabel(undefined)).toBe("");
  });
});

describe("track — a method running inside a project (0272)", () => {
  it("is a registry kind with its own identity, not a humanized token", () => {
    expect(OBJECT_KINDS.track?.label).toBe("Track");
    expect(OBJECT_KINDS.track?.icon).not.toBe(FALLBACK_ICON);
    expect(resolveObjectNounPlural("track")).toBe("Tracks");
  });
  it("the table name resolves to the same noun (not 'Project track')", () => {
    // Discriminating: without the alias rows `humanizeToken` renders
    // "Project track" / "Project tracks".
    expect(resolveObjectNoun("project_track")).toBe("Track");
    expect(resolveObjectNoun("project_tracks")).toBe("Track");
    expect(
      buildObjectActionTitle({
        action: "create",
        objectKind: "project_track",
        objectName: "Content",
      })
    ).toBe('Create Track "Content"');
  });
});
