import { describe, expect, it } from "vitest";
import {
  ERROR_MARK,
  REVOKED_MARK,
  chartMark,
  chartModeLabel,
  collectionLabel,
  linkPrefixLabel,
  memberMark,
  orderSites,
  siteDataAddress,
  siteMark,
  sitePrimaryAction,
  siteRowFacts,
  type SiteFacts,
} from "./site-model";

const LIVE: SiteFacts = {
  state: "published",
  live: true,
  hasToken: true,
  publicDoorsOpen: true,
  policyAllowsSites: true,
  staleCount: 0,
};
const NEW_SITE: SiteFacts = {
  ...LIVE,
  state: "draft",
  live: false,
  hasToken: false,
};
const OFF_WEB: SiteFacts = { ...LIVE, state: "draft", live: false };

describe("siteMark: every state of a site", () => {
  it("live, nothing waiting → Live (a chip on the list too)", () => {
    expect(siteMark(LIVE)).toMatchObject({
      key: "live",
      kind: "healthy",
      label: "Live",
      needsYou: false,
    });
  });

  it("live with changed records → N records changed, needs you", () => {
    expect(siteMark({ ...LIVE, staleCount: 1 })).toMatchObject({
      key: "changed",
      kind: "stale",
      label: "1 record changed",
      needsYou: true,
    });
    expect(siteMark({ ...LIVE, staleCount: 4 }).label).toBe(
      "4 records changed"
    );
  });

  it("live behind closed public pages → Public pages off, outranks changed records", () => {
    expect(
      siteMark({ ...LIVE, publicDoorsOpen: false, staleCount: 3 })
    ).toMatchObject({ key: "doors-off", kind: "down", needsYou: true });
  });

  it("an unreadable switch (not the owner) is never 'on' and never 'off': the site's own state shows", () => {
    expect(siteMark({ ...LIVE, publicDoorsOpen: null }).key).toBe("live");
    expect(siteMark({ ...NEW_SITE, publicDoorsOpen: null }).key).toBe(
      "not-live"
    );
  });

  it("never put live → Not live yet, needs you", () => {
    expect(siteMark(NEW_SITE)).toMatchObject({
      key: "not-live",
      kind: "unknown",
      needsYou: true,
    });
  });

  it("taken off the web (link kept) → Off the web, the person's own choice", () => {
    expect(siteMark(OFF_WEB)).toMatchObject({
      key: "off-web",
      kind: "unknown",
      needsYou: false,
    });
  });

  it("not live and the policy blocks sites → Sites not allowed, before anything else", () => {
    for (const s of [NEW_SITE, OFF_WEB]) {
      expect(siteMark({ ...s, policyAllowsSites: false })).toMatchObject({
        key: "policy-blocks",
        kind: "down",
        needsYou: true,
      });
    }
  });

  it("a policy tightened after going live does not take the site down: still Live", () => {
    expect(siteMark({ ...LIVE, policyAllowsSites: false }).key).toBe("live");
  });

  it("a failed read and a revoke are their own marks", () => {
    expect(ERROR_MARK).toMatchObject({ key: "error", kind: "down" });
    expect(REVOKED_MARK).toMatchObject({ key: "revoked", kind: "down" });
  });
});

describe("sitePrimaryAction", () => {
  it("Put live when never live, Put back live when the link is kept, none when live", () => {
    expect(sitePrimaryAction(NEW_SITE)).toBe("put-live");
    expect(sitePrimaryAction(OFF_WEB)).toBe("put-back-live");
    expect(sitePrimaryAction(LIVE)).toBeNull();
  });

  it("no button when the policy would refuse it (absent, never disabled)", () => {
    expect(
      sitePrimaryAction({ ...NEW_SITE, policyAllowsSites: false })
    ).toBeNull();
    // Unreadable policy: offer it; the server is the judge.
    expect(sitePrimaryAction({ ...NEW_SITE, policyAllowsSites: null })).toBe(
      "put-live"
    );
  });
});

describe("siteRowFacts and orderSites", () => {
  const counts = { recordsTotal: 24, chartsTotal: 3 };
  it("says what the site holds, then what is wrong", () => {
    expect(siteRowFacts({ ...LIVE, ...counts })).toEqual([
      "24 records",
      "3 charts",
    ]);
    expect(
      siteRowFacts({ ...NEW_SITE, recordsTotal: 1, chartsTotal: 0 })
    ).toEqual(["Set up", "1 record"]);
    expect(
      siteRowFacts({ ...LIVE, publicDoorsOpen: false, ...counts })
    ).toEqual(["24 records", "3 charts", "visitors are refused"]);
  });

  it("puts what needs the person first, otherwise keeps the server's order", () => {
    const a = { ...LIVE, id: "a" };
    const b = { ...NEW_SITE, id: "b" };
    const c = { ...OFF_WEB, id: "c" };
    const d = { ...LIVE, staleCount: 2, id: "d" };
    expect(orderSites([a, b, c, d]).map((s) => s.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });
});

describe("memberMark and chartMark", () => {
  it("a record: taken off, changed, not shown, or no pill", () => {
    expect(
      memberMark({ state: "draft", live: false, stale: true }, true)
    ).toEqual({ kind: "unknown", label: "Taken off" });
    expect(
      memberMark({ state: "published", live: true, stale: true }, true)
    ).toEqual({ kind: "stale", label: "Changed since published" });
    expect(
      memberMark({ state: "published", live: false, stale: false }, true)
    ).toEqual({ kind: "stale", label: "Not shown" });
    expect(
      memberMark({ state: "published", live: true, stale: false }, true)
    ).toBeNull();
    // The site is not live: the header says so, the rows stay quiet.
    expect(
      memberMark({ state: "published", live: false, stale: false }, false)
    ).toBeNull();
  });

  it("a chart: taken off, not shown, or no pill", () => {
    expect(chartMark({ state: "draft", live: false }, true)).toEqual({
      kind: "unknown",
      label: "Taken off",
    });
    expect(chartMark({ state: "published", live: false }, true)).toEqual({
      kind: "stale",
      label: "Not shown",
    });
    expect(chartMark({ state: "published", live: true }, true)).toBeNull();
    expect(chartModeLabel("snapshot")).toBe("Snapshot");
    expect(chartModeLabel("live")).toBe("Live data");
    expect(chartModeLabel(null)).toBe("Unreadable");
  });
});

describe("labels and the link", () => {
  it("never shows a raw collection key or @charts", () => {
    expect(collectionLabel("@charts")).toBeNull();
    expect(collectionLabel(null)).toBeNull();
    const label = collectionLabel("event");
    expect(label).toBeTruthy();
    expect(label).not.toBe("event");
  });

  it("builds the data address from the pod url and the token", () => {
    expect(siteDataAddress("https://pod.example/", "Ab12Cd")).toBe(
      "https://pod.example/api/hub/public/sites/Ab12Cd"
    );
    expect(linkPrefixLabel("Ab12Cd")).toBe("…/sites/Ab12Cd…");
    expect(linkPrefixLabel(null)).toBeNull();
  });
});
