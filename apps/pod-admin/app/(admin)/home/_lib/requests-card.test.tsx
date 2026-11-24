import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RequestsCardView, requestsCount } from "./requests-card";

const draw = (
  state: Parameters<typeof RequestsCardView>[0]["state"],
  workLink: React.ReactNode = null
) =>
  renderToStaticMarkup(
    <RequestsCardView state={state} onRetry={() => {}} workLink={workLink} />
  );

describe("requestsCount: the count's three facts, never folded", () => {
  it("is loading until the count arrives", () => {
    expect(requestsCount({ isError: false, data: undefined })).toEqual({
      kind: "loading",
    });
  });

  it("is failed when the read failed, never zero", () => {
    expect(requestsCount({ isError: true, data: undefined })).toEqual({
      kind: "failed",
    });
    // A refetch that failed over an older answer is still a failed read.
    expect(
      requestsCount({ isError: true, data: { needsYou: 0, truncated: false } })
    ).toEqual({ kind: "failed" });
  });

  it("is empty only when the pod answered zero", () => {
    expect(
      requestsCount({ isError: false, data: { needsYou: 0, truncated: false } })
    ).toEqual({ kind: "empty" });
  });

  it("carries the count, and whether it is a floor", () => {
    expect(
      requestsCount({ isError: false, data: { needsYou: 99, truncated: true } })
    ).toEqual({ kind: "waiting", count: 99, floor: true });
  });
});

describe("RequestsCardView", () => {
  it("draws a skeleton while loading, and no sentence", () => {
    const out = draw({ kind: "loading" });
    expect(out).toContain("shimmer-pulse");
    expect(out).not.toContain("Nothing waits for you.");
    expect(out).not.toContain("count the requests");
  });

  it("says a failed count failed, with a retry", () => {
    const out = draw({ kind: "failed" });
    expect(out).toContain("Couldn’t count the requests.");
    expect(out).toContain("Retry");
    expect(out).not.toContain("Nothing waits for you.");
  });

  it("says nothing waits only when the count is zero", () => {
    const out = draw({ kind: "empty" });
    expect(out).toContain("Nothing waits for you.");
    expect(out).not.toContain("count the requests");
  });

  it("leads the count into Review", () => {
    const out = draw({ kind: "waiting", count: 3, floor: false });
    expect(out).toContain('href="/review"');
    expect(out).toContain("See all 3");
    expect(out).not.toContain("Nothing waits for you.");
  });

  it("states what the card is for, and draws the work link only when given", () => {
    expect(draw({ kind: "empty" })).toContain(
      "Approve or refuse what agents want to change."
    );
    expect(draw({ kind: "empty" }, <a href="synap://x">Work</a>)).toContain(
      'href="synap://x"'
    );
    expect(draw({ kind: "empty" })).not.toContain("synap://");
  });
});
