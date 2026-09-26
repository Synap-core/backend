/**
 * Sites W5a — the sharing vocabulary rows.
 *
 * Every assertion below is one the humanize FALLBACK would fail, so each row is
 * proven to exist (not merely to spell what `humanizeToken` happens to spell):
 *   - a past-mood verb: the fallback ignores mood and returns the imperative;
 *   - "Share link": the fallback on `share_link` would say "Share link" too, so
 *     that row is pinned by its DIFFERENCE from the relation noun instead;
 *   - "Shared by link" / "Held for your review" / "Added immediately": the
 *     fallback would say "Link" / "Proposal" / "Direct".
 */
import { describe, it, expect } from "vitest";
import {
  ACTION_VERBS,
  OBJECT_KINDS,
  OBJECT_KIND_ALIASES,
  OBJECT_NOUNS,
  PROVENANCE_LABELS,
  STATUS_LABELS,
  SUBMISSION_OUTCOME_LABELS,
  humanizeToken,
  normalizeObjectKind,
  resolveActionLabel,
  resolveObjectNoun,
  resolveProvenanceLabel,
  resolveStatusLabel,
  resolveSubmissionOutcomeLabel,
} from "./index.js";

describe("sharing verbs carry BOTH moods", () => {
  const VERBS: Array<[string, string, string]> = [
    ["share", "Share", "Shared"],
    ["unshare", "Unshare", "Unshared"],
    ["publish", "Publish", "Published"],
    ["unpublish", "Unpublish", "Unpublished"],
    ["revoke", "Revoke", "Revoked"],
    ["redeem", "Redeem", "Redeemed"],
    ["expire", "Expire", "Expired"],
  ];
  it.each(VERBS)("%s → %s / %s", (token, imperative, past) => {
    expect(ACTION_VERBS[token], token).toBeDefined();
    expect(resolveActionLabel(token, "imperative")).toBe(imperative);
    expect(resolveActionLabel(token, "past")).toBe(past);
    // The fallback ignores mood — a past that differs from it proves the row.
    expect(resolveActionLabel(token, "past")).not.toBe(humanizeToken(token));
  });

  it("dotted proposal types resolve on their last segment", () => {
    expect(resolveActionLabel("share.revoke", "past")).toBe("Revoked");
  });

  it("revoke (permanent) never reads as unshare (reversible)", () => {
    expect(resolveActionLabel("revoke", "past")).not.toBe(
      resolveActionLabel("unshare", "past")
    );
  });
});

describe("sharing nouns — a share link is not a relation link", () => {
  it("share_link, link and relation resolve to the words they mean", () => {
    expect(resolveObjectNoun("share_link")).toBe("Share link");
    expect(resolveObjectNoun("link")).toBe("Link");
    expect(resolveObjectNoun("relation")).toBe("Link");
    expect(resolveObjectNoun("share_link")).not.toBe(resolveObjectNoun("link"));
  });

  it("no alias collapses one onto the other", () => {
    expect(OBJECT_KIND_ALIASES.share_link).toBeUndefined();
    expect(OBJECT_KIND_ALIASES.share_links).toBeUndefined();
    expect(normalizeObjectKind("share_links")).toBe("share_link");
    expect(normalizeObjectKind("relations")).toBe("link");
    for (const [from, to] of Object.entries(OBJECT_KIND_ALIASES)) {
      if (to === "link") expect(from, from).not.toMatch(/share/);
    }
  });

  it("guest, form and submission have rows and shadow no registry kind", () => {
    for (const [key, noun] of [
      ["guest", "Guest"],
      ["form", "Form"],
      ["submission", "Submission"],
      ["share_link", "Share link"],
    ] as const) {
      expect(OBJECT_NOUNS[key], key).toBe(noun);
      expect(OBJECT_KINDS[key], key).toBeUndefined();
      expect(resolveObjectNoun(key)).toBe(noun);
    }
  });
});

describe("sharing statuses", () => {
  it.each([
    ["published", "Published"],
    ["draft", "Draft"],
    ["revoked", "Revoked"],
    ["expired", "Expired"],
    ["private", "Private"],
    ["shared", "Shared"],
    ["public", "Public"],
  ])("%s → %s", (token, label) => {
    expect(STATUS_LABELS[token], token).toBe(label);
    expect(resolveStatusLabel(token)).toBe(label);
  });

  it("the `link` share state never reads as the relation noun", () => {
    expect(resolveStatusLabel("link")).toBe("Shared by link");
    expect(resolveStatusLabel("link")).not.toBe(resolveObjectNoun("link"));
  });
});

describe("guest provenance", () => {
  it("a guest is its own word — never 'AI agent'", () => {
    expect(PROVENANCE_LABELS.guest).toBe("Guest");
    expect(resolveProvenanceLabel("guest")).not.toBe(
      resolveProvenanceLabel("ai_agent")
    );
    expect(resolveProvenanceLabel("guest")).not.toBe(
      resolveProvenanceLabel("human")
    );
  });
});

describe("submission outcome (per form mode)", () => {
  it("names the consequence, not the mechanism", () => {
    expect(resolveSubmissionOutcomeLabel("proposal")).toBe(
      "Held for your review"
    );
    expect(resolveSubmissionOutcomeLabel("direct")).toBe("Added immediately");
    expect(Object.keys(SUBMISSION_OUTCOME_LABELS).sort()).toEqual([
      "direct",
      "proposal",
    ]);
  });

  it("an unknown mode humanizes; nothing says nothing", () => {
    expect(resolveSubmissionOutcomeLabel("some_mode")).toBe("Some mode");
    expect(resolveSubmissionOutcomeLabel(null)).toBe("");
  });
});
