import { describe, expect, it } from "vitest";
import {
  dispatchOpen,
  inferOpenTypeFromId,
  isSafeOpenId,
  isUnfurlBot,
  podAdminTarget,
} from "./open-dispatch.js";

const ADMIN = "https://pod-admin.example.test";
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const DISCORDBOT =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const HUMAN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0";

describe("isUnfurlBot", () => {
  it("treats empty UA as human", () => {
    expect(isUnfurlBot(undefined)).toBe(false);
    expect(isUnfurlBot(null)).toBe(false);
    expect(isUnfurlBot("")).toBe(false);
  });

  it("matches common unfurlers case-insensitively", () => {
    expect(isUnfurlBot(DISCORDBOT)).toBe(true);
    expect(isUnfurlBot("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(isUnfurlBot("facebookexternalhit/1.1")).toBe(true);
    expect(isUnfurlBot("Twitterbot/1.0")).toBe(true);
  });

  it("does not treat in-app chat browsers as crawlers", () => {
    expect(isUnfurlBot(HUMAN)).toBe(false);
    expect(
      isUnfurlBot("Mozilla/5.0 (Macintosh) Slack/4.36.0 Slack_SSB/4.36.0")
    ).toBe(false);
    expect(
      isUnfurlBot("Mozilla/5.0 (Macintosh) discord/1.0.9000 Chrome/120.0.0.0")
    ).toBe(false);
  });
});

describe("isSafeOpenId / inferOpenTypeFromId", () => {
  it("accepts UUIDs, keywords, and generated cell typeKeys", () => {
    expect(isSafeOpenId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(isSafeOpenId("proposals")).toBe(true);
    expect(isSafeOpenId("generated:product-development-board")).toBe(true);
    expect(isSafeOpenId("generated:dogfood-test-cell-1783097951")).toBe(true);
    expect(isSafeOpenId("generated%3Aproduct-development-board")).toBe(true);
  });

  it("rejects HTML / path metacharacters", () => {
    expect(isSafeOpenId("generated:<script>")).toBe(false);
    expect(isSafeOpenId("../etc/passwd")).toBe(false);
    expect(isSafeOpenId("generated:foo/bar")).toBe(false);
    expect(isSafeOpenId("")).toBe(false);
  });

  it("treats generated: tokens as cells", () => {
    expect(inferOpenTypeFromId("generated:product-development-board")).toBe(
      "cell"
    );
    expect(inferOpenTypeFromId("proposals")).toBeUndefined();
    expect(inferOpenTypeFromId(ID)).toBeUndefined();
  });
});

describe("podAdminTarget", () => {
  it("builds proposal vs entity/view paths against the admin base", () => {
    expect(podAdminTarget("proposal", ID, ADMIN)).toBe(
      `${ADMIN}/proposal/${ID}`
    );
    expect(podAdminTarget("entity", ID, ADMIN)).toBe(
      `${ADMIN}/open/entity/${ID}`
    );
    expect(podAdminTarget("view", ID, ADMIN)).toBe(`${ADMIN}/open/view/${ID}`);
  });
});

describe("dispatchOpen", () => {
  it("proposal + admin → /proposal/ (even with Discordbot UA)", () => {
    expect(
      dispatchOpen({
        type: "proposal",
        id: ID,
        userAgent: DISCORDBOT,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "redirect",
      url: `${ADMIN}/proposal/${ID}`,
    });
  });

  it("entity + human + admin → /open/entity/", () => {
    expect(
      dispatchOpen({
        type: "entity",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "redirect",
      url: `${ADMIN}/open/entity/${ID}`,
    });
  });

  it("entity + Discordbot + admin → bounce synap://open/entity/", () => {
    expect(
      dispatchOpen({
        type: "entity",
        id: ID,
        userAgent: DISCORDBOT,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "bounce",
      deep: `synap://open/entity/${ID}`,
    });
  });

  it("view + human + admin → /open/view/", () => {
    expect(
      dispatchOpen({
        type: "view",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "redirect",
      url: `${ADMIN}/open/view/${ID}`,
    });
  });

  it("view + no adminBase → bounce", () => {
    expect(
      dispatchOpen({
        type: "view",
        id: ID,
        userAgent: HUMAN,
        adminBase: null,
      })
    ).toEqual({
      action: "bounce",
      deep: `synap://open/view/${ID}`,
    });
  });

  it("channel + human + admin → bounce (not 302)", () => {
    expect(
      dispatchOpen({
        type: "channel",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "bounce",
      deep: `synap://open/channel/${ID}`,
    });
  });

  it("undefined type → bounce synap://open/<id>", () => {
    expect(
      dispatchOpen({
        type: undefined,
        id: "proposals",
        userAgent: HUMAN,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "bounce",
      deep: "synap://open/proposals",
    });
  });

  it("cell typeKey + human + admin → bounce synap://open/cell/<typeKey>", () => {
    expect(
      dispatchOpen({
        type: "cell",
        id: "generated:product-development-board",
        userAgent: HUMAN,
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "bounce",
      deep: "synap://open/cell/generated:product-development-board",
    });
  });

  it("empty UA on entity → redirect (human)", () => {
    expect(
      dispatchOpen({
        type: "entity",
        id: ID,
        userAgent: "",
        adminBase: ADMIN,
      })
    ).toEqual({
      action: "redirect",
      url: `${ADMIN}/open/entity/${ID}`,
    });
  });
});
