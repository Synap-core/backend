import { describe, expect, it } from "vitest";
import { hostSegments, LONG_LABEL } from "./host-name";

describe("hostSegments: one host style, cut only after a dot", () => {
  it.each([
    "pod.antoinesrvt.synap.live",
    "studio.website-factory-demo.com",
    "localhost:4040",
    "a.b",
  ])("%s: the segments rebuild the host, unchanged and complete", (host) => {
    expect(
      hostSegments(host)
        .map((s) => s.text)
        .join("")
    ).toBe(host);
  });

  it("each segment but the last ends at a dot, so the end is never cut", () => {
    const segs = hostSegments("pod.antoinesrvt.evil.com");
    expect(segs.map((s) => s.text)).toEqual([
      "pod.",
      "antoinesrvt.",
      "evil.",
      "com",
    ]);
  });

  it("keeps a hyphenated label whole; only a label too long for a line may break", () => {
    const segs = hostSegments(
      `studio.website-factory-demo.${"x".repeat(LONG_LABEL)}.com`
    );
    expect(segs[1]).toEqual({ text: "website-factory-demo.", long: false });
    expect(segs[2]!.long).toBe(true);
  });
});
