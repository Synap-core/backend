import { describe, expect, it } from "vitest";
import {
  dispatchOpen,
  inferOpenTypeFromId,
  isSafeOpenId,
  isMobileClient,
  isOpenFlowTypeValue,
  isOpenViewValue,
  isUnfurlBot,
  OPEN_CLIENT_MOBILE,
  podAdminBrowserUrl,
  podAdminResolveTarget,
  podAdminTarget,
  TYPED_OPEN_KINDS,
  WEB_HOSTED_OPEN_KINDS,
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
    expect(podAdminTarget("automation", ID, ADMIN)).toBe(
      `${ADMIN}/open/automation/${ID}`
    );
    expect(podAdminTarget("session", ID, ADMIN)).toBe(
      `${ADMIN}/open/session/${ID}`
    );
  });

  it("builds the resolver page for an untyped id", () => {
    expect(podAdminResolveTarget(ID, ADMIN)).toBe(`${ADMIN}/open/${ID}`);
  });
});

describe("podAdminBrowserUrl (the bounce page's 'View in browser')", () => {
  it.each(["proposal", "entity", "view", "automation", "session"])(
    "%s → its pod-admin page",
    (type) => {
      expect(podAdminBrowserUrl(type, ID, ADMIN)).toBe(
        type === "proposal"
          ? `${ADMIN}/proposal/${ID}`
          : `${ADMIN}/open/${type}/${ID}`
      );
    }
  );

  it("an untyped uuid → the resolver page; a keyword or bounce kind → none", () => {
    expect(podAdminBrowserUrl(undefined, ID, ADMIN)).toBe(
      `${ADMIN}/open/${ID}`
    );
    expect(podAdminBrowserUrl(undefined, "proposals", ADMIN)).toBeUndefined();
    expect(podAdminBrowserUrl("channel", ID, ADMIN)).toBeUndefined();
  });

  it("no pod-admin → no escape link", () => {
    expect(podAdminBrowserUrl("entity", ID, null)).toBeUndefined();
  });
});

describe("hosted kinds match pod-admin", () => {
  it("WEB_HOSTED_OPEN_KINDS ⊆ TYPED_OPEN_KINDS", () => {
    for (const kind of WEB_HOSTED_OPEN_KINDS) {
      expect(TYPED_OPEN_KINDS as readonly string[]).toContain(kind);
    }
  });
});

describe("dispatchOpen — automation / session are web-hosted", () => {
  it.each(["automation", "session"])(
    "%s + human + admin → pod-admin /open/%s/",
    (type) => {
      expect(
        dispatchOpen({ type, id: ID, userAgent: HUMAN, adminBase: ADMIN })
      ).toEqual({ action: "redirect", url: `${ADMIN}/open/${type}/${ID}` });
    }
  );

  it.each(["automation", "session"])(
    "%s + Discordbot → bounce (bodies never reach an unfurler)",
    (type) => {
      expect(
        dispatchOpen({ type, id: ID, userAgent: DISCORDBOT, adminBase: ADMIN })
      ).toEqual({ action: "bounce", deep: `synap://open/${type}/${ID}` });
    }
  );

  it.each(["automation", "session"])(
    "%s + ?client=mobile → bounce to relay",
    (type) => {
      expect(
        dispatchOpen({
          type,
          id: ID,
          userAgent: HUMAN,
          adminBase: ADMIN,
          client: OPEN_CLIENT_MOBILE,
        })
      ).toEqual({ action: "bounce", deep: `synap://open/${type}/${ID}` });
    }
  );

  it("session + view=room on desktop → still bounces WITH the view (the Intake Room is app-only)", () => {
    expect(
      dispatchOpen({
        type: "session",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        view: "room",
      })
    ).toEqual({
      action: "bounce",
      deep: `synap://open/session/${ID}?view=room`,
    });
  });

  it("session + an unrecognised view is the plain session → hosted", () => {
    expect(
      dispatchOpen({
        type: "session",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        view: "evil",
      })
    ).toEqual({ action: "redirect", url: `${ADMIN}/open/session/${ID}` });
  });
});

describe("dispatchOpen — playbook / run / capability / agent are web-hosted", () => {
  it.each(["playbook", "run", "capability", "agent"])(
    "%s + human + admin → pod-admin /open/%s/",
    (type) => {
      expect(
        dispatchOpen({ type, id: ID, userAgent: HUMAN, adminBase: ADMIN })
      ).toEqual({ action: "redirect", url: `${ADMIN}/open/${type}/${ID}` });
    }
  );

  it.each(["playbook", "run", "capability", "agent"])(
    "%s + Discordbot → bounce (bodies never reach an unfurler)",
    (type) => {
      expect(
        dispatchOpen({ type, id: ID, userAgent: DISCORDBOT, adminBase: ADMIN })
      ).toEqual({ action: "bounce", deep: `synap://open/${type}/${ID}` });
    }
  );
});

