/**
 * The cell content fingerprint (decision Q9, approval per fingerprint): one
 * sha256 over what the frame runs and may reach. It must CHANGE with each of
 * those (a change nobody approved must read as a different cell) and must NOT
 * change with what does not alter them (key order, host order, a blank or
 * repeated host, `{}` vs no deps), or an honest re-push would read as an
 * unapproved change.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CELL_CONTENT_FINGERPRINT_KEY,
  cellContentFingerprint,
  proposedCellContent,
  stampedCellFingerprint,
  withCellContentFingerprint,
} from "./cell-content-fingerprint.js";

const MODULE = "export default function Cell() { return null; }";
const PAGE = "<title>Report</title>\n<p>hi</p>";
const BASE = {
  rendererType: "frame",
  rendererSource: MODULE,
  deps: null,
  externalHosts: null,
};

describe("cellContentFingerprint", () => {
  it("is the sha256 of the documented canonical form", () => {
    const canonical = JSON.stringify({
      deps: {},
      externalHosts: null,
      rendererSource: MODULE,
      rendererType: "frame",
      v: 1,
    });
    expect(cellContentFingerprint(BASE)).toBe(
      createHash("sha256").update(canonical).digest("hex")
    );
    expect(cellContentFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["the source", BASE, { ...BASE, rendererSource: `${MODULE}\n` }],
    ["the mechanism", BASE, { ...BASE, rendererType: "iframe" }],
    ["the deps", BASE, { ...BASE, deps: { lodash: "4.17.21" } }],
    [
      "a dep's version",
      { ...BASE, deps: { lodash: "4.17.21" } },
      { ...BASE, deps: { lodash: "4.17.20" } },
    ],
    [
      "the egress grant",
      BASE,
      { ...BASE, externalHosts: ["https://api.vendor.com"] },
    ],
  ])("changes with %s", (_label, before, after) => {
    expect(cellContentFingerprint(after)).not.toBe(
      cellContentFingerprint(before)
    );
  });

  it("does not change with what does not change what runs", () => {
    const hosts = cellContentFingerprint({
      ...BASE,
      externalHosts: ["https://b.example", "https://a.example"],
    });
    expect(
      cellContentFingerprint({
        ...BASE,
        externalHosts: [
          " https://a.example",
          "https://b.example",
          "",
          "https://a.example",
        ],
      })
    ).toBe(hosts);
    expect(cellContentFingerprint({ ...BASE, externalHosts: [] })).toBe(
      cellContentFingerprint(BASE)
    );
    expect(cellContentFingerprint({ ...BASE, deps: {} })).toBe(
      cellContentFingerprint(BASE)
    );
    expect(
      cellContentFingerprint({ ...BASE, deps: { b: "1.0.0", a: "2.0.0" } })
    ).toBe(
      cellContentFingerprint({ ...BASE, deps: { a: "2.0.0", b: "1.0.0" } })
    );
  });
});

describe("proposedCellContent — what the cell/define executor materialises", () => {
  it("derives the mechanism from the source when the payload names none", () => {
    expect(proposedCellContent({ rendererSource: PAGE })?.rendererType).toBe(
      "iframe"
    );
    expect(proposedCellContent({ rendererSource: MODULE })?.rendererType).toBe(
      "frame"
    );
  });

  it("keeps a gated mechanism and ignores one a gate may not carry", () => {
    expect(
      proposedCellContent({ rendererSource: MODULE, rendererType: "builtin" })
        ?.rendererType
    ).toBe("builtin");
    expect(
      proposedCellContent({ rendererSource: MODULE, rendererType: "native" })
        ?.rendererType
    ).toBe("frame");
  });

  it("carries no deps and no egress, whatever the payload says", () => {
    const content = proposedCellContent({
      rendererSource: MODULE,
      deps: { lodash: "4.17.21" },
      externalHosts: ["https://evil.example"],
    });
    expect(content).toMatchObject({ deps: null, externalHosts: null });
  });

  it("is null with no source", () => {
    expect(proposedCellContent({ name: "x" })).toBeNull();
    expect(proposedCellContent({ rendererSource: "" })).toBeNull();
  });
});

describe("withCellContentFingerprint", () => {
  it("stamps the fingerprint of the materialised content, on a copy", () => {
    const payload = { name: "x", rendererSource: MODULE };
    const stamped = withCellContentFingerprint(payload);
    expect(stamped[CELL_CONTENT_FINGERPRINT_KEY]).toBe(
      cellContentFingerprint(BASE)
    );
    expect(stampedCellFingerprint(stamped)).toBe(cellContentFingerprint(BASE));
    expect(payload).not.toHaveProperty(CELL_CONTENT_FINGERPRINT_KEY);
  });

  it("overwrites a stamp the caller sent", () => {
    const stamped = withCellContentFingerprint({
      rendererSource: MODULE,
      [CELL_CONTENT_FINGERPRINT_KEY]: "0".repeat(64),
    });
    expect(stampedCellFingerprint(stamped)).toBe(cellContentFingerprint(BASE));
  });

  it("leaves a payload with no source unchanged", () => {
    const payload = { name: "x" };
    expect(withCellContentFingerprint(payload)).toBe(payload);
    expect(stampedCellFingerprint(payload)).toBeNull();
  });
});
