import { describe, it, expect } from "vitest";
import { parseOnlyArgs, selectManifestOps } from "./select.js";
import { CONVERSION_MANIFEST, type ConversionManifest } from "./manifest.js";

const m: ConversionManifest = {
  version: 7,
  ops: [
    { op: "keep", opKey: "a.first", slug: "note" },
    {
      op: "dedupeProfileRows",
      opKey: "w4.dedupe.knowledge",
      slug: "knowledge",
    },
    { op: "keep", opKey: "c.third", slug: "note" },
  ],
};

describe("parseOnlyArgs", () => {
  it("is null when --only is absent (whole manifest)", () => {
    expect(parseOnlyArgs(["--apply", "--destructive-tail"])).toBeNull();
  });
  it("collects repeats, =form and comma lists", () => {
    expect(
      parseOnlyArgs([
        "--only",
        "c.third",
        "--apply",
        "--only=a.first,w4.dedupe.knowledge",
      ])
    ).toEqual(["c.third", "a.first", "w4.dedupe.knowledge"]);
  });
  it("rejects --only with no value", () => {
    expect(() => parseOnlyArgs(["--only"])).toThrow(/requires an opKey/);
    expect(() => parseOnlyArgs(["--only", "--apply"])).toThrow(
      /requires an opKey/
    );
    expect(() => parseOnlyArgs(["--only="])).toThrow(/requires an opKey/);
  });
});

describe("selectManifestOps", () => {
  it("preserves MANIFEST order, not argv order", () => {
    const out = selectManifestOps(m, ["c.third", "a.first"]);
    expect(out.ops.map((o) => o.opKey)).toEqual(["a.first", "c.third"]);
    expect(out.version).toBe(7);
  });
  it("rejects an unknown key, naming close matches", () => {
    expect(() => selectManifestOps(m, ["w4.dedupe.knowlege"])).toThrow(
      /unknown opKey.*w4\.dedupe\.knowlege.*did you mean: w4\.dedupe\.knowledge/s
    );
    expect(() => selectManifestOps(m, ["a.first", "zzzzzzzz"])).toThrow(
      /'zzzzzzzz' — no close match/
    );
  });
  it("can select every op the live pod reports deferred (keys are real)", () => {
    const pending = [
      "w3c.merge.note-capture-into-item",
      "w4.dedupe.knowledge",
      "w4.dedupe.campaign",
      "w7.merge.crm-lead-into-shared-lead",
      "w7.merge.crm-client-into-shared-client",
      "crm.deal-stage.commercial-fold",
      "crm.person.drive-link-to-client-facet",
    ];
    const out = selectManifestOps(CONVERSION_MANIFEST, pending);
    expect(out.ops).toHaveLength(pending.length);
  });
});
