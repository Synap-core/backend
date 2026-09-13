import { describe, expect, it } from "vitest";

import { externalTargetFor } from "./external-target.js";

describe("externalTargetFor", () => {
  it("google calendar: passes the stored htmlLink through", () => {
    const htmlLink = "https://www.google.com/calendar/event?eid=abc123";
    expect(externalTargetFor("google", htmlLink)).toEqual({ webUrl: htmlLink });
    expect(
      externalTargetFor(
        "google",
        "https://calendar.google.com/calendar/r/eventedit/abc"
      )
    ).toEqual({
      webUrl: "https://calendar.google.com/calendar/r/eventedit/abc",
    });
  });

  it("the target is exactly { webUrl } — one https path, nothing else", () => {
    const t = externalTargetFor(
      "google",
      "https://www.google.com/calendar/event?eid=1"
    );
    expect(t).not.toBeNull();
    expect(Object.keys(t!)).toEqual(["webUrl"]);
  });

  it("gmail and notion: no mapper stores their urls, so none is accepted", () => {
    expect(
      externalTargetFor(
        "google",
        "https://mail.google.com/mail/#all/18c2f0a1b2c3d4e5"
      )
    ).toBeNull();
    expect(
      externalTargetFor(
        "notion",
        "https://www.notion.so/My-page-0123456789abcdef"
      )
    ).toBeNull();
  });

  it("provider matching is case/whitespace tolerant", () => {
    expect(
      externalTargetFor(
        " Google ",
        "https://www.google.com/calendar/event?eid=1"
      )
    ).not.toBeNull();
  });

  describe("returns null — never guesses", () => {
    it("no stored url", () => {
      expect(externalTargetFor("google", undefined)).toBeNull();
      expect(externalTargetFor("google", null)).toBeNull();
      expect(externalTargetFor("google", "  ")).toBeNull();
    });

    it("unknown provider", () => {
      expect(
        externalTargetFor(
          "discord",
          "https://www.google.com/calendar/event?eid=1"
        )
      ).toBeNull();
    });

    it("non-https schemes", () => {
      for (const url of [
        "http://www.google.com/calendar/event?eid=1",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "data:text/html,<script>1</script>",
        "googlegmail:///co?to=a",
      ]) {
        expect(externalTargetFor("google", url)).toBeNull();
      }
    });

    it("an off-provider host (a stored url cannot become a phishing link)", () => {
      for (const url of [
        "https://evil.example/calendar/event?eid=1",
        "https://calendar.google.com.evil.example/",
        "https://www.google.com/search?q=x", // www.google.com only under /calendar/
        "https://www.notion.so/page",
      ]) {
        expect(externalTargetFor("google", url)).toBeNull();
      }
    });

    it("an unparseable url", () => {
      expect(externalTargetFor("google", "not a url")).toBeNull();
    });
  });
});