describe("dispatchOpen — a run keeps its ?flowType=", () => {
  it("human → the web page WITH the flow type", () => {
    expect(
      dispatchOpen({
        type: "run",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        flowType: "playbook",
      })
    ).toEqual({
      action: "redirect",
      url: `${ADMIN}/open/run/${ID}?flowType=playbook`,
    });
  });

  it("bot or phone → the app link WITH the flow type", () => {
    for (const opts of [
      { userAgent: DISCORDBOT },
      { userAgent: HUMAN, client: OPEN_CLIENT_MOBILE },
      { userAgent: HUMAN, adminBaseless: true },
    ]) {
      expect(
        dispatchOpen({
          type: "run",
          id: ID,
          userAgent: opts.userAgent,
          adminBase: "adminBaseless" in opts ? null : ADMIN,
          client: "client" in opts ? opts.client : undefined,
          flowType: "agent_write",
        })
      ).toEqual({
        action: "bounce",
        deep: `synap://open/run/${ID}?flowType=agent_write`,
      });
    }
  });

  it("an unknown flow type is dropped, never forwarded", () => {
    expect(
      dispatchOpen({
        type: "run",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        flowType: "playbook&evil=1",
      })
    ).toEqual({ action: "redirect", url: `${ADMIN}/open/run/${ID}` });
    expect(isOpenFlowTypeValue("nope")).toBe(false);
    expect(isOpenFlowTypeValue(undefined)).toBe(false);
  });

  it("a flow type on any other kind is dropped", () => {
    expect(
      dispatchOpen({
        type: "entity",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        flowType: "playbook",
      })
    ).toEqual({ action: "redirect", url: `${ADMIN}/open/entity/${ID}` });
    expect(
      dispatchOpen({
        type: "channel",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        flowType: "playbook",
      })
    ).toEqual({ action: "bounce", deep: `synap://open/channel/${ID}` });
  });

  it("the bounce page's browser link keeps it too", () => {
    expect(podAdminBrowserUrl("run", ID, ADMIN, "playbook")).toBe(
      `${ADMIN}/open/run/${ID}?flowType=playbook`
    );
    expect(podAdminBrowserUrl("run", ID, ADMIN, "bogus")).toBe(
      `${ADMIN}/open/run/${ID}`
    );
  });
});

