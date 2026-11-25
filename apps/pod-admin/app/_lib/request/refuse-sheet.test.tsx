/**
 * REFUSE, one sheet for every request (founder D2): the reasons fit the kind
 * of request, "Keep it open" closes the sheet without refusing, and the
 * reason the agent reads keeps what the person saw: the picked reason with
 * its hint, then their own words.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveActionLabel } from "@synap-core/types/vocabulary";
import { createT } from "@synap-core/types/i18n";
import { REQUEST_CATALOGS, en as REQUEST_EN } from "./copy";

const t = createT("en", REQUEST_CATALOGS);
import {
  RefuseSheet,
  RefuseTrigger,
  refuseReason,
  type RefuseKind,
} from "./refuse-sheet";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("refuseReason — what the agent reads", () => {
  it("the picked reason with its hint, then the person's words", () => {
    expect(
      refuseReason(
        { label: "Not now", hint: "Ask me again later" },
        "  after the launch  "
      )
    ).toBe("Not now: Ask me again later. after the launch");
  });

  it("only a reason, or only words", () => {
    expect(refuseReason({ label: "Not now", hint: "Later" }, "")).toBe(
      "Not now: Later"
    );
    expect(refuseReason(null, "Too broad")).toBe("Too broad");
  });

  it("nothing picked and nothing typed: no reason at all, never an empty one", () => {
    expect(refuseReason(null, "")).toBeUndefined();
    expect(refuseReason(null, "   ")).toBeUndefined();
  });
});

describe("RefuseSheet — the reasons fit the request", () => {
  const sheet = (kind: RefuseKind) =>
    renderToStaticMarkup(
      <RefuseSheet
        kind={kind}
        busy={false}
        pending={false}
        onRefuse={() => {}}
        onCancel={() => {}}
      />
    );
  /** The radio values, in order. */
  const reasons = (html: string) =>
    [...html.matchAll(/type="radio"[^>]*value="([^"]+)"/g)].map((m) => m[1]);

  it.each([
    ["secret", "refuse.reason.notThisSecret"],
    ["ask", "refuse.reason.notNow"],
    ["proposal", "refuse.reason.notThisChange"],
  ] as const)(
    "%s: its own first reason, then another way, then not for this work",
    (kind, first) => {
      const html = sheet(kind);
      expect(html).toContain(`data-refuse-sheet="${kind}"`);
      expect(reasons(html)).toEqual([
        first,
        "refuse.reason.otherWay",
        "refuse.reason.notThisWork",
      ]);
      // Each reason says what it means (its hint), read from the catalog.
      const seen = text(html);
      expect(seen).toContain(REQUEST_EN[first]);
      expect(seen).toContain(REQUEST_EN[`${first}.hint`]);
    }
  );

  it("a reason fitted to one kind is never offered on another", () => {
    expect(reasons(sheet("ask"))).not.toContain("refuse.reason.notThisSecret");
    expect(reasons(sheet("proposal"))).not.toContain("refuse.reason.notNow");
    expect(reasons(sheet("secret"))).not.toContain(
      "refuse.reason.notThisChange"
    );
  });

  it("Refuse and tell the agent, then Keep it open; what refusing does is said", () => {
    const seen = text(sheet("ask"));
    const confirm = seen.indexOf(t("refuse.confirm", { verb: "refuse" }));
    const keep = seen.indexOf(REQUEST_EN["refuse.cancel"]);
    expect(confirm).toBeGreaterThanOrEqual(0);
    expect(keep).toBeGreaterThan(confirm);
    expect(seen).toContain(t("refuse.reassure", { verb: "refuse" }));
  });

  it("the trigger is the vocabulary's verb for the object, never a module-load English copy", () => {
    const html = renderToStaticMarkup(
      <RefuseTrigger kind="ask" onPress={() => {}} />
    );
    expect(html).toContain("data-refuse-trigger");
    expect(text(html)).toBe(`${resolveActionLabel("refuse", "imperative")}…`);
    expect(
      text(
        renderToStaticMarkup(
          <RefuseTrigger kind="proposal" onPress={() => {}} />
        )
      )
    ).toBe(`${resolveActionLabel("reject", "imperative")}…`);
  });
});
