/**
 * summarizeGrant for a holder that is not a plain key (an agent: more
 * subjects, reads never refused), and describeKeyAccess — the ONE wording of
 * a key list's three access states. Each row names the wrong rule it rules out.
 */
import { describe, expect, it } from "vitest";
import { resolveObjectNounPlural } from "../vocabulary/index.js";
import {
  AGENT_ALWAYS_ALLOWED,
  AGENT_GRANT_CATALOG,
  describeKeyAccess,
  KEY_ACCESS_ENDED_SENTENCE,
  KEY_ACCESS_UNGRANTED_SENTENCE,
  summarizeGrant,
  type GrantDraft,
} from "./index.js";

const draft = (...permissions: string[]): GrantDraft => ({ permissions });
const agent = {
  catalog: AGENT_GRANT_CATALOG,
  alwaysAllowed: AGENT_ALWAYS_ALLOWED,
};

describe("summarizeGrant — an agent's catalog", () => {
  // Rules out: the summary reading only GRANT_SUBJECT_CATALOG, so an agent's
  // building subjects fall into "other" and read "+1 more".
  it("names agent-only subjects instead of counting them as other", () => {
    const s = summarizeGrant(draft("profile.create"), {
      catalog: AGENT_GRANT_CATALOG,
    });
    expect(s.other).toEqual([]);
    expect(s.rows.map((r) => r.subject)).toEqual(["profile"]);
    expect(s.what).toBe(`Create ${resolveObjectNounPlural("profile")}`);
    expect(s.what).not.toContain("more");
  });
  it("without the catalog the same pattern is other (the default is unchanged)", () => {
    expect(summarizeGrant(draft("profile.create")).other).toEqual([
      "profile.create",
    ]);
  });
});

describe("summarizeGrant — always-allowed actions", () => {
  // Rules out: "No access" for an agent that reads everything its person reads.
  it("nothing granted reads as the always-allowed actions only", () => {
    expect(summarizeGrant(draft(), agent).what).toBe("Read only");
  });
  // Rules out: a read-only preset listing reads the agent always had.
  it("granted reads add nothing to the sentence", () => {
    expect(
      summarizeGrant(draft("entity.*.read", "document.read"), agent).what
    ).toBe("Read only");
  });
  // Rules out: the sentence dropping the always-allowed part once writes exist.
  it("writes follow 'Read everything'", () => {
    expect(
      summarizeGrant(draft("entity.*.read", "profile.create"), agent).what
    ).toBe(`Read everything; Create ${resolveObjectNounPlural("profile")}`);
  });
  it("full access still reads as full access", () => {
    expect(summarizeGrant(draft("*"), agent).what).toBe("Full access");
  });
  it("without the option an empty grant is still No access", () => {
    expect(summarizeGrant(draft()).what).toBe("No access");
  });
});

describe("describeKeyAccess", () => {
  const grant = (
    over: Partial<GrantDraft> & { expiresAt?: string | null } = {}
  ) => ({
    permissions: ["document.read"],
    workspaceIds: null,
    projectIds: null,
    entityIds: null,
    label: null,
    expiresAt: null,
    ...over,
  });

  // Rules out: an ungranted key reading as calm "no grant".
  it("ungranted is full access, flagged", () => {
    const d = describeKeyAccess({ access: "ungranted", grants: [] });
    expect(d).toMatchObject({ full: true, ended: false, lines: [] });
    expect(d.sentence).toBe(KEY_ACCESS_UNGRANTED_SENTENCE);
    expect(d.sentence).toBe("Full access: everything its scopes allow");
  });
  // Rules out: an ended key falling back to "ungranted" (= full access).
  it("ended touches nothing", () => {
    const d = describeKeyAccess({ access: "ended", grants: [] });
    expect(d).toMatchObject({ full: false, ended: true });
    expect(d.sentence).toBe(KEY_ACCESS_ENDED_SENTENCE);
    expect(d.sentence).toBe("Can touch nothing: its access ended");
  });
  // Rules out: reading only the newest grant (`grant`) of a key holding a set.
  it("granted gives one line per live grant, each with its own expiry", () => {
    const d = describeKeyAccess({
      access: "granted",
      grants: [
        grant({ label: "Site", expiresAt: "2099-01-12T12:00:00Z" }),
        grant({ permissions: ["view.read"], workspaceIds: ["w1"] }),
      ],
    });
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0].label).toBe("Site");
    expect(d.lines[0].summary.when).toBe("Until 12 Jan 2099");
    expect(d.lines[1].summary.when).toBe("Never expires");
    expect(d.sentence).toContain("Site: Read");
    expect(d.sentence).toContain(resolveObjectNounPlural("view"));
    expect(d.full).toBe(false);
  });
  it("a live * grant is flagged full", () => {
    expect(
      describeKeyAccess({
        access: "granted",
        grants: [grant({ permissions: ["*"] })],
      }).full
    ).toBe(true);
  });
});