describe("dispatchOpen — untyped uuid (bare /open/<id> the probe could not type)", () => {
  it("human + admin → pod-admin's resolver page", () => {
    expect(
      dispatchOpen({
        type: undefined,
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
      })
    ).toEqual({ action: "redirect", url: `${ADMIN}/open/${ID}` });
  });

  it("bot, mobile, or no pod-admin → the untyped bounce, as before", () => {
    const bounce = { action: "bounce", deep: `synap://open/${ID}` };
    expect(
      dispatchOpen({
        type: undefined,
        id: ID,
        userAgent: DISCORDBOT,
        adminBase: ADMIN,
      })
    ).toEqual(bounce);
    expect(
      dispatchOpen({
        type: undefined,
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        client: OPEN_CLIENT_MOBILE,
      })
    ).toEqual(bounce);
    expect(
      dispatchOpen({
        type: undefined,
        id: ID,
        userAgent: HUMAN,
        adminBase: null,
      })
    ).toEqual(bounce);
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

// ---------------------------------------------------------------------------
// The mobile branch. Four invariants, one test each — a device-flavoured link
// must open the phone app WITHOUT weakening any of the three behaviours that
// were already load-bearing.
// ---------------------------------------------------------------------------

describe("isMobileClient", () => {
  it("only the exact mobile token counts", () => {
    expect(isMobileClient(OPEN_CLIENT_MOBILE)).toBe(true);
    expect(isMobileClient("desktop")).toBe(false);
    expect(isMobileClient("Mobile")).toBe(false);
    expect(isMobileClient("")).toBe(false);
    expect(isMobileClient(undefined)).toBe(false);
    expect(isMobileClient(null)).toBe(false);
  });
});

describe("dispatchOpen — ?client=mobile", () => {
  // INVARIANT 1 — the feature itself.
  it("proposal + mobile + admin → bounce synap://open/proposal/", () => {
    expect(
      dispatchOpen({
        type: "proposal",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        client: OPEN_CLIENT_MOBILE,
      })
    ).toEqual({
      action: "bounce",
      deep: `synap://open/proposal/${ID}`,
    });
  });

  // INVARIANT 2 — a desktop browser still 302s to pod-admin. Absent param and
  // any non-mobile value both mean desktop.
  it("proposal without the param (and with a foreign one) still 302s", () => {
    for (const client of [undefined, null, "", "desktop"]) {
      expect(
        dispatchOpen({
          type: "proposal",
          id: ID,
          userAgent: HUMAN,
          adminBase: ADMIN,
          client,
        })
      ).toEqual({
        action: "redirect",
        url: `${ADMIN}/proposal/${ID}`,
      });
    }
  });

  // INVARIANT 3 — an unfurl bot NEVER takes the mobile branch. A crawler
  // following a `?client=mobile` proposal link must behave exactly as it does
  // without the param: 302 to the web review page, never a `synap://` bounce.
  it("proposal + mobile + Discordbot → still 302 (bot beats the flag)", () => {
    expect(
      dispatchOpen({
        type: "proposal",
        id: ID,
        userAgent: DISCORDBOT,
        adminBase: ADMIN,
        client: OPEN_CLIENT_MOBILE,
      })
    ).toEqual({
      action: "redirect",
      url: `${ADMIN}/proposal/${ID}`,
    });
  });

  it("entity + mobile + Discordbot → the SAME bot bounce as without the flag", () => {
    const withFlag = dispatchOpen({
      type: "entity",
      id: ID,
      userAgent: DISCORDBOT,
      adminBase: ADMIN,
      client: OPEN_CLIENT_MOBILE,
    });
    const withoutFlag = dispatchOpen({
      type: "entity",
      id: ID,
      userAgent: DISCORDBOT,
      adminBase: ADMIN,
    });
    expect(withFlag).toEqual(withoutFlag);
  });

  it("entity/view + mobile + human → bounce (pod-admin is desktop-only)", () => {
    expect(
      dispatchOpen({
        type: "entity",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        client: OPEN_CLIENT_MOBILE,
      })
    ).toEqual({ action: "bounce", deep: `synap://open/entity/${ID}` });
    expect(
      dispatchOpen({
        type: "view",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        client: OPEN_CLIENT_MOBILE,
      })
    ).toEqual({ action: "bounce", deep: `synap://open/view/${ID}` });
  });
});

// ---------------------------------------------------------------------------
// `?view=` forwarding onto the bounce deep link.
// ---------------------------------------------------------------------------

describe("isOpenViewValue", () => {
  it("accepts only the allowlisted value", () => {
    expect(isOpenViewValue("room")).toBe(true);
    expect(isOpenViewValue("evil")).toBe(false);
    expect(isOpenViewValue("")).toBe(false);
    expect(isOpenViewValue(undefined)).toBe(false);
    expect(isOpenViewValue(null)).toBe(false);
  });
});

describe("dispatchOpen — ?view= forwarding", () => {
  it("session + mobile + view=room → bounce carries ?view=room", () => {
    expect(
      dispatchOpen({
        type: "session",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        client: OPEN_CLIENT_MOBILE,
        view: "room",
      })
    ).toEqual({
      action: "bounce",
      deep: `synap://open/session/${ID}?view=room`,
    });
  });

  it("an unrecognised view is DROPPED — same bounce as no view at all", () => {
    const withEvilView = dispatchOpen({
      type: "session",
      id: ID,
      userAgent: HUMAN,
      adminBase: ADMIN,
      client: OPEN_CLIENT_MOBILE,
      view: "evil",
    });
    const withNoView = dispatchOpen({
      type: "session",
      id: ID,
      userAgent: HUMAN,
      adminBase: ADMIN,
      client: OPEN_CLIENT_MOBILE,
    });
    expect(withEvilView).toEqual(withNoView);
    expect(withEvilView).toEqual({
      action: "bounce",
      deep: `synap://open/session/${ID}`,
    });
  });

  it("view is never appended to a pod-admin redirect (desktop entity/view/proposal)", () => {
    expect(
      dispatchOpen({
        type: "entity",
        id: ID,
        userAgent: HUMAN,
        adminBase: ADMIN,
        view: "room",
      })
    ).toEqual({ action: "redirect", url: `${ADMIN}/open/entity/${ID}` });
  });
});
